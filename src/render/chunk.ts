/**
 * Split a MarkdownV2 string into Telegram-sized chunks (<= 4096 chars) without
 * breaking code fences. If a split happens inside a fenced block, the block is
 * closed before the boundary and reopened in the next chunk (same tick length).
 */
const LIMIT = 4000; // headroom under Telegram's 4096 hard limit

export function chunkMarkdown(text: string, limit = LIMIT): string[] {
  if (text.length <= limit) return text.length ? [text] : [];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  /** Open fence: tick count + optional lang; null when outside a fence. */
  let openFence: { ticks: number; lang: string } | null = null;

  const flush = (): void => {
    if (current.length === 0) return;
    let body = current.join("\n");
    if (openFence) body += "\n" + "`".repeat(openFence.ticks); // close dangling fence
    chunks.push(body);
    current = [];
    size = 0;
    if (openFence) {
      // Reopen the fence at the top of the next chunk (preserve tick length).
      const reopen = "`".repeat(openFence.ticks) + openFence.lang;
      current.push(reopen);
      size = reopen.length + 1;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const fenceMatch = /^(```+)(.*)$/.exec(line);

    // Hard-split a single oversized line (never mid-fence marker line).
    if (line.length + 1 > limit && fenceMatch === null) {
      flush();
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }

    if (size + line.length + 1 > limit) flush();

    current.push(line);
    size += line.length + 1;

    if (fenceMatch) {
      const ticks = fenceMatch[1]!.length;
      const lang = (fenceMatch[2] ?? "").trim();
      if (!openFence) {
        openFence = { ticks, lang };
      } else if (ticks >= openFence.ticks) {
        openFence = null;
      }
    }
  }

  flush();
  return chunks.filter((c) => c.trim().length > 0);
}
