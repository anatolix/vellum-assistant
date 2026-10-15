import { OpenAIChatCompletionsProvider } from "../../providers/openai/chat-completions-provider.js";
import type { Message } from "../../providers/types.js";

type WireRequest = {
  messages: { role: string; content?: unknown }[];
  _vellum?: { messages: { index: number; source_ids: string[] }[] };
};

/** Capture the next provider request without making an upstream call. */
export async function captureSourceIdWire(
  messages: Message[],
): Promise<WireRequest> {
  const provider = new OpenAIChatCompletionsProvider("test-key", "test-model", {
    providerName: "openai-compatible",
  });
  let captured: WireRequest | undefined;
  (
    provider as unknown as {
      client: {
        chat: {
          completions: {
            create: (params: WireRequest) => Promise<AsyncIterable<unknown>>;
          };
        };
      };
    }
  ).client.chat.completions.create = async (params) => {
    captured = params;
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    };
  };
  await provider.sendMessage(messages, {
    systemPrompt: "system",
    config: { exportSourceIds: true },
  });
  if (!captured) {
    throw new Error("Provider did not create a request");
  }
  return captured;
}
