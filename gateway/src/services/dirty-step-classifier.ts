/**
 * Dirty-step severity classification.
 *
 * This is intentionally an integration layer: dependency-graph.ts decides
 * which completed steps are dirty, ContextEngine owns the persisted entity
 * index, and ContradictionDetector supplies evidence-chained consistency
 * findings. No second entity extractor or parallel continuity model lives
 * here.
 */

import type { ContradictionDetector, ContradictionReport } from './contradiction-detector.js';
import type {
  AICompleteFn,
  AISelectProviderFn,
  ContextEngine,
  ProjectContext,
} from './context-engine.js';
import type { ProjectStep } from './project-templates.js';

export type DirtyStepSeverity = 'high' | 'low' | 'none';

export interface ClassifyDirtyStepsInput {
  projectId: string;
  steps: ProjectStep[];
  causeStepId: string;
  previousCauseContent: string;
  currentCauseContent: string;
}

export interface DirtyStepClassification {
  stepId: string;
  severity: DirtyStepSeverity;
  contradictionCount: number;
}

function normalizeCosmeticContent(content: string): string {
  return content
    .normalize('NFKC')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase();
}

export function isCosmeticChange(previousContent: string, currentContent: string): boolean {
  return normalizeCosmeticContent(previousContent) === normalizeCosmeticContent(currentContent);
}

export function severityFromReport(report: ContradictionReport): DirtyStepSeverity {
  if (report.bySeverity.error > 0) return 'high';
  if (report.bySeverity.warning > 0 || report.bySeverity.info > 0) return 'low';
  return 'none';
}

export class DirtyStepClassifier {
  constructor(
    private readonly contextEngine: Pick<ContextEngine, 'loadContext'>,
    private readonly detector: Pick<ContradictionDetector, 'detect'>,
    private readonly aiComplete: AICompleteFn,
    private readonly aiSelectProvider: AISelectProviderFn,
  ) {}

  /**
   * Classify all downstream steps whose dirty marker points to the changed source.
   * Cosmetic source changes are resolved without loading context or calling AI.
   */
  async classify(input: ClassifyDirtyStepsInput): Promise<DirtyStepClassification[]> {
    const dirtySteps = input.steps.filter(
      (step) => step.dirty?.causeStepId === input.causeStepId,
    );
    if (dirtySteps.length === 0) return [];

    if (isCosmeticChange(input.previousCauseContent, input.currentCauseContent)) {
      return dirtySteps.map((step) => this.apply(step, 'none', 0));
    }

    const context = await this.contextEngine.loadContext(input.projectId);
    return Promise.all(dirtySteps.map((step) => this.classifyStep(input.projectId, step, context)));
  }

  private async classifyStep(
    projectId: string,
    step: ProjectStep,
    context: ProjectContext,
  ): Promise<DirtyStepClassification> {
    if (!step.result?.trim()) return this.apply(step, 'none', 0);

    const report = await this.detector.detect(
      {
        projectId,
        chapterId: step.id,
        chapterText: step.result,
        entities: context.entities,
        priorSummaries: context.summaries,
      },
      this.aiComplete,
      this.aiSelectProvider,
    );
    return this.apply(step, severityFromReport(report), report.total);
  }

  private apply(
    step: ProjectStep,
    severity: DirtyStepSeverity,
    contradictionCount: number,
  ): DirtyStepClassification {
    if (step.dirty) step.dirty.severity = severity;
    return { stepId: step.id, severity, contradictionCount };
  }
}
