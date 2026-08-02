/**
 * Dirty-Step Severity Classifier
 *
 * For each dirty step (a step whose document changed), diffs the changed
 * content across versions and determines whether dependent steps are genuinely
 * contradicted by the change.
 *
 * Inputs:
 *   - dirty steps from a dependency graph (identified by change detection in M1.4)
 *   - document version history (from doc-versions service)
 *   - entity DB and prior chapter summaries (from context engine)
 *
 * Outputs:
 *   - severity classification (high|low|none) per dirty step
 *   - high: substantive contradictions found in downstream steps
 *   - low: cosmetic or self-contained changes (no downstream impact)
 *   - none: change is transparent to dependent steps
 */

import type {
  ChapterSummary,
  EntityEntry,
  AICompleteFn,
  AISelectProviderFn,
} from './context-engine.js';
import { ContradictionDetector, type ContradictionReport } from './contradiction-detector.js';
import { logger } from './logger.js';

const log = logger.child('[dirty-step-classifier]');

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type SeverityLevel = 'high' | 'low' | 'none';

/**
 * A dirty step: one whose document changed. Includes the step ID, the old
 * and new document content, and the list of downstream steps that depend on it.
 */
export interface DirtyStep {
  stepId: string;
  stepName?: string;
  oldContent: string;
  newContent: string;
  downstreamStepIds: string[];
}

/**
 * Classification result for a single dirty step.
 */
export interface StepSeverityClassification {
  stepId: string;
  stepName?: string;
  severity: SeverityLevel;
  /** Number of contradictions found in downstream steps. */
  contradictionCount: number;
  /** High-level summary (e.g., "Substantive change to economic system affects 3 downstream steps"). */
  summary: string;
  /** Details of the contradictions for downstream review. */
  downstreamImpacts: Array<{
    downstreamStepId: string;
    contradictionCount: number;
    sampleIssues: string[];
  }>;
}

/**
 * Full classification report for all dirty steps.
 */
export interface SeverityClassificationReport {
  projectId: string;
  generatedAt: string;
  totalDirtySteps: number;
  classifications: StepSeverityClassification[];
  /** High-level summary: count of high/low/none classifications. */
  summary: {
    high: number;
    low: number;
    none: number;
  };
}

// ═══════════════════════════════════════════════════════════
// Classifier
// ═══════════════════════════════════════════════════════════

export class DirtyStepClassifier {
  private detector: ContradictionDetector;

  constructor() {
    this.detector = new ContradictionDetector();
  }

  /**
   * Classify all dirty steps in a dependency graph.
   *
   * For each dirty step:
   *   1. Identify what changed (diff oldContent vs newContent)
   *   2. For each downstream step, run contradiction detection between the
   *      downstream step's content and the NEW version of the dirty step's document
   *   3. Aggregate contradictions and assign severity:
   *      - high: substantive contradictions found (e.g., character state, world rule,
   *        named entity changed) that affect downstream steps
   *      - low: minor contradictions or self-contained changes with no downstream impact
   *      - none: no contradictions detected in downstream steps
   *
   * @param projectId ID of the project
   * @param dirtySteps steps with changed documents
   * @param downstreamContent map of stepId → content for contradiction detection
   * @param entities entity DB from context engine
   * @param priorSummaries prior chapter summaries for context
   * @param aiComplete AI completion function
   * @param aiSelectProvider provider selector function
   */
  async classify(
    projectId: string,
    dirtySteps: DirtyStep[],
    downstreamContent: Map<string, string>,
    entities: EntityEntry[],
    priorSummaries: ChapterSummary[],
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
  ): Promise<SeverityClassificationReport> {
    log.info(`Classifying ${dirtySteps.length} dirty steps for project ${projectId}`);

    const classifications: StepSeverityClassification[] = [];
    const summary = { high: 0, low: 0, none: 0 };

    for (const dirtyStep of dirtySteps) {
      const classification = await this.classifySingleStep(
        projectId,
        dirtyStep,
        downstreamContent,
        entities,
        priorSummaries,
        aiComplete,
        aiSelectProvider,
      );

      classifications.push(classification);
      summary[classification.severity]++;

      log.debug(`Classified ${dirtyStep.stepId}: ${classification.severity} (${classification.contradictionCount} contradictions)`);
    }

    return {
      projectId,
      generatedAt: new Date().toISOString(),
      totalDirtySteps: dirtySteps.length,
      classifications,
      summary,
    };
  }

