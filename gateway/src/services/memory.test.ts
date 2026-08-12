import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService } from './memory.js';

// getRelevant() had zero test coverage despite being a section of the
// system prompt that was, until this fix, entirely unbounded (up to
// 10 files x 5,000 chars = 50,000 chars) and excluded from
// message-pipeline's total-budget trim list — see the same-commit fix in
// message-pipeline.ts (added 'memories' to applyTotalBudgetGuard's trim
// order) and loader.ts (raised skill budget now that this is bounded).

describe('MemoryService.getRelevant — relevant-memory budget', () => {
  let memoryDir: string;
  let memory: MemoryService;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'authoragent-memory-test-'));
    memory = new MemoryService(memoryDir, {});
    await memory.initialize();
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  async function writeBibleFile(projectId: string, name: string, content: string) {
    const dir = join(memoryDir, 'book-bible', projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content, 'utf-8');
  }

  it('returns empty string when no project is active', async () => {
    expect(await memory.getRelevant('anything')).toBe('');
  });

  it('caps a single file excerpt at 5,000 chars, as before', async () => {
    await memory.setActiveProject('proj-1');
    await writeBibleFile('proj-1', 'character-alice.md', 'alice content '.repeat(1000)); // ~14,000 chars
    const result = await memory.getRelevant('alice');
    expect(result.length).toBeLessThanOrEqual(5_000 + 50); // + header overhead
  });

  it('caps the TOTAL accumulated block at 8,000 chars, even with many large matching files', async () => {
    // Previously unbounded: 10 files x 5,000 chars = up to 50,000 chars total.
    for (let i = 0; i < 10; i++) {
      await writeBibleFile('proj-1', `entry-${i}.md`, `keyword content ${i} `.repeat(500)); // ~11,000 chars each
    }
    await memory.setActiveProject('proj-1');
    const result = await memory.getRelevant('keyword');
    expect(result.length).toBeLessThanOrEqual(8_000 + 300); // + header overhead across entries
  }, 30000);

  it('keeps the highest-relevance-scored entries and drops the low-relevance tail when over budget', async () => {
    await memory.setActiveProject('proj-1');
    // Two high-relevance files (filename AND content match), each large
    // enough to hit the 5,000-char per-file cap — together they exhaust the
    // whole 8,000 budget on their own before the loop (in score order) ever
    // reaches the zero-relevance file below.
    await writeBibleFile('proj-1', 'dragon-lore.md', 'dragon dragon dragon '.repeat(600)); // ~13,200 chars, capped at 5,000
    await writeBibleFile('proj-1', 'dragon-history.md', 'dragon backstory '.repeat(600)); // ~10,200 chars, capped at 5,000
    // Zero-relevance: no keyword match at all — should be dropped once the
    // two files above have already spent the full budget.
    await writeBibleFile('proj-1', 'unrelated-notes.md', 'z'.repeat(1000));
    const result = await memory.getRelevant('dragon');
    expect(result).toContain('dragon-lore.md');
    expect(result).toContain('dragon-history.md');
    expect(result).not.toContain('unrelated-notes.md');
  });

  it('does not truncate when the total is already under budget', async () => {
    await memory.setActiveProject('proj-1');
    await writeBibleFile('proj-1', 'short.md', 'a short bible entry about the plot');
    const result = await memory.getRelevant('plot');
    expect(result).toContain('a short bible entry about the plot');
    expect(result).not.toContain('[truncated]'); // getRelevant doesn't mark truncation explicitly, but the full string should survive
  });
});

describe('MemoryService.addNote — freeform story-note capture', () => {
  let memoryDir: string;
  let memory: MemoryService;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'authoragent-memory-notes-test-'));
    memory = new MemoryService(memoryDir, {});
    await memory.initialize();
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  async function readNotesFile(): Promise<any[]> {
    const { readFile } = await import('fs/promises');
    const raw = await readFile(join(memoryDir, 'notes.jsonl'), 'utf-8');
    return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('appends a note to memory/notes.jsonl and returns its id + timestamp', async () => {
    const { id, timestamp } = await memory.addNote('the aunt should know about the letter before ch.9');
    expect(id).toMatch(/^note-/);
    expect(timestamp).toBeTruthy();

    const notes = await readNotesFile();
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(id);
    expect(notes[0].text).toBe('the aunt should know about the letter before ch.9');
  });

  it('appends multiple notes without clobbering earlier ones', async () => {
    await memory.addNote('first idea');
    await memory.addNote('second idea');
    const notes = await readNotesFile();
    expect(notes).toHaveLength(2);
    expect(notes.map(n => n.text)).toEqual(['first idea', 'second idea']);
  });

  it('truncates to 5,000 characters, same cap as conversation turns', async () => {
    await memory.addNote('x'.repeat(6000));
    const notes = await readNotesFile();
    expect(notes[0].text.length).toBe(5000);
  });

  it('tags the note with the currently-active persona/project by default', async () => {
    await memory.setActiveProject('proj-1');
    await memory.setActivePersona('persona-a');
    await memory.addNote('tagged note');
    const notes = await readNotesFile();
    expect(notes[0].projectId).toBe('proj-1');
    expect(notes[0].personaId).toBe('persona-a');
  });

  it('lets the caller override persona/project context explicitly', async () => {
    await memory.setActiveProject('proj-1');
    await memory.addNote('override note', { personaId: null, projectId: 'proj-2' });
    const notes = await readNotesFile();
    expect(notes[0].projectId).toBe('proj-2');
    expect(notes[0].personaId).toBeNull();
  });

  it('calls the note live-index hook with the same data written to disk', async () => {
    const hook = vi.fn();
    memory.setNoteIndexHook(hook);
    const { id, timestamp } = await memory.addNote('hooked note');
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ id, timestamp, text: 'hooked note' }));
  });

  it('does not throw if no index hook is registered', async () => {
    await expect(memory.addNote('no hook registered')).resolves.toBeTruthy();
  });

  it('still writes the note to disk even if the index hook throws', async () => {
    memory.setNoteIndexHook(() => { throw new Error('boom — search index unavailable'); });
    await expect(memory.addNote('survives a bad hook')).resolves.toBeTruthy();
    const notes = await readNotesFile();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('survives a bad hook');
  });
});
