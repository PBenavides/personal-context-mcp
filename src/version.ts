import { readFileSync } from 'node:fs';
import { getRepoPath } from './utils/directories.js';

interface PackageInfo {
  name: string;
  version: string;
}

let cached: PackageInfo | undefined;

/** Reads `name` and `version` from the service `package.json` (cached; read once). */
export function packageInfo(): PackageInfo {
  cached ??= JSON.parse(
    readFileSync(getRepoPath('package.json'), 'utf-8'),
  ) as PackageInfo;
  return cached;
}

/**
 * The service version, sourced from `package.json`. Every MCP advertises this same version —
 * MCPs are versioned service-wide, not independently, so bumping `package.json` aligns them all
 * and there is no per-MCP version to maintain by hand.
 */
export function getAppVersion(): string {
  return packageInfo().version;
}
