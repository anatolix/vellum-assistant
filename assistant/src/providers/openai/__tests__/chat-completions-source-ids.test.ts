import { describe, expect, test } from "bun:test";

import { tagBlocksSource, tagMessageSource } from "../../source-ids.js";
import type { Message, SendMessageOptions } from "../../types.js";
import { OpenAIChatCompletionsProvider } from "../chat-completions-provider.js";

type CreateParams = Record<string, unknown> & {
  messages: { role: string; content?: unknown }[];
  _vellum?: {
    version: number;
    reply_id?: string;
    messages: { index: number; source_ids: string[] }[];
  };
};

function captureProvider(providerName = "openai-compatible"): {
  provider: OpenAIChatCompletionsProvider;
  seen: () => CreateParams | undefined;
} {
  const provider = new OpenAIChatCompletionsProvider(
    "test-key",
    "qwen/qwen3-8b",
    { providerName },
  );
  let seenParams: CreateParams | undefined;
  (
    provider as unknown as {
      client: {
        chat: {
          completions: {
            create: (params: CreateParams) => Promise<AsyncIterable<unknown>>;
          };
        };
      };
    }
  ).client.chat.completions.create = async (params) => {
    seenParams = params;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };
  };
  return { provider, seen: () => seenParams };
}

/** user(u1) → assistant text+tool_use(a1) → user tool_result+text(u2). */
function taggedHistory(): Message[] {
  const m1: Message = {
    role: "user",
    content: [{ type: "text", text: "hi" }],
  };
  const m2: Message = {
    role: "assistant",
    content: [
      { type: "text", text: "looking" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
    ],
  };
  const m3: Message = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_1", content: "found" },
      { type: "text", text: "and then?" },
    ],
  };
  tagBlocksSource(m1.content, "u1");
  tagBlocksSource(m2.content, "a1");
  tagBlocksSource(m3.content, "u2");
  return [m1, m2, m3];
}

describe("chat-completions _vellum source ids", () => {
  test("joins reloaded text only on the wire, preserving every source owner", async () => {
    const { provider, seen } = captureProvider();
    const context = {
      type: "text" as const,
      text: "<turn_context>old</turn_context>",
    };
    const prompt = { type: "text" as const, text: "исчерпали" };
    tagBlocksSource([context], "u1");
    tagBlocksSource([prompt], "u2");
    const message: Message = { role: "user", content: [context, prompt] };
    tagMessageSource(message, "u1");
    const originalContent = message.content;
    await provider.sendMessage([message], {
      systemPrompt: "sys",
      config: { exportSourceIds: true },
    });
    expect(seen()?.messages[1]).toEqual({
      role: "user",
      content: "<turn_context>old</turn_context>\n\nисчерпали",
    });
    expect(seen()?._vellum?.messages).toEqual([
      { index: 1, source_ids: ["u1", "u2"] },
    ]);
    expect(message.content).toBe(originalContent);
    expect(message.content[0]).toBe(context);
    expect(message.content[1]).toBe(prompt);
  });

  test("keeps mixed text and image content as wire parts", async () => {
    const { provider, seen } = captureProvider();
    const message: Message = {
      role: "user",
      content: [
        { type: "text", text: "before" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        },
        { type: "text", text: "after" },
      ],
    };
    tagBlocksSource(message.content, "u1");
    await provider.sendMessage([message], {
      systemPrompt: "sys",
      config: { exportSourceIds: true },
    });
    expect(seen()?.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "before" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        },
        { type: "text", text: "after" },
      ],
    });
    expect(seen()?._vellum?.messages).toEqual([
      { index: 1, source_ids: ["u1"] },
    ]);
  });

  test("indexes source ids against the fanned-out wire messages", async () => {
    const { provider, seen } = captureProvider();
    const options: SendMessageOptions = {
      systemPrompt: "sys",
      config: { exportSourceIds: true },
    };
    await provider.sendMessage(taggedHistory(), options);

    const params = seen();
    expect(params?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(params?._vellum).toEqual({
      version: 3,
      messages: [
        { index: 1, source_ids: ["u1"] },
        { index: 2, source_ids: ["a1"] },
        { index: 3, source_ids: ["u2/call_1"] },
        { index: 4, source_ids: ["u2/tail"] },
      ],
    });
  });

  test("an empty assistant turn exports its message-level row id; a merged prompt in the tail keeps a plain id", async () => {
    const { provider, seen } = captureProvider();
    const [m1, m2, m3] = taggedHistory();
    const prompt = { type: "text" as const, text: "also" };
    tagBlocksSource([prompt], "u3");
    m3!.content.push(prompt);
    const empty: Message = { role: "assistant", content: [] };
    tagMessageSource(empty, "a2");
    const m5: Message = {
      role: "user",
      content: [{ type: "text", text: "?" }],
    };
    tagBlocksSource(m5.content, "u4");
    await provider.sendMessage([m1!, m2!, m3!, empty, m5], {
      systemPrompt: "sys",
      config: { exportSourceIds: true },
    });
    const params = seen();
    expect(params?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
      "user",
    ]);
    expect(params?._vellum?.messages).toEqual([
      { index: 1, source_ids: ["u1"] },
      { index: 2, source_ids: ["a1"] },
      { index: 3, source_ids: ["u2/call_1"] },
      { index: 4, source_ids: ["u2/tail", "u3"] },
      { index: 5, source_ids: ["a2"] },
      { index: 6, source_ids: ["u4"] },
    ]);
  });

  test("exports the reserved reply row as reply_id (v3)", async () => {
    const { provider, seen } = captureProvider();
    await provider.sendMessage(taggedHistory(), {
      systemPrompt: "sys",
      config: { exportSourceIds: true, replyMessageId: "a9" },
    });
    expect(seen()?._vellum?.version).toBe(3);
    expect(seen()?._vellum?.reply_id).toBe("a9");
  });

  test("reply_id alone still yields a _vellum body (nothing else tagged)", async () => {
    const { provider, seen } = captureProvider();
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      {
        systemPrompt: "sys",
        config: { exportSourceIds: true, replyMessageId: "a1" },
      },
    );
    expect(seen()?._vellum).toEqual({
      version: 3,
      reply_id: "a1",
      messages: [],
    });
  });

  test("omits _vellum on a real upstream even when the profile sets the flag", async () => {
    const { provider, seen } = captureProvider("openrouter");
    await provider.sendMessage(taggedHistory(), {
      systemPrompt: "sys",
      config: { exportSourceIds: true },
    });
    expect(seen()).toBeDefined();
    expect(seen()?._vellum).toBeUndefined();
  });

  test("omits _vellum when exportSourceIds is not set", async () => {
    const { provider, seen } = captureProvider();
    await provider.sendMessage(taggedHistory(), { systemPrompt: "sys" });
    expect(seen()).toBeDefined();
    expect(seen()?._vellum).toBeUndefined();
  });

  test("omits _vellum when nothing is tagged", async () => {
    const { provider, seen } = captureProvider();
    await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { exportSourceIds: true } },
    );
    expect(seen()).toBeDefined();
    expect(seen()?._vellum).toBeUndefined();
  });
});
