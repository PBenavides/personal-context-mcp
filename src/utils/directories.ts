import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves a path relative to the package root, working identically when running
 * from `src/` (ts-jest) and from `dist/` (built). This file lives two levels deep
 * (`src/utils/` or `dist/utils/`), so two `..` segments reach the package root,
 * where the bundled `resource-files/` directory is shipped.
 */
export function getRepoPath(relativePath: string): string {
  return path.join(currentDir, '..', '..', relativePath);
}

/** Resolves a path inside the bundled `resource-files/` directory. */
export function getResourcePath(relativePath: string): string {
  return getRepoPath(path.join('resource-files', relativePath));
}
