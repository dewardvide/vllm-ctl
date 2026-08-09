"use client";

import type { ReactNode } from "react";

import { TelemetryProvider } from "@/lib/client/telemetry-store";
import { DeploymentsProvider, useDeployments } from "@/lib/client/deployments-store";

import { CommandBar } from "./CommandBar";
import { HeadroomRail } from "./HeadroomRail";

/**
 * The chassis every screen sits in: command bar, headroom rail, content.
 *
 * Both live streams are opened once here rather than per-page, so navigating
 * between screens never drops or re-establishes a connection.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <TelemetryProvider>
      <DeploymentsProvider>
        <Chassis>{children}</Chassis>
      </DeploymentsProvider>
    </TelemetryProvider>
  );
}

function Chassis({ children }: { children: ReactNode }) {
  const { live, projection } = useDeployments();

  const segments = [
    ...live
      .filter((d) => d.vramMiB != null && d.vramMiB > 0)
      .map((d) => ({
        id: `run-${d.runId}`,
        label: d.servedName ?? d.name,
        mib: d.vramMiB as number,
      })),
    ...(projection
      ? [{ id: "projection", label: projection.label, mib: projection.mib, ghost: true }]
      : []),
  ];

  const runningCount = live.filter(
    (d) => d.status === "healthy" || d.status === "loading" || d.status === "starting",
  ).length;

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      <CommandBar runningCount={runningCount} />
      <HeadroomRail segments={segments} />
      <main className="flex-1 min-h-0 overflow-auto">{children}</main>
    </div>
  );
}
