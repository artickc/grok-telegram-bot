/**
 * Pure resolution of unbound-topic bind text: absolute directory path or
 * exact catalog project name only (no fuzzy/partial matches).
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type BindProjectLookup = {
  name: string;
  path: string;
};

export type ResolveBindTargetResult =
  | { ok: true; path: string; created?: boolean }
  | { ok: false; error: string };

/** Strip quotes/backticks and expand leading ~. */
export function normalizeBindInput(text: string): string {
  let raw = text.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!raw) return "";
  // Expand ~ / ~/foo
  if (raw === "~") raw = homedir();
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    raw = join(homedir(), raw.slice(2));
  }
  return raw;
}

/** Safe single-segment project folder name (no path separators / drive). */
export function isSafeProjectFolderName(name: string): boolean {
  const t = name.trim();
  if (!t || t.length > 80) return false;
  if (/[\\/]/.test(t)) return false;
  if (/^[a-zA-Z]:/.test(t)) return false; // drive letter
  if (/[<>:"|?*\x00-\x1f]/.test(t)) return false;
  if (t === "." || t === "..") return false;
  return true;
}

/**
 * Resolve user text to a project directory.
 * - Existing filesystem path (absolute or resolvable) that is a directory
 * - Exact catalog project name (case-insensitive)
 * - Optional: create missing **absolute** directories (agent new-project flow)
 * - Optional: create `defaultRoot/<safeName>` for a simple name when missing
 * Never uses substring / partial name matching for catalog lookup.
 */
export function resolveBindTarget(
  text: string,
  opts: {
    existsSync: (p: string) => boolean;
    isDirectory: (p: string) => boolean;
    findExactByName: (name: string) => BindProjectLookup | undefined;
    /**
     * When true, if path is absolute and missing, create the directory.
     * Also creates `defaultRoot/<name>` for a safe single-segment name.
     */
    createIfMissing?: boolean;
    mkdirSync?: (p: string) => void;
    /** First PROJECT_ROOTS entry — used to create new projects by short name. */
    defaultRoot?: string;
  },
): ResolveBindTargetResult {
  const raw = normalizeBindInput(text);
  if (!raw) return { ok: false, error: "Empty path." };

  if (opts.existsSync(raw)) {
    const path = resolve(raw);
    if (!opts.isDirectory(path)) {
      return { ok: false, error: `Not a directory: ${path}` };
    }
    return { ok: true, path };
  }

  // Absolute path that does not exist yet — agent "create project + topic" flow.
  // Only isAbsolute(raw) so relative names never mkdir under process cwd.
  if (opts.createIfMissing && isAbsolute(raw)) {
    const absCandidate = resolve(raw);
    if (!opts.existsSync(absCandidate)) {
      const made = tryMkdir(absCandidate, opts);
      if (!made.ok) return made;
      return { ok: true, path: absCandidate, created: true };
    }
  }

  const hit = opts.findExactByName(raw);
  if (hit) {
    if (!opts.isDirectory(hit.path)) {
      return { ok: false, error: `Not a directory: ${hit.path}` };
    }
    return { ok: true, path: hit.path };
  }

  // Short project name → create under first PROJECT_ROOTS (agent new project).
  if (
    opts.createIfMissing &&
    opts.defaultRoot &&
    opts.mkdirSync &&
    isSafeProjectFolderName(raw)
  ) {
    const full = resolve(opts.defaultRoot, raw.trim().replace(/[<>:"/\\|?*]/g, "_"));
    if (opts.existsSync(full)) {
      if (!opts.isDirectory(full)) {
        return { ok: false, error: `Not a directory: ${full}` };
      }
      return { ok: true, path: full };
    }
    const made = tryMkdir(full, opts);
    if (!made.ok) return made;
    return { ok: true, path: full, created: true };
  }

  return {
    ok: false,
    error:
      `Path not found: "${raw}". Use an absolute folder path (missing folders are created), ` +
      `a simple project name under PROJECT_ROOTS, or an **exact** catalog name.`,
  };
}

function tryMkdir(
  absCandidate: string,
  opts: {
    mkdirSync?: (p: string) => void;
    isDirectory: (p: string) => boolean;
  },
): { ok: true } | { ok: false; error: string } {
  if (!opts.mkdirSync) {
    return {
      ok: false,
      error: `Path does not exist and cannot create: ${absCandidate}`,
    };
  }
  try {
    opts.mkdirSync(absCandidate);
  } catch (e) {
    return {
      ok: false,
      error: `Could not create directory ${absCandidate}: ${(e as Error).message}`,
    };
  }
  if (!opts.isDirectory(absCandidate)) {
    return { ok: false, error: `Not a directory after create: ${absCandidate}` };
  }
  return { ok: true };
}
