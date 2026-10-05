import { describe, expect, test } from "bun:test";

import { repairHistory } from "../../agent/history-repair/history-repair.js";
import {
  blockSourceId,
  buildVellumWireExtension,
  collectSourceIds,
  tagBlocksSource,
} from "../source-ids.js";
import type { ContentBlock, Message } from "../types.js";

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

describe("source-ids side-channel", () => {
  test("first tag wins; untagged blocks report undefined", () => {
    const a = text("a");
    const b = text("b");
    tagBlocksSource([a], "row-1");
    tagBlocksSource([a, b], "row-2");
    expect(blockSourceId(a)).toBe("row-1");
    expect(blockSourceId(b)).toBe("row-2");
    expect(blockSourceId(text("c"))).toBeUndefined();
    tagBlocksSource(undefined, "x");
    tagBlocksSource([text("d")], undefined);
  });

  test("collectSourceIds dedupes in first-seen order", () => {
    const a = text("a");
    const b = text("b");
    const c = text("c");
    tagBlocksSource([a, c], "row-9");
    tagBlocksSource([b], "row-3");
    expect(collectSourceIds([a, b, c, text("untagged")])).toEqual([
      "row-9",
      "row-3",
    ]);
  });

  test("tags survive repairHistory merge of consecutive same-role messages", () => {
    const m1: Message = { role: "user", content: [text("first")] };
    const m2: Message = { role: "user", content: [text("second")] };
    tagBlocksSource(m1.content, "row-10");
    tagBlocksSource(m2.content, "row-11");

    const { messages, stats } = repairHistory([m1, m2]);
    expect(stats.consecutiveSameRoleMerged).toBe(1);
    expect(messages).toHaveLength(1);
    expect(collectSourceIds(messages[0]!.content)).toEqual([
      "row-10",
      "row-11",
    ]);
  });

  test("buildVellumWireExtension skips untagged wire messages", () => {
    expect(buildVellumWireExtension([[], []])).toBeUndefined();
    expect(buildVellumWireExtension([])).toBeUndefined();
    expect(buildVellumWireExtension([[], ["r1"], [], ["r2", "r3"]])).toEqual({
      version: 2,
      messages: [
        { index: 1, source_ids: ["r1"] },
        { index: 3, source_ids: ["r2", "r3"] },
      ],
    });
  });
});
