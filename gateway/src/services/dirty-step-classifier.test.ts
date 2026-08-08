import { describe, expect, it, vi } from 'vitest';
import {
  DirtyStepClassifier,
  isCosmeticChange,
  severityFromReport,
} from './dirty-step-classifier.js';
import type { ContradictionReport } from './contradiction-detector.js';
import type { ProjectStep } from './project-templates.js';

function dirtyStep(id: string, result: string): ProjectStep {
  return {
    id,
    label: id,
    taskType: 'writing',
    prompt: '',
    status: 'completed',
    result,
    dirty: {
      causeStepId: 'world',
      causeVersionFrom: 1,
      causeVersionTo: 2,
      markedAt: '2026-08-08T00:00:00.000Z',
    },
  };
}

function report(severity?: 'error' | 'warning' | 'info'): ContradictionReport {
  return {
    projectId: 'novel',
    generatedAt: '2026-08-08T00:00:00.000Z',
    total: severity ? 1 : 0,
    byCategory: severity ? { WORLD_RULE: 1 } : {},
    bySeverity: {
      error: severity === 'error' ? 1 : 0,
      warning: severity === 'warning' ? 1 : 0,
      info: severity === 'info' ? 1 : 0,
    },
    contradictions: [],
  };
}

describe('dirty-step severity classification', () => {
  it('recognizes formatting, punctuation, and whitespace-only edits as cosmetic', () => {
    expect(isCosmeticChange('# The Guild\n\nUses a barter economy.', 'The Guild uses a barter economy!')).toBe(true);
    expect(isCosmeticChange('Uses a barter economy.', 'Uses a credit economy.')).toBe(false);
  });

  it('maps definite contradictions high, review findings low, and no findings none', () => {
    expect(severityFromReport(report('error'))).toBe('high');
    expect(severityFromReport(report('warning'))).toBe('low');
    expect(severityFromReport(report('info'))).toBe('low');
    expect(severityFromReport(report())).toBe('none');
  });

  it('classifies cosmetic world-building edits as none without spending an AI call', async () => {
    const step = dirtyStep('chapter-1', 'The merchants pay in crowns.');
    const detector = { detect: vi.fn() };
    const classifier = new DirtyStepClassifier(
      { loadContext: vi.fn() },
      detector,
      vi.fn(),
      vi.fn(),
    );

    const result = await classifier.classify({
      projectId: 'novel',
      steps: [step],
      causeStepId: 'world',
      previousCauseContent: '# Economy\nThe realm uses crowns.',
      currentCauseContent: 'Economy: the realm uses crowns!',
    });

    expect(result).toEqual([{ stepId: 'chapter-1', severity: 'none', contradictionCount: 0 }]);
    expect(step.dirty?.severity).toBe('none');
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it('E2E: uses the existing entity DB and detector to mark a referenced economic-system contradiction high', async () => {
    const chapter = dirtyStep('chapter-7', 'Mara paid the ferryman with three silver crowns.');
    const entities = [{
      name: 'Aster Economy',
      type: 'rule' as const,
      aliases: [],
      description: 'Trade uses ledger credits; physical currency is forbidden.',
      firstAppearance: 'world',
      lastSeen: 'world',
      attributes: { economicSystem: 'ledger credits only' },
      changes: [{ chapterId: 'world', description: 'Changed from silver crowns to ledger credits.' }],
    }];
    const contextEngine = {
      loadContext: vi.fn().mockResolvedValue({ projectId: 'novel', entities, summaries: [], updatedAt: '' }),
    };
    const detector = {
      detect: vi.fn().mockResolvedValue(report('error')),
    };
    const classifier = new DirtyStepClassifier(contextEngine, detector, vi.fn(), vi.fn());

    const result = await classifier.classify({
      projectId: 'novel',
      steps: [chapter],
      causeStepId: 'world',
      previousCauseContent: 'The realm uses silver crowns.',
      currentCauseContent: 'The realm uses ledger credits; coins are forbidden.',
    });

    expect(result[0]).toEqual({ stepId: 'chapter-7', severity: 'high', contradictionCount: 1 });
    expect(chapter.dirty?.severity).toBe('high');
    expect(detector.detect).toHaveBeenCalledWith(
      expect.objectContaining({ chapterId: 'chapter-7', chapterText: chapter.result, entities }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
