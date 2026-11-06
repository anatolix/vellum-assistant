/** Regression: the summary request can contain only a truncation marker and
 * /compact. That synthetic marker must never become the durable tail anchor. */
import { describe, expect, mock, test } from "bun:test";

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getMessages: () => [],
}));
mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
}));
mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
}));

import { runAssistantDrivenCompaction } from "../context/compactor.js";
import type { Message, Provider } from "../providers/types.js";

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const flatten = (messages: Message[]) =>
  messages
    .flatMap((m) =>
      m.content.filter((b) => b.type === "text").map((b) => b.text),
    )
    .join("\n");
const summary = (anchor = "") => `<compaction_result>
<summary>Earlier work is summarized; preserve the active exchange.</summary>
<key_state>Finish the active task.</key_state>
${anchor}
</compaction_result>`;
const syntheticAnchor =
  '<tail_start timestamp="" preview="[218 earlier messages truncated — summary covers only the vi" />';

function fixture(
  response: string,
  messages: Message[],
  maxInputTokens = 10_000,
) {
  let sent: Message[] = [];
  const provider: Provider = {
    name: "mock-provider",
    sendMessage: async (request) => {
      sent = request;
      return {
        content: [{ type: "text", text: response }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      };
    },
  };
  return {
    run: (fixedTailStartIndex?: number) =>
      runAssistantDrivenCompaction({
        conversationId: "conv-test",
        messages,
        provider,
        systemPrompt: "system",
        compaction: { enabled: true, autoThreshold: 0.7 },
        maxInputTokens,
        previousEstimatedInputTokens: 90_000,
        force: true,
        targetTokens: 2_000,
        fixedTailStartIndex,
      }),
    request: () => sent,
  };
}

// Pair-safe truncation has to skip the huge tool-result-only suffix and can
// therefore leave only the final /compact in the outbound projection.
function overflowHistory(): Message[] {
  return [
    user("Old request before the active task."),
    assistant("Old outcome. " + "Large old reply. ".repeat(5_000)),
    user("ACTIVE TASK: preserve this exact exchange."),
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "active-tool", name: "read", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "active-tool",
          content: "Huge result. ".repeat(5_000),
        },
      ],
    },
    assistant("The active result is ready for inspection."),
    user("/compact"),
  ];
}

describe("compaction with front-truncated input", () => {
  test("pins a real history boundary instead of accepting the shim's synthetic marker", async () => {
    const messages = overflowHistory();
    const f = fixture(summary(syntheticAnchor), messages);
    const result = await f.run();
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(2);
    expect(flatten(f.request())).toContain("earlier messages truncated");
    expect(flatten(f.request())).toContain(
      "ACTIVE TASK: preserve this exact exchange.",
    );
    expect(flatten(f.request())).toContain("You do not choose");
    // No tool results get orphaned and the most recent exchange is not cut,
    // even when that exchange alone exceeds the target budget.
    expect(result.messages.slice(1)).toEqual(messages.slice(2));
    expect(flatten(result.messages)).not.toContain(
      "earlier messages truncated",
    );
  });

  test("accepts summary-only output when the overflow boundary is selected by Vellum", async () => {
    const messages = overflowHistory();
    const f = fixture(summary(), messages);
    const result = await f.run();
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(2);
    expect(result.messages.slice(1)).toEqual(messages.slice(2));
  });

  test("ignores a stale CLI-only anchor for front-truncated requests", async () => {
    const f = fixture(
      summary(
        '<tail_start timestamp="" preview="&lt;turn_aborted&gt; The user interrupted the " />',
      ),
      overflowHistory(),
    );
    const result = await f.run();
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(2);
  });

  test("does not burn a provider call when no safe real cut exists", async () => {
    const messages = [
      user("Only active request. " + "Unfinished work. ".repeat(10_000)),
      assistant("Still running."),
    ];
    const f = fixture(summary(), messages);
    const result = await f.run();
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no safe overflow boundary");
    expect(result.messages).toBe(messages);
    expect(f.request()).toEqual([]);
  });

  test("selects a budget-sized tail without dropping the latest completed exchange", async () => {
    const messages = [
      user("Old task."),
      assistant("Old outcome. " + "Old bulk. ".repeat(10_000)),
      user("Middle task."),
      assistant("Middle outcome. " + "Middle bulk. ".repeat(1_000)),
      user("Keep latest finished task."),
      assistant("Keep latest finished answer."),
      user("Current unfinished request."),
    ];
    const f = fixture(summary(syntheticAnchor), messages);
    const result = await f.run();
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(4);
    expect(result.messages.slice(1)).toEqual(messages.slice(4));
    expect(flatten(f.request())).toContain("Keep latest finished task.");
  });

  test("does not override the user's explicit fixed boundary", async () => {
    const messages = overflowHistory();
    const f = fixture(summary(syntheticAnchor), messages);
    const result = await f.run(6);
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(6);
    expect(result.messages.slice(1)).toEqual(messages.slice(6));
  });

  test("retains the existing model-chosen boundary contract below the window", async () => {
    const messages = [
      user("Earlier request."),
      assistant("Earlier outcome."),
      user("Preserve the latest request."),
      assistant("Latest reply."),
    ];
    const f = fixture(
      summary(
        '<tail_start timestamp="" preview="Preserve the latest request." />',
      ),
      messages,
      100_000,
    );
    const result = await f.run();
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(2);
    expect(flatten(f.request())).toContain("<tail_start");
    expect(flatten(f.request())).not.toContain("earlier messages truncated");
  });
});
