import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DirtyStepClassifier, type DirtyStep } from './dirty-step-classifier.js';
import type { EntityEntry, ChapterSummary, AICompleteFn, AISelectProviderFn } from './context-engine.js';

describe('DirtyStepClassifier', () => {
  let classifier: DirtyStepClassifier;
  let mockAiComplete: AICompleteFn;
  let mockAiSelectProvider: AISelectProviderFn;

  beforeEach(() => {
    classifier = new DirtyStepClassifier();

    // Mock AI provider selection.
    mockAiSelectProvider = vi.fn(() => ({ id: 'test-provider' }));

    // Mock AI completion to return contradictions.
    mockAiComplete = vi.fn(async () => ({
      text: '{"contradictions":[]}',
      tokensUsed: 100,
      estimatedCost: 0.01,
      provider: 'test-provider',
    }));
  });

  describe('classify', () => {
    it('classifies dirty steps with no contradictions as "none"', async () => {
      const dirtySteps: DirtyStep[] = [
        {
          stepId: 'step-1',
          stepName: 'Chapter 1 Draft',
          oldContent: 'Old chapter 1 content',
          newContent: 'New chapter 1 content (cosmetic fix)',
          downstreamStepIds: ['step-2'],
        },
      ];

      const downstreamContent = new Map([
        ['step-2', 'Chapter 2 content that depends on step 1'],
      ]);

      const entities: EntityEntry[] = [];
      const priorSummaries: ChapterSummary[] = [];

      const report = await classifier.classify(
        'project-1',
        dirtySteps,
        downstreamContent,
        entities,
        priorSummaries,
        mockAiComplete,
        mockAiSelectProvider,
      );

      expect(report.classifications).toHaveLength(1);
      expect(report.classifications[0]!.severity).toBe('none');
      expect(report.summary.none).toBe(1);
      expect(report.summary.high).toBe(0);
      expect(report.summary.low).toBe(0);
    });

    it('classifies dirty steps with contradictions in one downstream step as "low"', async () => {
      const dirtySteps: DirtyStep[] = [
        {
          stepId: 'step-1',
          stepName: 'World-Building Doc',
          oldContent: 'The economy uses gold coins.',
          newContent: 'The economy uses silver coins.', // Substantive change
          downstreamStepIds: ['step-2'],
        },
      ];

      const downstreamContent = new Map([
        ['step-2', 'The merchant paid with gold coins, as always.'], // Will contradict
      ]);

      // Mock AI to return one contradiction.
      mockAiComplete = vi.fn(async () => ({
        text: '{"contradictions":[{"category":"FACTUAL","subtype":"name","severity":"warning","description":"Currency changed","chapterEvidence":"paid with gold coins","priorEvidence":"economy uses silver coins","entity":"currency","suggestion":"Update merchant payment to use silver coins"}]}',
        tokensUsed: 150,
        estimatedCost: 0.015,
        provider: 'test-provider',
      }));

      const entities: EntityEntry[] = [];
      const priorSummaries: ChapterSummary[] = [];

      const report = await classifier.classify(
        'project-1',
        dirtySteps,
        downstreamContent,
        entities,
        priorSummaries,
        mockAiComplete,
        mockAiSelectProvider,
      );

      expect(report.classifications).toHaveLength(1);
      const classification = report.classifications[0]!;
      expect(classification.severity).toBe('low'); // Single affected step
      expect(classification.contradictionCount).toBe(1);
      expect(classification.downstreamImpacts).toHaveLength(1);
      expect(classification.downstreamImpacts[0]!.downstreamStepId).toBe('step-2');
      expect(classification.downstreamImpacts[0]!.contradictionCount).toBe(1);
    });

    it('classifies dirty steps with contradictions in multiple downstream steps as "high"', async () => {
      const dirtySteps: DirtyStep[] = [
        {
          stepId: 'step-1',
          stepName: 'Economic System Doc',
          oldContent: 'Gold-based economy with royal treasury',
          newContent: 'Barter-based economy with no centralized currency', // Major change
          downstreamStepIds: ['step-2', 'step-3'],
        },
      ];

      const downstreamContent = new Map([
        ['step-2', 'The hero deposited gold at the royal treasury.'],
        ['step-3', 'Merchants negotiated using gold prices.'],
      ]);

      // Mock AI to return contradictions for both downstream steps.
      mockAiComplete = vi.fn(async (request) => {
        const chapterText = (request.messages[0]?.content as string) || '';
        const hasDownstreamContext = chapterText.includes('treasury') || chapterText.includes('gold prices');

        if (hasDownstreamContext) {
          return {
            text: '{"contradictions":[{"category":"WORLD_RULE","subtype":"setting","severity":"error","description":"Economy system changed","chapterEvidence":"gold at the royal treasury","priorEvidence":"barter-based economy","entity":"economy","suggestion":"Revise to match new economy"}]}',
            tokensUsed: 200,
            estimatedCost: 0.02,
            provider: 'test-provider',
          };
        }

        return {
          text: '{"contradictions":[]}',
          tokensUsed: 100,
          estimatedCost: 0.01,
          provider: 'test-provider',
        };
      });

      const entities: EntityEntry[] = [];
      const priorSummaries: ChapterSummary[] = [];

      const report = await classifier.classify(
        'project-1',
        dirtySteps,
        downstreamContent,
        entities,
        priorSummaries,
        mockAiComplete,
        mockAiSelectProvider,
      );

      expect(report.classifications).toHaveLength(1);
      const classification = report.classifications[0]!;
      expect(classification.severity).toBe('high'); // Multiple affected steps
      expect(classification.downstreamImpacts.length).toBeGreaterThan(0);
    });

    it('accepts multiple dirty steps and classifies each', async () => {
      const dirtySteps: DirtyStep[] = [
        {
          stepId: 'step-1',
          stepName: 'Character Profile',
          oldContent: 'Alice is 25 years old.',
          newContent: 'Alice is 30 years old.',
          downstreamStepIds: ['step-2'],
        },
        {
          stepId: 'step-3',
          stepName: 'Setting Description',
          oldContent: 'The city is located in the north.',
          newContent: 'The city is located in the south.',
          downstreamStepIds: ['step-4'],
        },
      ];

      const downstreamContent = new Map([
        ['step-2', 'Alice, at 25, reflected on her life.'],
        ['step-4', 'The northern city sparkled in the sunlight.'],
      ]);

      mockAiComplete = vi.fn(async () => ({
        text: '{"contradictions":[]}',
        tokensUsed: 100,
        estimatedCost: 0.01,
        provider: 'test-provider',
      }));

      const entities: EntityEntry[] = [];
      const priorSummaries: ChapterSummary[] = [];

      const report = await classifier.classify(
        'project-1',
        dirtySteps,
        downstreamContent,
        entities,
        priorSummaries,
        mockAiComplete,
        mockAiSelectProvider,
      );

      expect(report.classifications).toHaveLength(2);
      expect(report.totalDirtySteps).toBe(2);
    });

    it('handles downstream steps with missing content gracefully', async () => {
      const dirtySteps: DirtyStep[] = [
        {
          stepId: 'step-1',
          stepName: 'World Doc',
          oldContent: 'Old world',
          newContent: 'New world',
          downstreamStepIds: ['missing-step'], // This step has no content
        },
      ];

      const downstreamContent = new Map(); // Empty

      const entities: EntityEntry[] = [];
      const priorSummaries: ChapterSummary[] = [];

      const report = await classifier.classify(
        'project-1',
        dirtySteps,
        downstreamContent,
        entities,
        priorSummaries,
        mockAiComplete,
        mockAiSelectProvider,
      );

      expect(report.classifications).toHaveLength(1);
      // With no downstream content, no contradictions found → 'none'.
      expect(report.classifications[0]!.severity).toBe('none');
      expect(report.classifications[0]!.downstreamImpacts).toHaveLength(0);
    });
  });

  describe('Acceptance: cosmetic vs substantive changes', () => {
    it('classifies cosmetic doc change as "none"', async () => {
      const dirtySteps: DirtyStep[] = [
        {
          stepId: 'approved-world-doc',
          stepName: 'World-Building Doc',
          oldContent: 'Economy: gold-based system with royal treasury. Detailed description.',
          newContent: 'Economy: gold-based system with royal treasury.   Fixed formatting.',
          downstreamStepIds: ['chapter-5', 'chapter-6'],
        },
      ];

      const downstreamContent = new Map([
        ['chapter-5', 'The merchant traded gold at the market.'],
        ['chapter-6', 'The royal treasury stored the kingdoms wealth.'],
      ]);

      mockAiComplete = vi.fn(async () => ({
        text: '{"contradictions":[]}', // No contradictions for formatting fix
        tokensUsed: 100,
        estimatedCost: 0.01,
        provider: 'test-provider',
      }));

      const entities: EntityEntry[] = [];
      const priorSummaries: ChapterSummary[] = [];

      const report = await classifier.classify(
        'project-1',
        dirtySteps,
        downstreamContent,
        entities,
        priorSummaries,
        mockAiComplete,
        mockAiSelectProvider,
      );

      expect(report.classifications[0]!.severity).toBe('none');
    });

    it('classifies substantive doc change (named economic system) as "high"', async () => {
      const dirtySteps: DirtyStep[] = [
        {
          stepId: 'approved-world-doc',
          stepName: 'World-Building Doc',
          oldContent: 'Economy: gold-based system',
          newContent: 'Economy: silver-based system with different values',
          downstreamStepIds: ['chapter-5', 'chapter-6'],
        },
      ];

      const downstreamContent = new Map([
        ['chapter-5', 'The merchant traded gold at the market.'],
        ['chapter-6', 'The royal treasury counted gold coins.'],
      ]);

      mockAiComplete = vi.fn(async () => ({
        text: '{"contradictions":[{"category":"FACTUAL","subtype":"name","severity":"error","description":"Currency system changed","chapterEvidence":"gold","priorEvidence":"silver","entity":"currency","suggestion":"Update chapter to use silver"}]}',
        tokensUsed: 150,
        estimatedCost: 0.015,
        provider: 'test-provider',
      }));

      const entities: EntityEntry[] = [];
      const priorSummaries: ChapterSummary[] = [];

      const report = await classifier.classify(
        'project-1',
        dirtySteps,
        downstreamContent,
        entities,
        priorSummaries,
        mockAiComplete,
        mockAiSelectProvider,
      );

      expect(report.classifications[0]!.severity).toBe('high');
      expect(report.classifications[0]!.contradictionCount).toBeGreaterThan(0);
    });
  });
});
