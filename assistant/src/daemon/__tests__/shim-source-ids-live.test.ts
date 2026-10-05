// [local patch: shim source ids] live (not-from-DB) tagging of assistant and
// tool-result rows, plus the tag-carrier invariants it relies on.
import { describe, expect, test } from "bun:test";

import {
  blockSourceId,
  carrySourceTags,
  collectSourceIds,
  tagBlocksSource,
} from "../../providers/source-ids.js";
import type { ContentBlock, Message } from "../../providers/types.js";
import {
  createEventHandlerState,
  tagToolResultSources,
} from "../conversation-agent-loop-handlers.js";

function toolResult(id: string, content = "ok"): ContentBlock {
  return { type: "tool_result", tool_use_id: id, content };
}

describe("source id tag carrier", () => {
  test("tag survives message re-wrapping that keeps block identity", () => {
    const block: ContentBlock = { type: "text", text: "hi" };
    tagBlocksSource([block], "row-a");
    const msg: Message = { role: "assistant", content: [block] };
    const rewrapped: Message = { ...msg, content: [...msg.content] };
    expect(collectSourceIds(rewrapped.content)).toEqual(["row-a"]);
  });

  test("tag never leaks into JSON, keys or deep equality", () => {
    const block: ContentBlock = { type: "text", text: "hi" };
    tagBlocksSource([block], "row-b");
    expect(JSON.stringify(block)).toBe('{"type":"text","text":"hi"}');
    expect(Object.keys(block)).toEqual(["type", "text"]);
    expect(block).toEqual({ type: "text", text: "hi" });
    expect(blockSourceId(block)).toBe("row-b");
  });

  test("frozen blocks are skipped, not thrown on", () => {
    const block = Object.freeze({ type: "text", text: "x" }) as ContentBlock;
    tagBlocksSource([block], "row-f");
    expect(blockSourceId(block)).toBeUndefined();
  });

  test("carrySourceTags restores tags on a rebuilt (sanitized) copy", () => {
    const user: Message = {
      role: "user",
      content: [{ type: "text", text: "q" }],
    };
    const asst: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", id: "c1", name: "x", input: {} },
      ],
    };
    const merged: Message = {
      role: "user",
      content: [toolResult("c1"), { type: "text", text: "next" }],
    };
    tagBlocksSource(user.content, "u1");
    tagBlocksSource(asst.content, "a1");
    tagBlocksSource([merged.content[0]!], "t1");
    tagBlocksSource([merged.content[1]!], "u2");
    const live = [user, asst, merged];
    const copy = live.map((m) => ({
      ...m,
      content: m.content.map((b) => ({ ...b })),
    })) as Message[];
    expect(collectSourceIds(copy[1]!.content)).toEqual([]);
    carrySourceTags(live, copy);
    expect(collectSourceIds(copy[0]!.content)).toEqual(["u1"]);
    expect(collectSourceIds(copy[1]!.content)).toEqual(["a1"]);
    expect(collectSourceIds(copy[2]!.content)).toEqual(["t1", "u2"]);
  });

  test("carrySourceTags refuses misaligned arrays", () => {
    const a: Message = { role: "user", content: [{ type: "text", text: "q" }] };
    tagBlocksSource(a.content, "u1");
    const copy: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ];
    carrySourceTags([a], copy);
    expect(collectSourceIds(copy[0]!.content)).toEqual([]);
  });
});

describe("tagToolResultSources", () => {
  test("tags tool_result blocks with their persisted row, in every target", async () => {
    const state = createEventHandlerState();
    state.toolResultRowByToolUseId.set("call_1", "tr-row-1");
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "x", input: {} }],
      },
      { role: "user", content: [toolResult("call_1")] },
    ];
    const sanitized = history.map((m) => ({
      ...m,
      content: m.content.map((b) => ({ ...b })),
    })) as Message[];
    // sanitized copy made BEFORE tagging: must be tagged on its own.
    await tagToolResultSources(state, [history, sanitized]);
    expect(blockSourceId(history[2]!.content[0]!)).toBe("tr-row-1");
    expect(blockSourceId(sanitized[2]!.content[0]!)).toBe("tr-row-1");
    // non-tool blocks untouched
    expect(blockSourceId(history[0]!.content[0]!)).toBeUndefined();
    expect(blockSourceId(history[1]!.content[0]!)).toBeUndefined();
  });

  test("waits for an in-flight batch reservation", async () => {
    const state = createEventHandlerState();
    (state.pendingToolResults as Map<string, unknown>).set("call_9", {});
    let resolve!: (id: string) => void;
    state.pendingToolResultRowReservation = new Promise<string>((r) => {
      resolve = r;
    });
    const history: Message[] = [
      { role: "user", content: [toolResult("call_9")] },
    ];
    const done = tagToolResultSources(state, [history]);
    resolve("tr-row-9");
    await done;
    expect(blockSourceId(history[0]!.content[0]!)).toBe("tr-row-9");
  });

  test("already-tagged blocks (loaded from DB) keep their tag", async () => {
    const state = createEventHandlerState();
    state.toolResultRowByToolUseId.set("call_2", "new-row");
    const block = toolResult("call_2");
    tagBlocksSource([block], "db-row");
    await tagToolResultSources(state, [[{ role: "user", content: [block] }]]);
    expect(blockSourceId(block)).toBe("db-row");
  });

  test("failed reservation does not throw", async () => {
    const state = createEventHandlerState();
    const rejected = Promise.reject(new Error("db down"));
    rejected.catch(() => {});
    state.pendingToolResultRowReservation = rejected;
    const block = toolResult("call_3");
    await tagToolResultSources(state, [[{ role: "user", content: [block] }]]);
    expect(blockSourceId(block)).toBeUndefined();
  });
});
