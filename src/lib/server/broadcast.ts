import "server-only";

/**
 * A tiny fan-out hub for server-sent events.
 *
 * One producer (the sampler, a log stream, a benchmark runner) publishes to a
 * named topic; every connected browser tab subscribes to it. The cost of an
 * extra viewer is one more `enqueue` call, not another `nvidia-smi` process —
 * this is the mechanism behind "one sampler, many viewers".
 */

type Listener = (event: string, data: unknown) => void;

class Hub {
  private topics = new Map<string, Set<Listener>>();

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.topics.delete(topic);
    };
  }

  publish(topic: string, event: string, data: unknown): void {
    const set = this.topics.get(topic);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event, data);
      } catch {
        // A dead client must never take down the producer loop.
      }
    }
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }
}

declare global {
  var __vllmAdminHub: Hub | undefined;
}

export function hub(): Hub {
  if (!globalThis.__vllmAdminHub) globalThis.__vllmAdminHub = new Hub();
  return globalThis.__vllmAdminHub;
}

/* -------------------------------------------------------------------------- */

export interface SseOptions {
  /** Sent immediately on connect so the client paints without waiting a tick. */
  initial?: () => { event: string; data: unknown } | null;
  /** Comment ping period. Keeps proxies and browsers from closing the stream. */
  heartbeatMs?: number;
  /** Called once when the first subscriber attaches — used to start producers. */
  onOpen?: () => void;
}

/**
 * Builds a `Response` that streams a topic to the browser as SSE.
 */
export function sseResponse(topic: string, opts: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      opts.onOpen?.();

      const first = opts.initial?.();
      if (first) send(first.event, first.data);

      unsubscribe = hub().subscribe(topic, send);

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, heartbeatMs);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defensive: stops nginx buffering if the user ever puts one in front.
      "X-Accel-Buffering": "no",
    },
  });
}
