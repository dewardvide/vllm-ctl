"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/lib/client/api";
import { useSse } from "@/lib/client/use-sse";
import { bytesStr, compact, dateTime, int } from "@/lib/format";
import { THERMAL } from "@/lib/thermal";
import type { CachedRepo, DownloadJob, HubSearchResult } from "@/lib/types";
import {
  Button,
  Empty,
  Meter,
  Panel,
  Problem,
  Readout,
} from "@/components/ui/primitives";

import { ModelDetail } from "./ModelDetail";

/**
 * Models: what is on disk, what is downloading, and what could be.
 *
 * Local cache leads because that is what costs disk and what you deploy from;
 * search is a panel beside it rather than the main event.
 */
export function ModelsScreen() {
  const [repos, setRepos] = useState<CachedRepo[]>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadCache = useCallback(async () => {
    try {
      const r = await api.get<{ repos: CachedRepo[] }>("/api/models/cache");
      setRepos(r.repos);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Kick the first load on a microtask so the effect body itself performs no
    // synchronous state update.
    void Promise.resolve().then(loadCache);
  }, [loadCache]);

  useSse("/api/stream/downloads", {
    state: (d) => {
      const next = (d as { downloads: DownloadJob[] }).downloads ?? [];
      setJobs(next);
      // A finished download changes what is on disk.
      if (next.some((j) => j.status === "completed")) void loadCache();
    },
  });

  const active = jobs.filter((j) => j.status === "running");
  const models = useMemo(
    () => repos.filter((r) => r.repoType === "model"),
    [repos],
  );
  const others = useMemo(
    () => repos.filter((r) => r.repoType !== "model"),
    [repos],
  );
  const totalBytes = repos.reduce((a, r) => a + r.sizeBytes, 0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] min-h-full">
      <div className="min-w-0 flex flex-col">
        {error && <Problem>{error}</Problem>}

        {active.length > 0 && (
          <Panel label={`downloading · ${active.length}`} ticked>
            {active.map((j) => (
              <DownloadRow key={j.id} job={j} />
            ))}
          </Panel>
        )}

        <Panel
          label={`local models · ${models.length}`}
          actions={<span className="plate">{bytesStr(totalBytes)} on disk</span>}
        >
          {loading ? (
            <p className="px-3 py-6 plate">reading cache</p>
          ) : models.length === 0 ? (
            <Empty
              title="No models downloaded yet."
              hint="Search Hugging Face on the right, or paste a repository id to fetch one."
            />
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="plate">
                  <th className="text-left font-normal px-3 py-1.5">model</th>
                  <th className="text-right font-normal px-3 py-1.5 w-24">size</th>
                  <th className="text-right font-normal px-3 py-1.5 w-20">revs</th>
                  <th className="text-right font-normal px-3 py-1.5 w-32">updated</th>
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {models.map((r) => (
                  <CacheRow
                    key={r.repoId}
                    repo={r}
                    selected={selected === r.repoId}
                    onSelect={() => setSelected(r.repoId)}
                    onDeleted={loadCache}
                    onError={setError}
                  />
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {others.length > 0 && (
          <Panel label={`datasets · ${others.length}`}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="plate">
                  <th className="text-left font-normal px-3 py-1.5">dataset</th>
                  <th className="text-right font-normal px-3 py-1.5 w-24">size</th>
                  <th className="text-right font-normal px-3 py-1.5 w-20">revs</th>
                  <th className="text-right font-normal px-3 py-1.5 w-32">updated</th>
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {others.map((r) => (
                  <CacheRow
                    key={r.repoId}
                    repo={r}
                    selected={false}
                    onSelect={() => {}}
                    onDeleted={loadCache}
                    onError={setError}
                  />
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>

      <div className="xl:hairline-l min-w-0 flex flex-col">
        {selected ? (
          <ModelDetail repo={selected} onClose={() => setSelected(null)} />
        ) : (
          <SearchPanel
            cachedIds={new Set(models.map((m) => m.repoId))}
            onInspect={setSelected}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CacheRow({
  repo,
  selected,
  onSelect,
  onDeleted,
  onError,
}: {
  repo: CachedRepo;
  selected: boolean;
  onSelect: () => void;
  onDeleted: () => void;
  onError: (m: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await api.del("/api/models/cache", {
        repoId: repo.repoId,
        repoType: repo.repoType,
      });
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <tr
      className={`hairline-t cursor-pointer transition-colors ${
        selected ? "bg-panel-hi" : "hover:bg-panel"
      }`}
      onClick={onSelect}
    >
      <td className="px-3 py-1.5 truncate max-w-0">
        {/* Some repos have no organisation prefix (`gpt2`), and rendering an
            unconditional "org/" leaves a stray trailing slash. */}
        {repo.repoId.includes("/") ? (
          <>
            <span className="text-ink-faint">{repo.repoId.split("/")[0]}/</span>
            <span>{repo.repoId.split("/").slice(1).join("/")}</span>
          </>
        ) : (
          <span>{repo.repoId}</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right num text-ink-dim">
        {bytesStr(repo.sizeBytes)}
      </td>
      <td className="px-3 py-1.5 text-right num text-ink-faint">
        {repo.revisions.length}
      </td>
      <td className="px-3 py-1.5 text-right plate">
        {repo.revisions[0] ? dateTime(repo.revisions[0].lastModified) : "—"}
      </td>
      <td className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
        {confirming ? (
          <span className="flex gap-1 justify-end">
            <Button tone="danger" onClick={remove} disabled={busy}>
              {busy ? "deleting" : "confirm"}
            </Button>
            <Button onClick={() => setConfirming(false)}>keep</Button>
          </span>
        ) : (
          <Button tone="danger" onClick={() => setConfirming(true)}>
            delete
          </Button>
        )}
      </td>
    </tr>
  );
}

function DownloadRow({ job }: { job: DownloadJob }) {
  const cancel = () => void api.del("/api/models/download", { id: job.id }).catch(() => {});
  return (
    <div className="hairline-t px-3 py-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] truncate flex-1">{job.repo}</span>
        <span className="num text-[11px] text-ink-dim">{job.pct.toFixed(0)}%</span>
        <Button tone="danger" onClick={cancel}>
          cancel
        </Button>
      </div>
      <Meter value={job.pct} color={THERMAL.t2} height={3} />
      <span className="plate truncate">
        {job.message ?? "starting"}
        {job.bytesTotal
          ? ` · ${bytesStr(job.bytesDone)} of ${bytesStr(job.bytesTotal)}`
          : ""}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SearchPanel({
  cachedIds,
  onInspect,
  onError,
}: {
  cachedIds: Set<string>;
  onInspect: (repo: string) => void;
  onError: (m: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const q = query.trim();
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      if (q.length < 2) {
        setResults([]);
        return;
      }
      setTouched(true);
      setSearching(true);
      try {
        const r = await api.get<{ results: HubSearchResult[] }>(
          `/api/models/search?q=${encodeURIComponent(q)}`,
        );
        if (!ctl.signal.aborted) setResults(r.results);
      } catch (e) {
        if (!ctl.signal.aborted) onError((e as Error).message);
      } finally {
        if (!ctl.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      ctl.abort();
      clearTimeout(t);
    };
  }, [query, onError]);

  const download = async (repo: string) => {
    try {
      await api.post("/api/models/download", { repo });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <Panel label="hugging face">
      <div className="px-3 pb-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models, or paste a repository id"
          aria-label="Search Hugging Face models"
        />
      </div>

      {query.trim().length >= 2 && query.includes("/") && (
        <div className="px-3 pb-2 flex items-center gap-2">
          <span className="plate flex-1 truncate">fetch {query.trim()}</span>
          <Button tone="primary" onClick={() => download(query.trim())}>
            download
          </Button>
        </div>
      )}

      {searching && <p className="px-3 py-2 plate">searching</p>}

      {!searching && touched && results.length === 0 && query.trim().length >= 2 && (
        <Empty
          title="Nothing matched."
          hint="Try the organisation name, or paste the full repository id."
        />
      )}

      {!touched && (
        <Empty
          title="Find a model to run."
          hint="Quantized builds (AWQ, GPTQ, FP8) fit far more context on a 24 GB card than bf16 weights do."
        />
      )}

      <ul>
        {results.map((r) => (
          <li key={r.repoId} className="hairline-t">
            <div className="px-3 py-2 flex flex-col gap-1 hover:bg-panel transition-colors">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onInspect(r.repoId)}
                  className="text-[12px] truncate flex-1 text-left hover:text-signal transition-colors"
                >
                  {r.repoId}
                </button>
                {cachedIds.has(r.repoId) ? (
                  <span className="plate" style={{ color: THERMAL.t2 }}>
                    on disk
                  </span>
                ) : (
                  <Button onClick={() => download(r.repoId)}>get</Button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="plate">↓ {compact(r.downloads)}</span>
                <span className="plate">♥ {int(r.likes)}</span>
                {r.quantization && (
                  <span className="plate" style={{ color: THERMAL.t3 }}>
                    {r.quantization}
                  </span>
                )}
                {r.gated && (
                  <span className="plate" style={{ color: THERMAL.t4 }}>
                    gated
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Re-exported for the detail panel's readouts. */
export { Readout };
