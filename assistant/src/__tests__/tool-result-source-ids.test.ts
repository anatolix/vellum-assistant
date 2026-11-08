import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  derefToolResultReReads,
  postTurnTruncateToolResults,
} from "../context/post-turn-tool-result-truncation.js";
import { truncateToolResultsAcrossHistory } from "../context/tool-result-truncation.js";
import {
  blockSourceId,
  messageSourceId,
  tagBlocksSource,
  tagPersistedMessageSource,
} from "../providers/source-ids.js";
import type { Message } from "../providers/types.js";
import { captureSourceIdWire } from "./helpers/capture-source-id-wire.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-source-ids-"));
  dirs.push(dir);
  return dir;
}

function history(): Message[] {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Read the reports" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_a",
          name: "file_read",
          input: { path: "/example/.tool-results/a.txt" },
        },
        {
          type: "tool_use",
          id: "call_b",
          name: "web_fetch",
          input: { url: "https://example.com/report" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_a",
          content: "A".repeat(30_000),
        },
        {
          type: "tool_result",
          tool_use_id: "call_b",
          content: "B".repeat(30_000),
        },
        { type: "text", text: "Compare them" },
      ],
    },
  ];
  tagPersistedMessageSource(messages[0], "prompt-row");
  tagPersistedMessageSource(messages[1], "assistant-row");
  // A merged history row may contain several owners: do not flatten to one ID.
  tagBlocksSource([messages[2].content[0]], "result-a");
  tagBlocksSource([messages[2].content[1]], "result-b");
  tagPersistedMessageSource(messages[2], "tail-row");
  return messages;
}

const passes: Record<string, (messages: Message[]) => Message[]> = {
  "post-turn truncation": (messages) =>
    postTurnTruncateToolResults(messages, { conversationDir: tempDir() })
      .messages,
  "saved-result reread": (messages) =>
    derefToolResultReReads(messages).messages,
  "overflow truncation": (messages) =>
    truncateToolResultsAcrossHistory(messages, 1200).messages,
  "reload/finalize sequence": (messages) =>
    postTurnTruncateToolResults(derefToolResultReReads(messages).messages, {
      conversationDir: tempDir(),
    }).messages,
};

describe("source IDs across tool-result rewrites", () => {
  for (const [name, transform] of Object.entries(passes)) {
    test(`${name} preserves per-block owners, row tag and original content`, () => {
      const original = history();
      const before = JSON.stringify(original);
      const result = transform(original);
      expect(result[2]).not.toBe(original[2]);
      expect(result[2].content.map(blockSourceId)).toEqual([
        "result-a",
        "result-b",
        "tail-row",
      ]);
      expect(messageSourceId(result[2])).toBe("tail-row");
      expect(JSON.stringify(original)).toBe(before);
      expect(result[0]).toBe(original[0]);
      expect(Object.keys(result[2])).toEqual(["role", "content"]);
      expect(Object.keys(result[2].content[0])).toEqual([
        "type",
        "tool_use_id",
        "content",
      ]);
    });

    test(`${name} exports composite IDs on the provider wire`, async () => {
      const wire = await captureSourceIdWire(transform(history()));
      const ids = wire._vellum?.messages.flatMap((entry) => entry.source_ids);
      expect(ids).toContain("result-a/call_a");
      expect(ids).toContain("result-b/call_b");
      // The tail has its own distinct owner, so it keeps its bare row ID.
      expect(ids).toContain("tail-row");
    });
  }

  test("untagged results are not assigned invented owners", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            content: "A".repeat(30_000),
          },
        ],
      },
    ];
    const result = passes["post-turn truncation"](messages);
    expect(blockSourceId(result[0].content[0])).toBeUndefined();
    expect(messageSourceId(result[0])).toBeUndefined();
  });
});
