import { describe, expect, it } from "vitest";

import {
  buildChatBody,
  chatErrorMessage,
  parseSseChunk,
  readChatStream,
  splitLines,
  type ChatEvent,
  type ChatParams,
} from "./chat";

/** The parameter object as the panel hands it over with nothing filled in. */
const NONE: ChatParams = {
  system: null,
  temperature: null,
  topP: null,
  maxTokens: null,
  seed: null,
  stream: true,
};

describe("buildChatBody", () => {
  it("omits every parameter the user did not set", () => {
    // Sending our own idea of a temperature would override the model's
    // generation config, so the panel would be testing us, not the deployment.
    const body = buildChatBody("granite-4.1-8b", [{ role: "user", content: "hi" }], NONE);

    expect(body).toEqual({
      model: "granite-4.1-8b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect("temperature" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
    expect("seed" in body).toBe(false);
  });

  it("sends a zero temperature rather than treating it as unset", () => {
    // Temperature 0 is the whole point of the determinism check; a truthiness
    // test here would silently drop it.
    const body = buildChatBody("m", [{ role: "user", content: "hi" }], {
      ...NONE,
      temperature: 0,
      seed: 0,
    });
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(0);
  });

  it("prepends the system prompt without putting it in the transcript", () => {
    const body = buildChatBody("m", [{ role: "user", content: "hi" }], {
      ...NONE,
      system: "You are terse.",
    });
    expect(body.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ]);
  });

  it("treats a whitespace-only system prompt as absent", () => {
    const body = buildChatBody("m", [{ role: "user", content: "hi" }], {
      ...NONE,
      system: "   \n ",
    });
    expect(body.messages).toHaveLength(1);
  });

  it("asks for usage only when streaming", () => {
    expect(buildChatBody("m", [], { ...NONE, stream: false }).stream_options).toBeUndefined();
  });

  it("maps parameters onto their wire names", () => {
    const body = buildChatBody("m", [], {
      system: null,
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 128,
      seed: 42,
      stream: false,
    });
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.9, max_tokens: 128, seed: 42 });
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Frames copied verbatim from a live vLLM 0.26 `/v1/chat/completions` stream
 * (granite-4.1-8b), only the ids and token counts shortened.
 *
 * Kept verbatim on purpose: the `prompt_token_ids`, `token_ids` and
 * `system_fingerprint` fields are not in the OpenAI schema, and a parser that
 * assumed the documented shape would be testing a stream vLLM never sends.
 */
const OPEN_FRAME =
  'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","created":1786304610,"model":"granite-4.1-8b","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],"prompt_token_ids":null,"prompt_text":null}';
const TEXT_FRAME =
  'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","created":1786304610,"model":"granite-4.1-8b","choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null,"token_ids":null}]}';
const STOP_FRAME =
  'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","created":1786304610,"model":"granite-4.1-8b","choices":[{"index":0,"delta":{"content":""},"logprobs":null,"finish_reason":"stop","stop_reason":null,"token_ids":null}]}';
const USAGE_FRAME =
  'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","created":1786304610,"model":"granite-4.1-8b","choices":[],"usage":{"prompt_tokens":17,"total_tokens":26,"completion_tokens":9},"system_fingerprint":"vllm-0.26.0-77852039"}';

describe("parseSseChunk", () => {
  it("reads a content delta", () => {
    expect(parseSseChunk(TEXT_FRAME)).toEqual({
      kind: "delta",
      text: "Hello",
      reasoning: false,
    });
  });

  it("ignores the role-only opening frame", () => {
    // Its content is the empty string. Appending it is harmless, but treating
    // it as the first token would report a TTFT measured before any work.
    expect(parseSseChunk(OPEN_FRAME)).toBeNull();
  });

  it("ignores the empty final choice frame", () => {
    expect(parseSseChunk(STOP_FRAME)).toBeNull();
  });

  it("reads the usage frame that arrives after the last choice", () => {
    expect(parseSseChunk(USAGE_FRAME)).toEqual({
      kind: "usage",
      usage: { promptTokens: 17, completionTokens: 9 },
    });
  });

  it("recognises the terminator", () => {
    expect(parseSseChunk("data: [DONE]")).toEqual({ kind: "done" });
  });

  it("returns null for lines that carry nothing", () => {
    // Frame separators, keep-alive comments, and fields a proxy may add. A
    // parser that threw on these would abort a healthy generation.
    expect(parseSseChunk("")).toBeNull();
    expect(parseSseChunk("\n")).toBeNull();
    expect(parseSseChunk(": ping")).toBeNull();
    expect(parseSseChunk("event: message")).toBeNull();
    expect(parseSseChunk("id: 7")).toBeNull();
    expect(parseSseChunk("data:")).toBeNull();
  });

  it("survives a frame it cannot parse", () => {
    // One unreadable frame costs one token; throwing would cost the response.
    expect(parseSseChunk('data: {"choices":[{"delta":')).toBeNull();
    expect(parseSseChunk("data: not json at all")).toBeNull();
  });

  it("carries reasoning content through, marked as such", () => {
    // A deployment behind --reasoning-parser leaves `content` empty until it
    // has finished thinking. Without this the panel looks hung.
    const frame =
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me check"},"finish_reason":null}]}';
    expect(parseSseChunk(frame)).toEqual({
      kind: "delta",
      text: "Let me check",
      reasoning: true,
    });
  });

  it("tolerates a null usage field", () => {
    expect(parseSseChunk('data: {"choices":[],"usage":null}')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("splitLines", () => {
  it("returns the incomplete tail rather than emitting it", () => {
    const { lines, rest } = splitLines('data: {"a":1}\ndata: {"b":');
    expect(lines).toEqual(['data: {"a":1}']);
    expect(rest).toBe('data: {"b":');
  });

  it("emits nothing when no line is complete", () => {
    const { lines, rest } = splitLines("data: partial");
    expect(lines).toEqual([]);
    expect(rest).toBe("data: partial");
  });
});

/* -------------------------------------------------------------------------- */

/** A stream that delivers exactly the given chunks, byte boundaries and all. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await readChatStream(streamOf(chunks), (e) => events.push(e));
  return events;
}

describe("readChatStream", () => {
  it("reassembles a frame split across chunk boundaries", async () => {
    // TCP chunk boundaries have nothing to do with newlines. Parsing each
    // chunk independently truncates responses at random points.
    const events = await collect([
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo, world"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([
      { kind: "delta", text: "Hello, world", reasoning: false },
      { kind: "done" },
    ]);
  });

  it("emits a final frame that arrived without a trailing newline", async () => {
    // Dropping the buffered tail loses the last token, or the usage block.
    const events = await collect([`${TEXT_FRAME}\n\n${USAGE_FRAME}`]);
    expect(events).toEqual([
      { kind: "delta", text: "Hello", reasoning: false },
      { kind: "usage", usage: { promptTokens: 17, completionTokens: 9 } },
    ]);
  });

  it("reads a whole exchange in order", async () => {
    const events = await collect([
      [OPEN_FRAME, "", TEXT_FRAME, "", STOP_FRAME, "", USAGE_FRAME, "", "data: [DONE]", "", ""].join(
        "\n",
      ),
    ]);
    expect(events).toEqual([
      { kind: "delta", text: "Hello", reasoning: false },
      { kind: "usage", usage: { promptTokens: 17, completionTokens: 9 } },
      { kind: "done" },
    ]);
  });

  it("handles a multi-byte character split across chunks", async () => {
    // The decoder must be in streaming mode, or a UTF-8 sequence cut in half
    // becomes a replacement character in the middle of a word.
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"choices":[{"delta":{"content":"héllo"}}]}\n');
    const cut = 40; // lands inside the two-byte é
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const events: ChatEvent[] = [];
    await readChatStream(stream, (e) => events.push(e));
    expect(events).toEqual([{ kind: "delta", text: "héllo", reasoning: false }]);
  });
});

/* -------------------------------------------------------------------------- */

describe("chatErrorMessage", () => {
  it("unwraps vLLM's nested error object", () => {
    // Verbatim from vLLM 0.26 when max_tokens exceeds the context length. The
    // engine's own wording is far more useful than anything we could write.
    const body =
      '{"error":{"message":"max_tokens=99999 cannot be greater than max_model_len=max_total_tokens=4096. Please request fewer output tokens. (parameter=max_tokens, value=99999)","type":"BadRequestError","param":"max_tokens","code":400}}';
    expect(chatErrorMessage(body, 400)).toBe(
      "max_tokens=99999 cannot be greater than max_model_len=max_total_tokens=4096. Please request fewer output tokens. (parameter=max_tokens, value=99999)",
    );
  });

  it("prefers the nested message over a top-level one", () => {
    const body = JSON.stringify({
      object: "error",
      message: "ignored in favour of the nested one",
      error: { message: "The specific reason.", type: "BadRequest" },
    });
    expect(chatErrorMessage(body, 400)).toBe("The specific reason.");
  });

  it("falls back to a top-level message", () => {
    const body = JSON.stringify({ object: "error", message: "Bad request.", code: 400 });
    expect(chatErrorMessage(body, 400)).toBe("Bad request.");
  });

  it("passes a plain-text body through", () => {
    expect(chatErrorMessage("Internal Server Error", 500)).toBe("Internal Server Error");
  });

  it("names the status when the body says nothing", () => {
    expect(chatErrorMessage("", 503)).toBe("The engine rejected the request (503).");
    expect(chatErrorMessage("{}", 503)).toBe("The engine rejected the request (503).");
  });
});
