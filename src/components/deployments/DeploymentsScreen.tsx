"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import { useDeployments } from "@/lib/client/deployments-store";
import { dateTime, sinceStr } from "@/lib/format";
import type { DeploymentProfile } from "@/lib/types";
import { Button, Empty, Panel, Problem, StatusDot } from "@/components/ui/primitives";

import { DeploymentCard } from "@/components/dashboard/DeploymentCard";

/** Running instances above, saved profiles below. */
export function DeploymentsScreen() {
  const { live, refresh } = useDeployments();
  const [profiles, setProfiles] = useState<DeploymentProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ profiles: DeploymentProfile[] }>("/api/deployments");
      setProfiles(r.profiles);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const stop = async (runId: number) => {
    setBusy(runId);
    try {
      await api.post("/api/deployments/stop", { runId });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const start = async (profile: DeploymentProfile) => {
    setBusy(-profile.id);
    setError(null);
    try {
      await api.post("/api/deployments/start", { deploymentId: profile.id });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.del(`/api/deployments/${id}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col">
      {error && <Problem>{error}</Problem>}

      <Panel
        label={`running · ${live.length}`}
        ticked={live.length > 0}
        actions={
          <Link href="/deployments/new">
            <Button tone="primary">new deployment</Button>
          </Link>
        }
      >
        {live.length === 0 ? (
          <Empty title="Nothing is running." hint="Start a saved profile below, or configure a new deployment." />
        ) : (
          live.map((d) => (
            <DeploymentCard key={d.runId} d={d} onStop={stop} busy={busy === d.runId} />
          ))
        )}
      </Panel>

      <Panel label={`saved profiles · ${profiles.length}`}>
        {profiles.length === 0 ? (
          <Empty
            title="No saved profiles."
            hint="Save a configuration once and you can relaunch it with the same 274 options every time."
          />
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="plate">
                <th className="text-left font-normal px-3 py-1.5">name</th>
                <th className="text-left font-normal px-3 py-1.5">model</th>
                <th className="text-right font-normal px-3 py-1.5 w-20">port</th>
                <th className="text-right font-normal px-3 py-1.5 w-24">options</th>
                <th className="text-right font-normal px-3 py-1.5 w-32">updated</th>
                <th className="w-44" />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => {
                const running = live.find((d) => d.deploymentId === p.id);
                return (
                  <tr key={p.id} className="hairline-t hover:bg-panel transition-colors">
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <StatusDot status={running ? running.status : "idle"} />
                        {p.name}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 truncate max-w-0 text-ink-dim">{p.model}</td>
                    <td className="px-3 py-1.5 text-right num text-ink-faint">
                      {p.port ?? "auto"}
                    </td>
                    <td className="px-3 py-1.5 text-right num text-ink-faint">
                      {Object.keys(p.flags).length}
                    </td>
                    <td className="px-3 py-1.5 text-right plate">{dateTime(p.updatedAt)}</td>
                    <td className="px-3 py-1.5">
                      <span className="flex gap-1 justify-end">
                        <Link href={`/deployments/new?profile=${p.id}`}>
                          <Button>edit</Button>
                        </Link>
                        {running ? (
                          <Button tone="danger" onClick={() => stop(running.runId)}>
                            stop
                          </Button>
                        ) : (
                          <Button
                            tone="primary"
                            onClick={() => start(p)}
                            disabled={busy === -p.id}
                          >
                            {busy === -p.id ? "starting" : "start"}
                          </Button>
                        )}
                        <Button tone="danger" onClick={() => remove(p.id)}>
                          delete
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <RunHistory />
    </div>
  );
}

interface HistoryRow {
  id: number;
  model: string | null;
  port: number;
  status: string;
  started_at: number;
  stopped_at: number | null;
  error: string | null;
}

function RunHistory() {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  useEffect(() => {
    api
      .get<{ runs: HistoryRow[] }>("/api/deployments/history")
      .then((r) => setRows(r.runs))
      .catch(() => setRows([]));
  }, []);

  if (rows.length === 0) return null;

  return (
    <Panel label="run history">
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="hairline-t">
              <td className="px-3 py-1.5 w-24 plate">{r.status}</td>
              <td className="px-3 py-1.5 truncate max-w-0 text-ink-dim">
                {r.model ?? "—"}
              </td>
              <td className="px-3 py-1.5 text-right num text-ink-faint w-20">:{r.port}</td>
              <td className="px-3 py-1.5 text-right plate w-32">
                {dateTime(r.started_at)}
              </td>
              <td className="px-3 py-1.5 text-right plate w-24">
                {r.stopped_at ? sinceStr(r.stopped_at) + " ago" : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
