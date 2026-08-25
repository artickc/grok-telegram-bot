/**
 * Static catalog of known Grok Build models, used to seed the Model menu when
 * the ACP agent doesn't advertise a model list, and to derive a context-usage %
 * from any token counts the agent reports. `session/new` model info (when
 * present) always wins over this list.
 */
import { spawn } from "node:child_process";

export interface GrokModel {
  modelId: string;
  name: string;
  description?: string;
  /** Approximate max context window in tokens (for the context-usage bar). */
  contextWindow: number;
}

/** Flagship ids: `grok-4`, `grok-4.5`, `grok-4.6` — no extra suffix. */
const FLAGSHIP_RE = /^grok-\d+(?:\.\d+)*$/i;
const VERSIONED_RE = /^grok-(\d+(?:\.\d+)*)(.*)$/i;

function versionParts(id: string): { nums: number[]; variant: boolean } {
  const m = VERSIONED_RE.exec(id);
  if (!m) return { nums: [-1], variant: true };
  return {
    nums: m[1]!.split(".").map((n) => Number(n) || 0),
    variant: Boolean(m[2]),
  };
}

/** Negative if `a` is older than `b`. Flagship beats a same-version variant. */
export function compareModelIds(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const da = pa.nums[i] ?? 0;
    const db = pb.nums[i] ?? 0;
    if (da !== db) return da - db;
  }
  if (pa.variant !== pb.variant) return pa.variant ? -1 : 1;
  return a.localeCompare(b);
}

/** Highest-version id in `ids`. Same version: flagship (`grok-4.6`) over variants. */
export function newestModelId(ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const id of ids) {
    const t = id.trim();
    if (!t) continue;
    if (!best || compareModelIds(t, best) > 0) best = t;
  }
  return best;
}

export function parseGrokModelsOutput(text: string): { defaultId?: string; available: string[] } {
  const defaultId = text.match(/^Default model:\s+(\S+)/m)?.[1];
  const available: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[*\-]\s+(\S+)/.exec(line);
    if (!m) continue;
    const id = m[1]!.replace(/\(default\)\s*$/i, "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    available.push(id);
  }
  return { defaultId, available };
}

/** Best-effort `grok models` listing. Empty on timeout/failure. */
export function queryGrokCliModels(cliPath: string, timeoutMs = 8000): Promise<string[]> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ids: string[]) => {
      if (settled) return;
      settled = true;
      resolve(ids);
    };
    const child = spawn(cliPath, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done([]);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer | string) => {
      out += String(d);
    });
    child.on("error", () => {
      clearTimeout(timer);
      done([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      done(parseGrokModelsOutput(out).available);
    });
  });
}

/** Known models (best-effort; the agent's own list wins when advertised). */
export const KNOWN_MODELS: GrokModel[] = [
  { modelId: "grok-4.6", name: "Grok 4.6", description: "Flagship coding model", contextWindow: 256_000 },
  { modelId: "grok-4.5", name: "Grok 4.5", description: "Previous flagship", contextWindow: 256_000 },
  { modelId: "grok-4.20-non-reasoning", name: "Grok 4.20 (non-reasoning)", description: "Faster, no deep reasoning", contextWindow: 256_000 },
  { modelId: "grok-4", name: "Grok 4", description: "Grok 4", contextWindow: 256_000 },
  { modelId: "grok-code-fast-1", name: "Grok Code Fast", description: "Coding-optimized, fast", contextWindow: 256_000 },
];

/** Newest flagship in the static catalog (used before `grok models` / ACP answers). */
export const DEFAULT_MODEL =
  newestModelId(KNOWN_MODELS.map((m) => m.modelId).filter((id) => FLAGSHIP_RE.test(id))) ??
  newestModelId(KNOWN_MODELS.map((m) => m.modelId)) ??
  "grok-4.5";

const DEFAULT_CONTEXT_WINDOW = 256_000;

/** Context window for a model id (falls back to a conservative default). */
export function contextWindowFor(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  const hit = KNOWN_MODELS.find((m) => m.modelId === modelId);
  if (hit) return hit.contextWindow;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Map a tool name to a coarse "kind" so the renderer can pick the right
 * icon/label (read / edit / execute / search / …).
 */
export function toolKind(name: string | undefined): string {
  const n = (name || "").toLowerCase();
  if (/write|edit|create|apply|patch|str_replace|delete|move|mkdir/.test(n)) return "edit";
  if (/read|view|open|cat|ls|list|glob|stat/.test(n)) return "read";
  if (/search|grep|find|search_web|search_x/.test(n)) return "search";
  if (/bash|shell|exec|run|command|terminal|process/.test(n)) return "execute";
  if (/fetch|http|curl|web|browse/.test(n)) return "fetch";
  if (/task|delegate|agent/.test(n)) return "think";
  if (/image|video|media|generate_/.test(n)) return "other";
  return "other";
}
