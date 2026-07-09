/**
 * Split a MarkdownV2 string into Telegram-sized chunks (<= 4096 chars) without
 * breaking code fences. If a split happens inside a ``` block, the block is
 * closed before the boundary and reopened in the next chunk.
 */
const LIMIT = 4000; // headroom under Telegram's 4096 hard limit

export function chunkMarkdown(text: string, limit = LIMIT): string[] {
  if (text.length <= limit) return text.length ? [text] : [];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let fenceLang: string | null = null; // non-null => currently inside a fence

  const flush = (): void => {
    if (current.length === 0) return;
    let body = current.join("\n");
    if (fenceLang !== null) body += "\n```"; // close dangling fence
    chunks.push(body);
    current = [];
    size = 0;
    if (fenceLang !== null) {
      // Reopen the fence at the top of the next chunk.
      const reopen = "```" + fenceLang;
      current.push(reopen);
      size = reopen.length + 1;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const fenceMatch = /^```(.*)$/.exec(line);

    // Hard-split a single oversized line.
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
      fenceLang = fenceLang === null ? (fenceMatch[1] ?? "").trim() : null;
    }
  }

  flush();
  return chunks.filter((c) => c.trim().length > 0);
}
