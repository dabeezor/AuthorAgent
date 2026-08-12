/**
 * Single source of truth for the app version shown to a human — the startup
 * banner and GET /api/health (which the dashboard sidebar reads). Both used
 * to hardcode their own version string independently ('v3.0.0' in the
 * banner, '4.0.0' in the health route) and silently drifted from
 * package.json's real version and from each other. Read once, cached.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

let cached: string | null = null;

export function getAppVersion(rootDir: string): string {
  if (cached) return cached;
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {
    // version stays 'unknown'
  }
  cached = version;
  return version;
}
