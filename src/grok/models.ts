/**
 * Static catalog of known Grok Build models, used to seed the Model menu when
 * the ACP agent doesn't advertise a model list, and to derive a context-usage %
 * from any token counts the agent reports. `session/new` model info (when
 * present) always wins over this list.
 */
export interface GrokModel {
  modelId: string;
  name: string;
  description?: string;
  /** Approximate max context window in tokens (for the context-usage bar). */
  contextWindow: number;
}

/** Default model that powers Grok Build. */
export const DEFAULT_MODEL = "grok-4.5";

/** Known models (best-effort; the agent's own list wins when advertised). */
export const KNOWN_MODELS: GrokModel[] = [
  { modelId: "grok-4.5", name: "Grok 4.5", description: "Flagship coding model (default)", contextWindow: 256_000 },
  { modelId: "grok-4.20-non-reasoning", name: "Grok 4.20 (non-reasoning)", description: "Faster, no deep reasoning", contextWindow: 256_000 },
  { modelId: "grok-4", name: "Grok 4", description: "Grok 4", contextWindow: 256_000 },
  { modelId: "grok-code-fast-1", name: "Grok Code Fast", description: "Coding-optimized, fast", contextWindow: 256_000 },
];

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
