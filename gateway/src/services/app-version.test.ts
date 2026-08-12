import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// getAppVersion() memoizes its result in a module-level variable, so each
// test needs a fresh module instance to observe a different package.json —
// vi.resetModules() + a dynamic re-import gets a clean cache per test.

describe('getAppVersion', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'authoragent-app-version-'));
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('reads the version out of package.json', async () => {
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ version: '4.1.0' }));
    const { getAppVersion } = await import('./app-version.js');
    expect(getAppVersion(rootDir)).toBe('4.1.0');
  });

  it('caches the result — a later package.json change is not picked up without a fresh module', async () => {
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ version: '4.1.0' }));
    const { getAppVersion } = await import('./app-version.js');
    expect(getAppVersion(rootDir)).toBe('4.1.0');

    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(getAppVersion(rootDir)).toBe('4.1.0'); // still cached, not re-read
  });

  it('falls back to "unknown" when package.json is missing', async () => {
    const { getAppVersion } = await import('./app-version.js');
    expect(getAppVersion(join(rootDir, 'does-not-exist'))).toBe('unknown');
  });

  it('falls back to "unknown" when package.json has no version field', async () => {
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'authoragent' }));
    const { getAppVersion } = await import('./app-version.js');
    expect(getAppVersion(rootDir)).toBe('unknown');
  });

  it('falls back to "unknown" when package.json is malformed JSON', async () => {
    await writeFile(join(rootDir, 'package.json'), '{not valid json');
    const { getAppVersion } = await import('./app-version.js');
    expect(getAppVersion(rootDir)).toBe('unknown');
  });
});
