import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { docVersionService } from './doc-versions.js';

export interface PatchProposal {
  id: string;
  stepId: string;
  parentV: number;
  parentSha256: string;
  proposedContent: string;
  hunks: PatchHunk[];
  instructions?: string;
  mode?: 'patch' | 'regenerate';
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
}

export interface PatchHunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
}

export type PatchGenerator = (parentContent: string) => Promise<string>;

type DiffOp = { op: 'equal' | 'add' | 'remove'; line: string };

function diffLines(fromText: string, toText: string): DiffOp[] {
  const from = fromText.split('\n');
  const to = toText.split('\n');
  const lcs: number[][] = Array.from({ length: from.length + 1 }, () => new Array(to.length + 1).fill(0));
  for (let i = from.length - 1; i >= 0; i--) {
    for (let j = to.length - 1; j >= 0; j--) {
      lcs[i][j] = from[i] === to[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) { ops.push({ op: 'equal', line: from[i++] }); j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: 'remove', line: from[i++] });
    else ops.push({ op: 'add', line: to[j++] });
  }
  while (i < from.length) ops.push({ op: 'remove', line: from[i++] });
  while (j < to.length) ops.push({ op: 'add', line: to[j++] });
  return ops;
}

/** Group adjacent changed lines into hunks for the review surface. */
export function computePatchHunks(fromText: string, toText: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: PatchHunk | null = null;
  for (const op of diffLines(fromText, toText)) {
    if (op.op === 'equal') {
      if (current) { hunks.push(current); current = null; }
      oldLine++; newLine++;
      continue;
    }
    if (!current) current = { oldStart: oldLine, oldLines: [], newStart: newLine, newLines: [] };
    if (op.op === 'remove') { current.oldLines.push(op.line); oldLine++; }
    else { current.newLines.push(op.line); newLine++; }
  }
  if (current) hunks.push(current);
  return hunks;
}

export class AutoPatchService {
  private path(projectDir: string, stepId: string) {
    return join(projectDir, '.patches', `${stepId}.json`);
  }

  async propose(projectDir: string, stepId: string, generate: PatchGenerator, metadata: { instructions?: string; mode?: 'patch' | 'regenerate' } = {}): Promise<PatchProposal> {
    const versions = await docVersionService.getVersions(projectDir, stepId);
    const parent = versions.at(-1);
    if (!parent) throw new Error('Document has no version to patch');
    const parentContent = await docVersionService.getVersionContent(projectDir, stepId, parent.v);
    if (parentContent === null) throw new Error(`Parent version v${parent.v} is missing`);
    const proposedContent = await generate(parentContent);
    if (!proposedContent.trim()) throw new Error('Patch generator returned empty content');
    const hunks = computePatchHunks(parentContent, proposedContent);
    if (hunks.length === 0) throw new Error('Patch generator returned no changes');
    const proposal: PatchProposal = {
      id: randomUUID(), stepId, parentV: parent.v, parentSha256: parent.sha256,
      proposedContent, hunks, ...metadata, createdAt: Date.now(), status: 'pending',
    };
    const proposals = await this.list(projectDir, stepId);
    proposals.push(proposal);
    await this.write(projectDir, stepId, proposals);
    return proposal;
  }

  async list(projectDir: string, stepId: string): Promise<PatchProposal[]> {
    const path = this.path(projectDir, stepId);
    if (!existsSync(path)) return [];
    try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return []; }
  }

  async reject(projectDir: string, stepId: string, id: string): Promise<PatchProposal | null> {
    const proposals = await this.list(projectDir, stepId);
    const proposal = proposals.find((item) => item.id === id);
    if (!proposal) return null;
    proposal.status = 'rejected';
    await this.write(projectDir, stepId, proposals);
    return proposal;
  }

  async accept(projectDir: string, stepId: string, id: string, editedContent?: string, recompute?: PatchGenerator): Promise<
    | { kind: 'accepted'; version: number; content: string }
    | { kind: 'stale'; proposal: PatchProposal; recomputed: boolean }
    | { kind: 'missing' }
  > {
    const proposals = await this.list(projectDir, stepId);
    const proposal = proposals.find((item) => item.id === id && item.status === 'pending');
    if (!proposal) return { kind: 'missing' };
    const currentV = await docVersionService.getCurrentVersion(projectDir, stepId);
    const current = currentV > 0 ? (await docVersionService.getVersions(projectDir, stepId)).at(-1) : undefined;
    if (currentV !== proposal.parentV || current?.sha256 !== proposal.parentSha256) {
      if (recompute) {
        proposal.status = 'superseded';
        await this.write(projectDir, stepId, proposals);
        return { kind: 'stale', proposal: await this.propose(projectDir, stepId, recompute), recomputed: true };
      }
      return { kind: 'stale', proposal, recomputed: false };
    }
    const content = editedContent === undefined ? proposal.proposedContent : editedContent;
    if (!content.trim()) throw new Error('Accepted patch content cannot be empty');
    const version = await docVersionService.appendVersion(projectDir, stepId, content, 'agent-patch', `Accepted patch ${id}`);
    proposal.status = 'accepted';
    await this.write(projectDir, stepId, proposals);
    return { kind: 'accepted', version, content };
  }

  async supersede(projectDir: string, stepId: string, id: string): Promise<void> {
    const proposals = await this.list(projectDir, stepId);
    const proposal = proposals.find((item) => item.id === id);
    if (proposal) {
      proposal.status = 'superseded';
      await this.write(projectDir, stepId, proposals);
    }
  }

  private async write(projectDir: string, stepId: string, proposals: PatchProposal[]) {
    const path = this.path(projectDir, stepId);
    await mkdir(join(projectDir, '.patches'), { recursive: true });
    await writeFile(path, JSON.stringify(proposals, null, 2), 'utf-8');
  }
}

export const autoPatchService = new AutoPatchService();