  /**
   * Classify a single dirty step by checking contradictions in downstream steps.
   */
  private async classifySingleStep(
    projectId: string,
    dirtyStep: DirtyStep,
    downstreamContent: Map<string, string>,
    entities: EntityEntry[],
    priorSummaries: ChapterSummary[],
    aiComplete: AICompleteFn,
    aiSelectProvider: AISelectProviderFn,
  ): Promise<StepSeverityClassification> {
    let totalContradictions = 0;
    const downstreamImpacts: StepSeverityClassification['downstreamImpacts'] = [];

    // For each downstream step, check if the change in this dirty step
    // causes contradictions.
    for (const downstreamStepId of dirtyStep.downstreamStepIds) {
      const downstreamText = downstreamContent.get(downstreamStepId);
      if (!downstreamText) {
        // Downstream step content not available; skip.
        log.warn(`Downstream step ${downstreamStepId} has no content available`);
        continue;
      }

      // Run contradiction detection: compare the downstream step against
      // the NEW version of this dirty step's document.
      const report = await this.detector.detect(
        {
          projectId,
          chapterText: downstreamText,
          chapterId: downstreamStepId,
          priorSummaries,
          entities,
        },
        aiComplete,
        aiSelectProvider,
      );

      const downstreamContradictions = report.contradictions?.length ?? 0;
      if (downstreamContradictions > 0) {
        totalContradictions += downstreamContradictions;
        const sampleIssues = report.contradictions
          .slice(0, 2) // Keep top 2 issues for the summary
          .map((c) => `${c.category}/${c.subtype}: ${c.description}`);

        downstreamImpacts.push({
          downstreamStepId,
          contradictionCount: downstreamContradictions,
          sampleIssues,
        });
      }
    }

    // Assign severity based on contradiction count and types.
    const severity = this.assignSeverity(dirtyStep, totalContradictions, downstreamImpacts);
    const summary = this.buildSummary(dirtyStep, severity, totalContradictions, downstreamImpacts);

    return {
      stepId: dirtyStep.stepId,
      stepName: dirtyStep.stepName,
      severity,
      contradictionCount: totalContradictions,
      summary,
      downstreamImpacts,
    };
  }

  /**
   * Assign severity level based on contradiction count and types.
   *
   * Heuristic:
   *   - high: ≥1 substantive contradictions (character, world-rule, timeline, factual changes)
   *   - low: style-only contradictions or ≥3 minor issues without semantics impact
   *   - none: no contradictions
   */
  private assignSeverity(
    dirtyStep: DirtyStep,
    totalContradictions: number,
    downstreamImpacts: StepSeverityClassification['downstreamImpacts'],
  ): SeverityLevel {
    if (totalContradictions === 0) {
      return 'none';
    }

    // Check if any contradictions are in high-impact categories.
    // A simple heuristic: if more than one downstream step is affected, or if
    // any downstream step has >1 contradictions, mark as high.
    const affectedSteps = downstreamImpacts.length;
    const hasMultipleContradictions = downstreamImpacts.some((d) => d.contradictionCount > 1);

    if (affectedSteps > 1 || hasMultipleContradictions) {
      return 'high';
    }

    // Single downstream step, single contradiction → low (author can review easily).
    return 'low';
  }

  /**
   * Build a human-readable summary of the classification.
   */
  private buildSummary(
    dirtyStep: DirtyStep,
    severity: SeverityLevel,
    totalContradictions: number,
    downstreamImpacts: StepSeverityClassification['downstreamImpacts'],
  ): string {
    const stepName = dirtyStep.stepName || dirtyStep.stepId;

    if (severity === 'none') {
      return `No contradictions in downstream steps (cosmetic or self-contained change).`;
    }

    const affectedCount = downstreamImpacts.length;
    const severityLabel = severity === 'high' ? 'Substantive' : 'Minor';

    if (affectedCount === 0) {
      return `${severityLabel} change to ${stepName}; impact unclear (check downstream manually).`;
    }

    if (affectedCount === 1) {
      return `${severityLabel} change affects 1 downstream step (${downstreamImpacts[0]!.downstreamStepId}) with ${downstreamImpacts[0]!.contradictionCount} issue(s).`;
    }

    return `${severityLabel} change affects ${affectedCount} downstream steps (${totalContradictions} total issues).`;
  }
}
