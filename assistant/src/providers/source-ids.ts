/**
 * [local patch: shim source ids]
 *
 * Side-channel correlation between in-memory content blocks and the persisted
 * conversation row they came from. `Message` is `{ role, content }` only and
 * stays that way; the row id rides in a WeakMap keyed by the block object.
 * History repair merges messages by spreading block arrays (block references
 * survive), so the tag follows a block through merges, slices and re-pushes
 * without touching `Message` or the repair code. Blocks that get rebuilt
 * (tool-result stubs, media swaps) simply lose the tag — consumers must treat
 * the id as best-effort and fall back to content.
 *
 * Exported to openai-compatible shims only, as a non-standard `_vellum` field
 * on the Chat Completions body (see `OpenAIChatCompletionsProvider`), so a
 * shim can tell "same message, rewritten rendering" from "new message".
 */
import type { ContentBlock } from "./types.js";

const blockSource = new WeakMap<object, string>();

/** Tag every block that has no tag yet. Never overwrites an existing tag. */
export function tagBlocksSource(
  blocks: readonly ContentBlock[] | undefined,
  sourceId: string | undefined,
): void {
  if (!blocks || !sourceId) {
    return;
  }
  for (const block of blocks) {
    if (
      block !== null &&
      typeof block === "object" &&
      !blockSource.has(block)
    ) {
      blockSource.set(block, sourceId);
    }
  }
}

export function blockSourceId(block: ContentBlock): string | undefined {
  return block !== null && typeof block === "object"
    ? blockSource.get(block)
    : undefined;
}

/** Distinct source ids of `blocks`, in first-seen order. */
export function collectSourceIds(blocks: readonly ContentBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    const id = blockSourceId(block);
    if (id !== undefined && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

export const VELLUM_WIRE_EXTENSION_VERSION = 1 as const;

export interface VellumWireExtension {
  version: typeof VELLUM_WIRE_EXTENSION_VERSION;
  /** Entries only for wire messages that carry at least one source id. */
  messages: { index: number; source_ids: string[] }[];
}

/**
 * Build the `_vellum` body extension from per-wire-message source ids
 * (`perMessage[i]` = ids of `messages[i]` in the final HTTP body). Returns
 * undefined when nothing is tagged so the body stays byte-identical.
 */
export function buildVellumWireExtension(
  perMessage: readonly (readonly string[])[],
): VellumWireExtension | undefined {
  const messages: VellumWireExtension["messages"] = [];
  perMessage.forEach((ids, index) => {
    if (ids.length > 0) {
      messages.push({ index, source_ids: [...ids] });
    }
  });
  return messages.length > 0
    ? { version: VELLUM_WIRE_EXTENSION_VERSION, messages }
    : undefined;
}
