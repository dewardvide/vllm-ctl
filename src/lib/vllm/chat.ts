/**
 * The OpenAI chat-completions wire format, as vLLM speaks it.
 *
 * Pure and dependency-free, like `argv.ts` and `host.ts`, so the route handler
 * that builds the request and the client hook that reads the response share one
 * definition of the protocol instead of each carrying half of it.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Sampling parameters, every one of them optional.
 *
 * `null` means "don't send it", not "send zero". A model ships its own
 * generation config, and putting a UI's idea of a sensible temperature on the
 * wire would silently override it — the panel would be testing our defaults
 * rather than the deployment's.
 */
export interface ChatParams {
  system: string | null;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  seed: number | null;
  stream: boolean;
}

export const DEFAULT_CHAT_PARAMS: ChatParams = {
  system: null,
  temperature: null,
  topP: null,
  maxTokens: null,
  seed: null,
  stream: true,
};

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  seed?: number;
}

/**
 * The request body for one exchange.
 *
 * `messages` is the transcript so far; the system prompt is prepended here
 * rather than being kept in the transcript, so editing it applies to the whole
 * conversation retroactively — which is what you want when you are probing how
 * a deployment responds to different instructions.
 */
export function buildChatBody(
  model: string,
  messages: ChatMessage[],
  params: ChatParams,
): ChatRequestBody {
  const system = params.system?.trim();
  const body: ChatRequestBody = {
    model,
    messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    stream: params.stream,
  };

  // Ask for the usage block on the final frame. It carries the engine's own
  // token counts, which beats counting deltas — a delta is not a token.
  if (params.stream) body.stream_options = { include_usage: true };

  if (params.temperature != null) body.temperature = params.temperature;
  if (params.topP != null) body.top_p = params.topP;
  if (params.maxTokens != null) body.max_tokens = params.maxTokens;
  if (params.seed != null) body.seed = params.seed;

  return body;
}

/* -------------------------------------------------------------------------- */
/* stream parsing                                                              */
/* -------------------------------------------------------------------------- */

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export type ChatEvent =
  | { kind: "delta"; text: string; reasoning: boolean }
  | { kind: "usage"; usage: ChatUsage }
  | { kind: "done" };

/**
 * One line of the SSE body → an event, or `null` for a line that carries none.
 *
 * Returning `null` rather than throwing is deliberate: the stream is full of
 * lines that mean nothing — blank separators between frames, `:` keep-alive
 * comments, and any `event:` or `id:` field a proxy decides to add. A parser
 * that treated those as errors would abort a perfectly healthy generation.
 *
 * Callers must only pass *complete* lines. A JSON payload split across two
 * network chunks is the classic way to get a truncated response that looks
 * like a model failure; see `readChatStream` for the buffering that prevents it.
 */
export function parseSseChunk(line: string): ChatEvent | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;

  const payload = trimmed.slice("data:".length).trim();
  if (payload === "") return null;
  if (payload === "[DONE]") return { kind: "done" };

  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    // A frame we cannot read is not worth killing the stream over; the next
    // one is very likely fine, and the transcript degrades by one token.
    return null;
  }

  const choice = (frame as ChatFrame)?.choices?.[0];
  const delta = choice?.delta;

  if (typeof delta?.content === "string" && delta.content !== "") {
    return { kind: "delta", text: delta.content, reasoning: false };
  }

  // Models served behind a reasoning parser put their chain of thought in
  // `reasoning_content` and leave `content` empty until they are done. Without
  // this branch such a deployment looks hung for its entire thinking budget.
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
    return { kind: "delta", text: delta.reasoning_content, reasoning: true };
  }

  // The usage frame arrives after the last choice, with `choices: []`.
  const usage = (frame as ChatFrame)?.usage;
  if (usage && typeof usage.completion_tokens === "number") {
    return {
      kind: "usage",
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens,
      },
    };
  }

  return null;
}

interface ChatFrame {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * Splits a stream chunk into complete lines, returning the incomplete tail.
 *
 * The tail must be carried into the next call. This is the whole reason the
 * function exists: `\n` boundaries and TCP chunk boundaries have nothing to do
 * with each other, so a chunk routinely ends mid-JSON.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/**
 * Reads a chat SSE body to completion, calling `onEvent` for each event.
 *
 * Lives here rather than in the hook so it can be tested without a DOM: give it
 * any `ReadableStream` and it behaves exactly as it does against the engine.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = splitLines(buffer);
      buffer = rest;
      for (const line of lines) {
        const event = parseSseChunk(line);
        if (event) onEvent(event);
      }
    }
    // A stream that ends without a trailing newline leaves one final frame in
    // the buffer. Dropping it loses the last token, or the usage block.
    const last = parseSseChunk(buffer);
    if (last) onEvent(last);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pulls the human-readable message out of an OpenAI-shaped error body.
 *
 * vLLM nests it as `{ error: { message } }`, but returns a bare `{ message }`
 * for some validation failures, and occasionally plain text. All three end up
 * in front of the same person, so all three are unwrapped here.
 */
export function chatErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") {
      if (parsed.error) return parsed.error;
    } else if (parsed.error?.message) {
      return parsed.error.message;
    }
    if (parsed.message) return parsed.message;
  } catch {
    if (body.trim()) return body.trim().slice(0, 400);
  }
  return `The engine rejected the request (${status}).`;
}
