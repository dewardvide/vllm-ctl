"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_CHAT_PARAMS,
  readChatStream,
  type ChatMessage,
  type ChatParams,
  type ChatRole,
} from "@/lib/vllm/chat";

/**
 * A chat exchange against one deployment.
 *
 * Deliberately not built on `useSse`: that hook wraps `EventSource`, which can
 * only issue GET requests, and a chat turn has a body. This reads the response
 * stream directly, which also means one `AbortController` cancels the whole
 * chain — fetch, proxy route, engine request.
 *
 * State is in memory and dies with the page. This is an instrument for checking
 * that a deployment answers sensibly, not a chat client with history.
 */

export interface ChatTurn {
  id: number;
  role: ChatRole;
  content: string;
  /** Chain-of-thought from a reasoning-parser deployment, kept apart. */
  reasoning: string;
  /** Time to first token, measured client side, so it includes the proxy hop. */
  ttftMs: number | null;
  /** Output tokens per second over the generation window. */
  tokPerS: number | null;
  completionTokens: number | null;
  promptTokens: number | null;
  /** True while this turn is still being written. */
  pending: boolean;
  stopped: boolean;
  error: string | null;
}

export interface UseChat {
  turns: ChatTurn[];
  params: ChatParams;
  setParams: (next: ChatParams) => void;
  streaming: boolean;
  send: (text: string) => void;
  stop: () => void;
  reset: () => void;
}

export function useChat(runId: number): UseChat {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [params, setParams] = useState<ChatParams>(DEFAULT_CHAT_PARAMS);
  const [streaming, setStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  // Deltas are buffered and flushed on an animation frame. A fast deployment
  // emits several hundred tokens a second; re-rendering the transcript that
  // often would make the panel above it stutter for no visible gain, since the
  // display cannot show more than one frame at a time anyway.
  const pending = useRef<{ content: string; reasoning: string }>({
    content: "",
    reasoning: "",
  });
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    const { content, reasoning } = pending.current;
    if (!content && !reasoning) return;
    pending.current = { content: "", reasoning: "" };
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (!last.pending) return prev;
      return [
        ...prev.slice(0, -1),
        {
          ...last,
          content: last.content + content,
          reasoning: last.reasoning + reasoning,
        },
      ];
    });
  }, []);

  const schedule = useCallback(() => {
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(flush);
  }, [flush]);

  // Abort in flight work when the page unmounts or the run changes, so a
  // navigation does not leave the engine generating into nothing.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [runId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    pending.current = { content: "", reasoning: "" };
    setTurns([]);
  }, []);

  const send = useCallback(
    (text: string) => {
      const prompt = text.trim();
      if (!prompt || streaming) return;

      const userTurn = blankTurn(nextId.current++, "user");
      userTurn.content = prompt;
      const reply = blankTurn(nextId.current++, "assistant");
      reply.pending = true;

      // The transcript to send is what the model has already seen plus this
      // prompt. Reasoning text is excluded on purpose: vLLM's chat templates
      // expect it gone from prior turns, and echoing it back changes behaviour.
      const history: ChatMessage[] = turns
        .filter((t) => !t.error && t.content !== "")
        .map((t) => ({ role: t.role, content: t.content }));
      history.push({ role: "user", content: prompt });

      setTurns((prev) => [...prev, userTurn, reply]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      void run({
        runId,
        history,
        params,
        controller,
        onFirstToken: (ttftMs) => finish(reply.id, { ttftMs }),
        onDelta: (chunk, reasoning) => {
          if (reasoning) pending.current.reasoning += chunk;
          else pending.current.content += chunk;
          schedule();
        },
        onEnd: (result) => {
          flush();
          finish(reply.id, { ...result, pending: false });
          setStreaming(false);
          abortRef.current = null;
        },
      });

      function finish(id: number, patch: Partial<ChatTurn>) {
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      }
    },
    [flush, params, runId, schedule, streaming, turns],
  );

  return { turns, params, setParams, streaming, send, stop, reset };
}

function blankTurn(id: number, role: ChatRole): ChatTurn {
  return {
    id,
    role,
    content: "",
    reasoning: "",
    ttftMs: null,
    tokPerS: null,
    completionTokens: null,
    promptTokens: null,
    pending: false,
    stopped: false,
    error: null,
  };
}

/* -------------------------------------------------------------------------- */

interface RunArgs {
  runId: number;
  history: ChatMessage[];
  params: ChatParams;
  controller: AbortController;
  onFirstToken: (ttftMs: number) => void;
  onDelta: (chunk: string, reasoning: boolean) => void;
  onEnd: (result: Partial<ChatTurn>) => void;
}

/** Issues the request and reports timing. Kept out of the hook for legibility. */
async function run(args: RunArgs): Promise<void> {
  const { runId, history, params, controller } = args;
  const sentAt = performance.now();
  let firstTokenAt: number | null = null;
  let deltaCount = 0;
  let completionTokens: number | null = null;
  let promptTokens: number | null = null;

  const markFirstToken = () => {
    if (firstTokenAt != null) return;
    firstTokenAt = performance.now();
    args.onFirstToken(firstTokenAt - sentAt);
  };

  try {
    const res = await fetch("/api/deployments/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, messages: history, params }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      args.onEnd({ error: body?.error ?? `Request failed (${res.status}).` });
      return;
    }

    if (!params.stream) {
      const body = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string; reasoning?: string; reasoning_content?: string };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      markFirstToken();
      const message = body.choices?.[0]?.message;
      // Streaming deltas call it `reasoning_content`; the non-streamed message
      // object calls it `reasoning`. Same field, two names, both observed on
      // vLLM 0.26.
      args.onDelta(message?.reasoning ?? message?.reasoning_content ?? "", true);
      args.onDelta(message?.content ?? "", false);
      args.onEnd({
        ...rate(firstTokenAt, body.usage?.completion_tokens ?? null, 0),
        completionTokens: body.usage?.completion_tokens ?? null,
        promptTokens: body.usage?.prompt_tokens ?? null,
      });
      return;
    }

    if (!res.body) {
      args.onEnd({ error: "The engine returned an empty response." });
      return;
    }

    await readChatStream(res.body, (event) => {
      if (event.kind === "delta") {
        markFirstToken();
        deltaCount++;
        args.onDelta(event.text, event.reasoning);
      } else if (event.kind === "usage") {
        completionTokens = event.usage.completionTokens;
        promptTokens = event.usage.promptTokens;
      }
    });

    args.onEnd({
      ...rate(firstTokenAt, completionTokens, deltaCount),
      completionTokens,
      promptTokens,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      args.onEnd({
        stopped: true,
        ...rate(firstTokenAt, completionTokens, deltaCount),
      });
      return;
    }
    args.onEnd({ error: (err as Error).message });
  }
}

/**
 * Output rate over the generation window — first token to now, not send to now.
 *
 * Including the prefill would blend two different quantities and report a
 * number that falls as the prompt grows, which is what TTFT is for.
 */
function rate(
  firstTokenAt: number | null,
  completionTokens: number | null,
  deltaCount: number,
): Partial<ChatTurn> {
  if (firstTokenAt == null) return { tokPerS: null };
  const seconds = (performance.now() - firstTokenAt) / 1000;
  // Prefer the engine's own count; a delta is not reliably one token.
  const tokens = completionTokens ?? deltaCount;
  if (seconds <= 0 || tokens <= 1) return { tokPerS: null };
  return { tokPerS: (tokens - 1) / seconds };
}
