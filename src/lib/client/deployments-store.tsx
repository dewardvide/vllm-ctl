"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { LiveDeployment } from "@/lib/types";
import { useSse } from "./use-sse";

/**
 * Live supervised deployments, streamed from the server.
 *
 * Also holds the *projection*: a hypothetical VRAM footprint published by the
 * deployment form while you are choosing settings. Keeping it here is what lets
 * the headroom rail in the shell show a ghost segment for a deployment that
 * does not exist yet.
 */

export interface Projection {
  label: string;
  mib: number;
}

interface DeploymentsStore {
  live: LiveDeployment[];
  connected: boolean;
  projection: Projection | null;
  setProjection: (p: Projection | null) => void;
  /** Force an immediate refresh after a mutation, without waiting for a tick. */
  refresh: () => void;
}

const Ctx = createContext<DeploymentsStore | null>(null);

export function DeploymentsProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<LiveDeployment[]>([]);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [nonce, setNonce] = useState(0);

  const state = useSse(`/api/stream/deployments?n=${nonce}`, {
    state: (d) => setLive((d as { live: LiveDeployment[] }).live ?? []),
  });

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<DeploymentsStore>(
    () => ({
      live,
      connected: state === "open",
      projection,
      setProjection,
      refresh,
    }),
    [live, state, projection, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDeployments(): DeploymentsStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDeployments must be used inside <DeploymentsProvider>");
  return v;
}
