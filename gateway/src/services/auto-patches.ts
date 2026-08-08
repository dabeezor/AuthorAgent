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
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
}

export type PatchGenerator = (parentContent: string) => Promise<string>;

export class AutoPatchService {
  private path(projectDir: string, stepId: string) {
    return join(projectDir, '.patches', `${stepId}.json`);
  }

  async propose(projectDir: string, stepId: string, generate: PatchGenerator): Promise<PatchProposal> {
    const versions = await docVersionService.getVersions(projectDir, stepId);
    const parent = versions.at(-1);
    if (!parent) throw new Error('Document has no version to patch');
    const parentContent = await docVersionService.getVersionContent(projectDir, stepId, parent.v);
    if (parentContent === null) throw new Error(`Parent version v${parent.v} is missing`);
    const proposedContent = await generate(parentContent);
    if (!proposedContent.trim()) throw new Error('Patch generator returned empty content');
    const proposal: PatchProposal = {
      id: randomUUID(), stepId, parentV: parent.v, parentSha256: parent.sha256,
      proposedContent, createdAt: Date.now(), status: 'pending',
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

  async accept(projectDir: string, stepId: string, id: string, editedContent?: string): Promise<
    | { kind: 'accepted'; version: number; content: string }
    | { kind: 'stale'; proposal: PatchProposal }
    | { kind: 'missing' }
  > {
    const proposals = await this.list(projectDir, stepId);
    const proposal = proposals.find((item) => item.id === id && item.status === 'pending');
    if (!proposal) return { kind: 'missing' };
    const currentV = await docVersionService.getCurrentVersion(projectDir, stepId);
    if (currentV !== proposal.parentV) return { kind: 'stale', proposal };
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
