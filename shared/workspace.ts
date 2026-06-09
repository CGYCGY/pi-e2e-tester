/**
 * shared/workspace.ts — path guard + dir setup for the test workspace.
 *
 * pi has NO path sandbox for tools, so every filename the gated LLMs pass is
 * vetted HERE in code (matches spoke/guards.ts "guarded in code"). Uses only
 * node: built-ins (relative .ts import via jiti, no pi runtime dependency).
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * Resolve `<root>/<subfolder>/<name>` ONLY if `name` is a bare `*.<ext>` file
 * name (no slashes, no `..`, no traversal). Returns the absolute path or throws.
 * Defense-in-depth: also asserts the resolved file's dir is the expected subdir.
 */
export function safeWorkspacePath(
  root: string,
  subfolder: string,
  name: string,
  requiredExt: string,
): string {
  const ext = requiredExt.replace(/^\./, "");
  const re = new RegExp(`^[A-Za-z0-9._-]+\\.${ext}$`);
  if (!re.test(name)) {
    throw new Error(
      `invalid name "${name}": expected a bare <file>.${ext} (letters, digits, ` +
        `'.', '_', '-' only — no slashes or "..").`,
    );
  }
  const dir = resolve(root, subfolder);
  const full = resolve(dir, name);
  if (resolve(full, "..") !== dir) {
    throw new Error(`refused: "${name}" resolves outside ${dir}.`);
  }
  // Belt-and-braces: basename must match (catches any normalization surprise).
  if (basename(full) !== name) {
    throw new Error(`refused: "${name}" did not resolve to a plain file name.`);
  }
  return full;
}

/** mkdir -p the cases/results/screenshots subdirs (idempotent). */
export function ensureTestsDirs(dirs: {
  cases: string;
  results: string;
  screenshots: string;
}): void {
  for (const d of [dirs.cases, dirs.results, dirs.screenshots]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}
