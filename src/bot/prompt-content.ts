/**
 * Build ACP prompt content blocks from a PromptInput (text + images + optional
 * resource links), applying the reasoning directive and any fork-priming
 * context. Also merges multiple queued inputs into one.
 */
import type { ContentBlock } from "../grok/types.js";
import type { PromptInput } from "../app/types.js";

export interface ContentOptions {
  reasoning?: string;
  priming?: string;
  /** Appended so the agent emits a `{progress: N%}` marker. */
  progress?: string;
  /** Appended so the agent keeps generated images in the session media folder. */
  imageOutput?: string;
}

export function buildContentBlocks(input: PromptInput, opts: ContentOptions = {}): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const img of input.images) {
    blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  for (const link of input.resourceLinks ?? []) {
    blocks.push({
      type: "resource_link",
      uri: link.uri,
      name: link.name,
      mimeType: link.mimeType,
      size: link.size,
    });
  }

  let text = input.text.trim();
  if (!text && input.images.length > 0) {
    text = input.images.length === 1 ? "Please analyze the attached image." : "Please analyze the attached images.";
  }
  if (!text && (input.resourceLinks?.length ?? 0) > 0) {
    text = "Please process the attached file(s).";
  }
  if (input.quotedText?.trim()) {
    const quoted = input.quotedText.trim();
    const body = text || "(the user's reply carried no additional text)";
    text = `The user is replying to this earlier message:\n\n<<<\n${quoted}\n>>>\n\n${body}`;
  }
  if (opts.priming) {
    text = `${opts.priming}\n\n---\n\nUser's new message:\n${text}`;
  }
  if (opts.reasoning) {
    text = `(${opts.reasoning})\n\n${text}`;
  }
  if (opts.imageOutput) {
    text = `${text}\n\n${opts.imageOutput}`;
  }
  if (opts.progress) {
    // Progress last so its "marker is the final line" rule stays true.
    text = `${text}\n\n${opts.progress}`;
  }

  blocks.push({ type: "text", text });
  return blocks;
}

/** Merge queued inputs into a single prompt (concatenated text, all images/links). */
export function mergeInputs(inputs: PromptInput[]): PromptInput {
  const quotes = inputs
    .map((i) => i.quotedText?.trim())
    .filter((q): q is string => !!q);
  return {
    text: inputs
      .map((i) => i.text)
      .filter((t) => t.trim().length > 0)
      .join("\n\n"),
    images: inputs.flatMap((i) => i.images),
    resourceLinks: inputs.flatMap((i) => i.resourceLinks ?? []),
    replyTo: inputs.find((i) => i.replyTo !== undefined)?.replyTo,
    quotedText: quotes.length > 0 ? [...new Set(quotes)].join("\n\n---\n\n") : undefined,
  };
}

export function imageSummary(input: PromptInput): string {
  return input.images.length > 0 ? ` (+${input.images.length} image${input.images.length > 1 ? "s" : ""})` : "";
}
