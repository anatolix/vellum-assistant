/**
 * [local patch: shim source ids]
 *
 * Side-channel correlation between in-memory content blocks and the persisted
 * conversation row they came from. `Message` is `{ role, content }` only and
 * stays that way; the row id rides on a non-enumerable Symbol property of
 * each block, invisible to JSON, deep equality and provider wire fields. It
 * survives anything that keeps block identity (history repair merges, message
 * re-wrapping); seams that rebuild blocks carry it over explicitly
 * (`carrySourceTags`, assistant cleanup, tool-result re-tagging).
 *
 * Exported to openai-compatible shims only, as a non-standard `_vellum` field
 * on the Chat Completions body (see `OpenAIChatCompletionsProvider`), so a
 * shim can tell "same message, rewritten rendering" from "new message".
 */
import type { ContentBlock, Message } from "./types.js";

// A non-enumerable Symbol property on the block itself. It does NOT survive
// object spread, so every seam that rebuilds blocks must carry the tag over
// explicitly (assistant cleanup does; tool results are re-tagged before each
// provider call). Kept non-enumerable so Bun/Node deep equality, JSON and
// Object.keys never see it.
const BLOCK_SOURCE = Symbol.for("vellum.sourceId");

function taggedBlock(block: ContentBlock): Record<symbol, unknown> {
  return block as unknown as Record<symbol, unknown>;
}

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
      Object.isExtensible(block) &&
      taggedBlock(block)[BLOCK_SOURCE] === undefined
    ) {
      // Non-enumerable: invisible to JSON, Object.keys and deep-equality, so
      // persisted rows, wire bodies and structural comparisons are unchanged.
      Object.defineProperty(block, BLOCK_SOURCE, {
        value: sourceId,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
  }
}

export function blockSourceId(block: ContentBlock): string | undefined {
  if (block === null || typeof block !== "object") {
    return undefined;
  }
  const sourceId = taggedBlock(block)[BLOCK_SOURCE];
  return typeof sourceId === "string" ? sourceId : undefined;
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

/**
 * Carry tags from `from` onto a rebuilt copy `to` (e.g. the pre-send
 * sanitized history). Only when both arrays line up message-for-message by
 * role; an untagged block takes the tag of the same-index, same-type block of
 * its original message, or the original's sole id when it has exactly one.
 */
export function carrySourceTags(
  from: readonly Message[],
  to: readonly Message[],
): void {
  if (from === to || from.length !== to.length) {
    return;
  }
  for (let i = 0; i < to.length; i++) {
    const src = from[i]!;
    const dst = to[i]!;
    if (src.role !== dst.role || src.content === dst.content) {
      continue;
    }
    const ids = collectSourceIds(src.content);
    if (ids.length === 0) {
      continue;
    }
    dst.content.forEach((block, j) => {
      if (blockSourceId(block) !== undefined) {
        return;
      }
      const twin = src.content[j];
      const twinId =
        twin && twin.type === block.type ? blockSourceId(twin) : undefined;
      const id = twinId ?? (ids.length === 1 ? ids[0] : undefined);
      tagBlocksSource([block], id);
    });
  }
}

/**
 * Carry tags across a rebuild that reshapes the array (in-place compaction:
 * the head becomes a summary, the kept tail is re-created). Matches blocks by
 * exact content; a content shared by blocks of different rows is ambiguous
 * and left untagged rather than guessed.
 */
export function carrySourceTagsByContent(
  from: readonly Message[],
  to: readonly Message[],
): void {
  if (from === to) {
    return;
  }
  const byKey = new Map<string, string | null>();
  for (const m of from) {
    for (const block of m.content) {
      const id = blockSourceId(block);
      if (id === undefined) {
        continue;
      }
      const key = `${m.role}\u0000${JSON.stringify(block)}`;
      const prev = byKey.get(key);
      byKey.set(key, prev === undefined || prev === id ? id : null);
    }
  }
  if (byKey.size === 0) {
    return;
  }
  for (const m of to) {
    for (const block of m.content) {
      if (blockSourceId(block) !== undefined) {
        continue;
      }
      const id = byKey.get(`${m.role}\u0000${JSON.stringify(block)}`);
      if (id) {
        tagBlocksSource([block], id);
      }
    }
  }
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
