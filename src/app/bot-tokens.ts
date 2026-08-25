/**
 * Parse Telegram bot tokens from the environment.
 *
 *   BOT_TOKEN_1                     primary bot (unprefixed settings keys)
 *   BOT_TOKEN_2 / BOT_TOKEN_3 / …   extra bots on the same Grok process
 *   TELEGRAM_BOT_TOKEN              alias for BOT_TOKEN_1 when that key is unset
 *   TELEGRAM_BOT_TOKEN_<LABEL>      extra labeled bots, e.g. TELEGRAM_BOT_TOKEN_APP
 *
 * Numbered keys win the slot order; labeled extras are appended alphabetically.
 */
export interface BotTokenSpec {
  token: string;
  /** Slot (`"1"`) or lowercased suffix (`"app"`). */
  label: string;
  /** First bot — settings and tasks stay unprefixed. */
  primary: boolean;
  envKey: string;
}

const NUMBERED_RE = /^BOT_TOKEN_([1-9][0-9]*)$/;
const LABELED_RE = /^TELEGRAM_BOT_TOKEN_([A-Z][A-Z0-9_]*)$/;

export function parseBotTokens(env: Record<string, string | undefined>): BotTokenSpec[] {
  const numbered: { n: number; spec: BotTokenSpec }[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const m = NUMBERED_RE.exec(key);
    if (!m) continue;
    const token = (raw ?? "").trim();
    if (!token) continue;
    const n = Number(m[1]);
    numbered.push({
      n,
      spec: {
        token,
        label: String(n),
        primary: n === 1,
        envKey: key,
      },
    });
  }
  numbered.sort((a, b) => a.n - b.n);

  const alias = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (alias && !numbered.some((x) => x.n === 1)) {
    numbered.unshift({
      n: 1,
      spec: {
        token: alias,
        label: "1",
        primary: true,
        envKey: "TELEGRAM_BOT_TOKEN",
      },
    });
  }

  const labeled: BotTokenSpec[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const m = LABELED_RE.exec(key);
    if (!m) continue;
    const token = (raw ?? "").trim();
    if (!token) continue;
    labeled.push({
      token,
      label: m[1]!.toLowerCase(),
      primary: false,
      envKey: key,
    });
  }
  labeled.sort((a, b) => a.label.localeCompare(b.label));

  const out: BotTokenSpec[] = [];
  const seen = new Set<string>();
  for (const { spec } of numbered) {
    if (seen.has(spec.token)) continue;
    seen.add(spec.token);
    out.push(spec);
  }
  for (const spec of labeled) {
    if (seen.has(spec.token)) continue;
    seen.add(spec.token);
    out.push(spec);
  }
  if (out.length === 0) {
    throw new Error(
      "No Telegram bot token set. Set BOT_TOKEN_1 (and optionally BOT_TOKEN_2, BOT_TOKEN_3, …) or TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKEN_<LABEL>.",
    );
  }
  if (!out.some((s) => s.primary)) out[0]!.primary = true;
  return out;
}
