"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Subscribe to a server-sent event stream.
 *
 * Handlers are read through a ref so a parent re-render never tears down and
 * re-establishes the connection — reconnecting a telemetry stream on every
 * render would defeat the whole point of pushing instead of polling. The ref
 * is written in an effect rather than during render, so the hook stays safe
 * under concurrent rendering.
 */
export type SseHandlers = Record<string, (data: unknown) => void>;

export type SseState = "connecting" | "open" | "closed";

export function useSse(url: string | null, handlers: SseHandlers): SseState {
  const [state, setState] = useState<SseState>("connecting");
  const handlersRef = useRef<SseHandlers>(handlers);

  // Declared before the connection effect so the latest handlers are in place
  // by the time any event can be delivered.
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);

    es.onopen = () => setState("open");
    es.onerror = () => {
      // EventSource reconnects on its own; surface the gap without tearing down.
      setState((s) => (s === "open" ? "connecting" : s));
    };

    const listeners: Array<[string, EventListener]> = [];
    for (const name of Object.keys(handlersRef.current)) {
      const fn: EventListener = (ev) => {
        const msg = ev as MessageEvent;
        try {
          handlersRef.current[name]?.(JSON.parse(msg.data));
        } catch {
          /* a malformed frame must not kill the listener */
        }
      };
      es.addEventListener(name, fn);
      listeners.push([name, fn]);
    }

    return () => {
      for (const [name, fn] of listeners) es.removeEventListener(name, fn);
      es.close();
    };
  }, [url]);

  return url ? state : "closed";
}
