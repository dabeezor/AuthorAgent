import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemorySearchService } from './memory-search.js';

describe('MemorySearchService — note indexing', () => {
  let workspaceDir: string;
  let search: MemorySearchService;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'authoragent-memory-search-notes-'));
    search = new MemorySearchService(workspaceDir);
    await search.initialize();
  });

  afterEach(async () => {
    search.close();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('indexNote() makes a note immediately searchable, tagged source: note', () => {
    if (!search.isAvailable()) return; // graceful-degradation environment — nothing to test
    search.indexNote({
      id: 'note-1',
      text: 'the aunt should know about the letter before ch.9',
      timestamp: new Date().toISOString(),
      personaId: null,
      projectId: 'proj-1',
    });
    const hits = search.search('letter', { source: 'note' });
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('note');
    expect(hits[0].projectId).toBe('proj-1');
  });

  it('filters notes out of a plain conversation search and vice versa', () => {
    if (!search.isAvailable()) return;
    search.indexConversationTurn({ user: 'dragon question', assistant: 'dragon answer', timestamp: new Date().toISOString() });
    search.indexNote({ id: 'note-2', text: 'dragon should breathe blue fire', timestamp: new Date().toISOString(), personaId: null, projectId: null });

    const noteHits = search.search('dragon', { source: 'note' });
    expect(noteHits).toHaveLength(1);
    expect(noteHits[0].source).toBe('note');

    const convoHits = search.search('dragon', { source: 'conversation' });
    expect(convoHits).toHaveLength(1);
    expect(convoHits[0].source).toBe('conversation');
  });

  it('reindexAll() picks up notes appended directly to memory/notes.jsonl', async () => {
    if (!search.isAvailable()) return;
    const memoryDir = join(workspaceDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    const entry = JSON.stringify({
      id: 'note-3',
      timestamp: new Date().toISOString(),
      text: 'plot idea recovered from disk',
      personaId: null,
      projectId: null,
    }) + '\n';
    await appendFile(join(memoryDir, 'notes.jsonl'), entry);

    const result = await search.reindexAll();
    expect(result.indexed).toBeGreaterThanOrEqual(1);

    const hits = search.search('recovered', { source: 'note' });
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceRef).toBe('notes.jsonl#note-3');
  });

  it('reindexAll() without force: true picks up new notes on a second pass and skips unchanged ones on a third', async () => {
    if (!search.isAvailable()) return;
    const memoryDir = join(workspaceDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    const notesPath = join(memoryDir, 'notes.jsonl');

    // First pass: nothing on disk yet.
    const first = await search.reindexAll();
    expect(search.search('alpha', { source: 'note' })).toHaveLength(0);

    // Append a note, then reindex WITHOUT force — must not rely on force to pick it up.
    await appendFile(notesPath, JSON.stringify({
      id: 'note-5', timestamp: new Date().toISOString(), text: 'alpha idea', personaId: null, projectId: null,
    }) + '\n');
    const second = await search.reindexAll();
    expect(second.indexed).toBeGreaterThanOrEqual(1);
    expect(search.search('alpha', { source: 'note' })).toHaveLength(1);

    // Third pass with no new append — the notes.jsonl file itself is unchanged,
    // so this must skip it rather than re-scanning forever.
    const third = await search.reindexAll();
    expect(third.skipped).toBeGreaterThanOrEqual(1);
    // Still exactly one hit — proves the unchanged pass didn't duplicate anything either.
    expect(search.search('alpha', { source: 'note' })).toHaveLength(1);
  });

  it('reindexAll() is idempotent on repeated notes.jsonl lines (upsert by sourceRef)', async () => {
    if (!search.isAvailable()) return;
    const memoryDir = join(workspaceDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    const entry = JSON.stringify({
      id: 'note-4',
      timestamp: new Date().toISOString(),
      text: 'idempotent note',
      personaId: null,
      projectId: null,
    }) + '\n';
    await appendFile(join(memoryDir, 'notes.jsonl'), entry);

    await search.reindexAll({ force: true });
    await search.reindexAll({ force: true });

    const hits = search.search('idempotent', { source: 'note' });
    expect(hits).toHaveLength(1);
  });
});
