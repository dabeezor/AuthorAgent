import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AutoPatchService } from './auto-patches.js';
import { docVersionService } from './doc-versions.js';

describe('AutoPatchService', () => {
  const dirs: string[] = [];
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'auto-patches-')); dirs.push(dir);
    await docVersionService.appendVersion(dir, 'chapter', 'old text', 'agent');
    return dir;
  }
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

  it('never changes content until a proposal is accepted', async () => {
    const dir = await setup(); const service = new AutoPatchService();
    const proposal = await service.propose(dir, 'chapter', async () => 'patched text');
    expect(await docVersionService.getCurrentVersion(dir, 'chapter')).toBe(1);
    const result = await service.accept(dir, 'chapter', proposal.id);
    expect(result).toMatchObject({ kind: 'accepted', version: 2 });
    expect((await docVersionService.getVersions(dir, 'chapter')).at(-1)?.author).toBe('agent-patch');
  });

  it('rejects without creating a version', async () => {
    const dir = await setup(); const service = new AutoPatchService();
    const proposal = await service.propose(dir, 'chapter', async () => 'patched text');
    await service.reject(dir, 'chapter', proposal.id);
    expect(await docVersionService.getCurrentVersion(dir, 'chapter')).toBe(1);
  });

  it('detects a changed parent instead of applying stale content', async () => {
    const dir = await setup(); const service = new AutoPatchService();
    const proposal = await service.propose(dir, 'chapter', async () => 'stale patch');
    await docVersionService.appendVersion(dir, 'chapter', 'new parent', 'user');
    expect(await service.accept(dir, 'chapter', proposal.id)).toMatchObject({ kind: 'stale' });
    expect(await docVersionService.getCurrentVersion(dir, 'chapter')).toBe(2);
  });

  it('accepts hand-edited proposal content', async () => {
    const dir = await setup(); const service = new AutoPatchService();
    const proposal = await service.propose(dir, 'chapter', async () => 'suggestion');
    await service.accept(dir, 'chapter', proposal.id, 'human edit');
    expect(await docVersionService.getVersionContent(dir, 'chapter', 2)).toBe('human edit');
  });

  it('stores reviewable hunk boundaries and recomputes a stale proposal', async () => {
    const dir = await setup(); const service = new AutoPatchService();
    const proposal = await service.propose(dir, 'chapter', async () => 'old text\nnew line');
    expect(proposal.hunks).toEqual([{ oldStart: 2, oldLines: [], newStart: 2, newLines: ['new line'] }]);

    await docVersionService.appendVersion(dir, 'chapter', 'new parent', 'user');
    const result = await service.accept(dir, 'chapter', proposal.id, undefined, async (parent) => `${parent}\nrecomputed`);
    expect(result).toMatchObject({ kind: 'stale', recomputed: true });
    if (result.kind === 'stale') {
      expect(result.proposal.parentV).toBe(2);
      expect(result.proposal.proposedContent).toBe('new parent\nrecomputed');
    }
    expect(await docVersionService.getCurrentVersion(dir, 'chapter')).toBe(2);
  });
});
