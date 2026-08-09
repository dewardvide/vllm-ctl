"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { TelemetrySample } from "@/lib/types";
import { useSse } from "./use-sse";

/**
 * Client-side mirror of the server's telemetry window.
 *
 * One EventSource serves the whole page: charts and readouts all read from
 * this store rather than each opening their own stream.
 *
 * The window is held in React state rather than a mutable ref. At 1 Hz with a
 * 900-sample cap, appending is one array copy per second — immeasurable — and
 * it keeps the store safe to read during render, which a ref would not be.
 */

const WINDOW = 900;

interface TelemetryStore {
  /** Rolling window, oldest first. */
  samples: TelemetrySample[];
  latest: TelemetrySample | null;
  connected: boolean;
  gpuUnavailableReason: string | null;
}

const Ctx = createContext<TelemetryStore | null>(null);

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [gpuUnavailableReason, setGpuUnavailable] = useState<string | null>(null);

  const onHistory = useCallback((d: unknown) => {
    const payload = d as {
      samples: TelemetrySample[];
      gpuUnavailableReason: string | null;
    };
    setSamples(payload.samples ?? []);
    setGpuUnavailable(payload.gpuUnavailableReason ?? null);
  }, []);

  const onSample = useCallback((d: unknown) => {
    const s = d as TelemetrySample;
    setSamples((prev) => {
      const next = prev.length >= WINDOW ? prev.slice(prev.length - WINDOW + 1) : prev.slice();
      next.push(s);
      return next;
    });
  }, []);

  const state = useSse("/api/stream/telemetry?history=900", {
    history: onHistory,
    sample: onSample,
  });

  const value = useMemo<TelemetryStore>(
    () => ({
      samples,
      latest: samples.length > 0 ? samples[samples.length - 1] : null,
      connected: state === "open",
      gpuUnavailableReason,
    }),
    [samples, state, gpuUnavailableReason],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTelemetry(): TelemetryStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTelemetry must be used inside <TelemetryProvider>");
  return v;
}
