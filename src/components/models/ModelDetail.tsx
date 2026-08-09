"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/client/api";
import { useDeployments } from "@/lib/client/deployments-store";
import { bytesStr, compact, fixed, int } from "@/lib/format";
import { THERMAL } from "@/lib/thermal";
import type { HubSearchResult, ModelArchInfo, VramEstimate } from "@/lib/types";
import { Button, Meter, Panel, Problem, Readout } from "@/components/ui/primitives";

interface Detail extends HubSearchResult {
  files: Array<{ path: string; size: number | null }>;
  totalSizeBytes: number | null;
  config: ModelArchInfo | null;
  cardUrl: string;
}

/** Context lengths worth reaching for, filtered to what the model supports. */
const CONTEXT_STOPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

/**
 * One model, and the only question that matters on a single 24 GB card: how
 * much context can I actually serve?
 *
 * The context control is a set of stops rather than a free number field —
 * the answer is a decision between a handful of real options, and each stop
 * shows its own verdict so the trade-off is visible without trial and error.
 */
export function ModelDetail({ repo, onClose }: { repo: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextLen, setContextLen] = useState(8192);
  const [kvDtype, setKvDtype] = useState("auto");
  const [gpuUtil, setGpuUtil] = useState(0.9);
  const [estimate, setEstimate] = useState<VramEstimate | null>(null);
  const { setProjection } = useDeployments();

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ detail: Detail }>(`/api/models/detail?repo=${encodeURIComponent(repo)}`)
      .then((r) => {
        if (cancelled) return;
        setError(null);
        setDetail(r.detail);
        const max = r.detail.config?.maxPositionEmbeddings;
        // Open at a context that is plausible on this card, not the model's
        // advertised maximum, which usually cannot fit.
        setContextLen(Math.min(max ?? 8192, 16384));
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [repo]);

  // Publish the projection so the shell's headroom rail draws a ghost segment.
  useEffect(() => {
    if (!estimate?.known) {
      setProjection(null);
      return;
    }
    setProjection({ label: repo, mib: estimate.totalGiB * 1024 });
    return () => setProjection(null);
  }, [estimate, repo, setProjection]);

  useEffect(() => {
    if (!detail?.config) return;
    let cancelled = false;
    api
      .post<{ estimate: VramEstimate }>("/api/vram", {
        arch: detail.config,
        maxModelLen: contextLen,
        kvCacheDtype: kvDtype,
        gpuMemoryUtilization: gpuUtil,
      })
      .then((r) => !cancelled && setEstimate(r.estimate))
      .catch(() => !cancelled && setEstimate(null));
    return () => {
      cancelled = true;
    };
  }, [detail, contextLen, kvDtype, gpuUtil]);

  const stops = useMemo(() => {
    const max = detail?.config?.maxPositionEmbeddings ?? 131072;
    const list = CONTEXT_STOPS.filter((c) => c <= max);
    if (list.length === 0) list.push(max);
    else if (!list.includes(max) && max < 262144) list.push(max);
    return list;
  }, [detail]);

  const cfg = detail?.config;

  return (
    <Panel
      label="model"
      ticked
      actions={
        <span className="flex gap-1">
          {detail && (
            <Link
              href={`/deployments/new?model=${encodeURIComponent(repo)}&max-model-len=${contextLen}`}
            >
              <Button tone="primary">deploy this</Button>
            </Link>
          )}
          <Button onClick={onClose}>close</Button>
        </span>
      }
      bodyClassName="overflow-auto"
    >
      {error && <Problem>{error}</Problem>}
      {!detail && !error && <p className="px-3 py-4 plate">loading</p>}

      {detail && (
        <div className="flex flex-col">
          <div className="px-3 py-2 flex flex-col gap-1 hairline-t">
            <h2 className="text-[13px] font-medium break-all">{detail.repoId}</h2>
            <div className="flex flex-wrap items-center gap-3">
              <span className="plate">↓ {compact(detail.downloads)}</span>
              {detail.totalSizeBytes && (
                <span className="plate">{bytesStr(detail.totalSizeBytes)} weights</span>
              )}
              {detail.quantization && (
                <span className="plate" style={{ color: THERMAL.t3 }}>
                  {detail.quantization}
                </span>
              )}
              {detail.cached && (
                <span className="plate" style={{ color: THERMAL.t2 }}>
                  on disk
                </span>
              )}
              <a
                href={detail.cardUrl}
                target="_blank"
                rel="noreferrer"
                className="plate hover:text-signal transition-colors"
              >
                model card ↗
              </a>
            </div>
          </div>

          {cfg && (
            <div className="grid grid-cols-3 gap-x-3 gap-y-2 px-3 py-2 hairline-t">
              <Readout label="architecture" value={cfg.architectures[0] ?? "—"} size="sm" />
              <Readout label="params" value={cfg.numParams ? compact(cfg.numParams) : "—"} size="sm" />
              <Readout label="dtype" value={cfg.torchDtype ?? "—"} size="sm" />
              <Readout label="layers" value={cfg.numHiddenLayers ?? "—"} size="sm" />
              <Readout
                label="heads (q/kv)"
                value={`${cfg.numAttentionHeads ?? "—"}/${cfg.numKeyValueHeads ?? "—"}`}
                size="sm"
              />
              <Readout label="head dim" value={cfg.headDim ?? "—"} size="sm" />
              <Readout
                label="max context"
                value={cfg.maxPositionEmbeddings ? int(cfg.maxPositionEmbeddings) : "—"}
                size="sm"
              />
              <Readout label="vocab" value={cfg.vocabSize ? compact(cfg.vocabSize) : "—"} size="sm" />
              <Readout
                label="sliding window"
                value={cfg.slidingWindow ? int(cfg.slidingWindow) : "none"}
                size="sm"
              />
            </div>
          )}

          {!cfg && (
            <p className="px-3 py-3 text-[12px] text-ink-faint">
              This repository has no readable <code>config.json</code>, so its memory use
              cannot be estimated. GGUF builds are packaged this way.
            </p>
          )}

          {cfg && (
            <div className="flex flex-col gap-2 px-3 py-2.5 hairline-t">
              <span className="plate">will it fit</span>

              <div className="flex flex-wrap gap-1">
                {stops.map((c) => (
                  <button
                    key={c}
                    onClick={() => setContextLen(c)}
                    className={[
                      "plate px-2 h-6 border rounded-[2px] transition-colors",
                      contextLen === c
                        ? "border-signal-dim text-signal bg-signal/10"
                        : "border-rule text-ink-faint hover:text-ink-dim hover:border-rule-hi",
                    ].join(" ")}
                  >
                    {c >= 1024 ? `${c / 1024}k` : c}
                  </button>
                ))}
              </div>

              <div className="flex gap-3">
                <label className="flex-1 flex flex-col gap-1">
                  <span className="plate">kv cache dtype</span>
                  <select value={kvDtype} onChange={(e) => setKvDtype(e.target.value)}>
                    <option value="auto">auto (match model)</option>
                    <option value="fp8_e4m3">fp8_e4m3 (half the KV)</option>
                    <option value="fp8_e5m2">fp8_e5m2</option>
                  </select>
                </label>
                <label className="flex-1 flex flex-col gap-1">
                  <span className="plate">gpu memory utilization</span>
                  <input
                    type="number"
                    min={0.1}
                    max={1}
                    step={0.01}
                    value={gpuUtil}
                    onChange={(e) => setGpuUtil(Number(e.target.value) || 0.9)}
                  />
                </label>
              </div>

              {estimate && <FitVerdict estimate={estimate} contextLen={contextLen} />}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function FitVerdict({
  estimate,
  contextLen,
}: {
  estimate: VramEstimate;
  contextLen: number;
}) {
  const tone = !estimate.known
    ? THERMAL.t3
    : estimate.fits
      ? THERMAL.t2
      : THERMAL.t4;

  const verdict = !estimate.known
    ? "cannot verify"
    : estimate.fits
      ? "fits"
      : "will not fit";

  const usedPct =
    estimate.availableGiB > 0
      ? Math.min(100, (estimate.totalGiB / estimate.availableGiB) * 100)
      : 100;

  return (
    <div className="flex flex-col gap-1.5 mt-1">
      <div className="flex items-baseline gap-2">
        <span className="plate" style={{ color: tone }}>
          {verdict}
        </span>
        <span className="num text-[13px]" style={{ color: tone }}>
          {fixed(estimate.totalGiB, 1)}
        </span>
        <span className="plate">
          of {fixed(estimate.availableGiB, 1)} gib available
        </span>
      </div>

      <Meter value={usedPct} color={tone} height={4} />

      <div className="grid grid-cols-3 gap-2">
        <Readout label="weights" value={fixed(estimate.weightsGiB, 2)} unit="gib" size="sm" />
        <Readout
          label={`kv @ ${contextLen >= 1024 ? `${contextLen / 1024}k` : contextLen}`}
          value={fixed(estimate.kvAtContextGiB, 2)}
          unit="gib"
          size="sm"
        />
        <Readout
          label="per token"
          value={fixed(estimate.kvPerTokenKiB, 0)}
          unit="kib"
          size="sm"
        />
      </div>

      {estimate.maxContextThatFits != null && (
        <p className="plate">
          longest context that fits: {int(estimate.maxContextThatFits)} tokens
        </p>
      )}

      {estimate.notes.map((n) => (
        <p key={n} className="text-[11px] text-ink-faint leading-relaxed">
          {n}
        </p>
      ))}
    </div>
  );
}
