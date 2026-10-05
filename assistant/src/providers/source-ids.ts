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

// Message-level fallback tag. A persisted row whose content is empty (an
// assistant turn that produced no blocks: user input landed mid-turn, a
// reasoning-only stop) has no block to carry the tag, so the id rides on the
// message object itself. Same non-enumerable Symbol discipline as blocks; it
// does not survive `{ ...message }` either, so rebuild seams carry it over.
const MESSAGE_SOURCE = Symbol.for("vellum.messageSourceId");

export function tagMessageSource(
  message: Message | undefined,
  sourceId: string | undefined,
): void {
  if (
    !message ||
    !sourceId ||
    !Object.isExtensible(message) ||
    taggedBlock(message as unknown as ContentBlock)[MESSAGE_SOURCE] !==
      undefined
  ) {
    return;
  }
  Object.defineProperty(message, MESSAGE_SOURCE, {
    value: sourceId,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

export function messageSourceId(message: Message): string | undefined {
  const id = taggedBlock(message as unknown as ContentBlock)[MESSAGE_SOURCE];
  return typeof id === "string" ? id : undefined;
}

/** Block ids of `message`; the message-level tag only when the blocks yield none. */
export function messageSourceIds(message: Message): string[] {
  const ids = collectSourceIds(message.content);
  if (ids.length > 0) {
    return ids;
  }
  const own = messageSourceId(message);
  return own === undefined ? [] : [own];
}

/**
 * `row/part` ids: one persisted row can render as several wire messages (each
 * tool result of a batch row becomes its own `tool` message; the row's
 * remaining blocks — hook guidance such as the tool-error notice, media, a
 * merged prompt — become a trailing `user` message). The part makes every wire
 * message's id unique by construction so a shim never needs content hashing
 * to tell them apart: the tool_use_id for a tool message, `tail` for the rest.
 */
export const SOURCE_PART_TAIL = "tail";

export function partSourceIds(ids: readonly string[], part: string): string[] {
  return ids.map((id) => `${id}/${part}`);
}

/**
 * Give the non-tool_result blocks of a tool-result message the row of its
 * results. The agent loop appends post-tool-use hook guidance (the tool-error
 * `<system_notice>`) to the same user message as the results it concerns; it
 * is never persisted on its own, so the results' row is the only honest owner.
 * Blocks that already carry a tag (a merged user prompt) are left alone. When
 * the results span several rows (history repair merged two batch rows), the
 * guidance follows the last result, which is the one it was appended after.
 */
export function tagToolResultTail(message: Message): void {
  if (message.role !== "user") {
    return;
  }
  let rowId: string | undefined;
  let hasTail = false;
  for (const block of message.content) {
    if (block.type === "tool_result") {
      rowId = blockSourceId(block) ?? rowId;
    } else if (blockSourceId(block) === undefined) {
      hasTail = true;
    }
  }
  if (rowId === undefined || !hasTail) {
    return;
  }
  for (const block of message.content) {
    if (block.type !== "tool_result") {
      tagBlocksSource([block], rowId);
    }
  }
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
    if (src.role !== dst.role) {
      continue;
    }
    tagMessageSource(dst, messageSourceId(src));
    if (src.content === dst.content) {
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

// v2: ids may be composite `row/part` (see `partSourceIds`); a wire message
// derived from an empty row carries the row's message-level tag.
export const VELLUM_WIRE_EXTENSION_VERSION = 2 as const;

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
