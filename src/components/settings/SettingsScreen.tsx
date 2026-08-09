"use client";

import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import { THERMAL } from "@/lib/thermal";
import { Button, Note, Panel, Problem, Readout } from "@/components/ui/primitives";

interface Settings {
  vllmBinDir: string | null;
  guidellmBinDir: string | null;
  cudaHome: string | null;
  hfCacheDir: string;
  hfToken: string | null;
  serveHost: string;
  portRangeStart: number;
  portRangeEnd: number;
  sampleIntervalMs: number;
  telemetryRetentionHours: number;
  vramSafetyMargin: number;
}

interface Environment {
  vllmVersion: string | null;
  guidellmVersion: string | null;
  guidellmPinned: string;
  gpuAvailable: boolean;
  hasHfToken: boolean;
  detectedVllmBinDir: string | null;
  detectedGuidellmBinDir: string | null;
  cudaHome: string | null;
}

export function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ settings: Settings; environment: Environment }>(
        "/api/settings",
      );
      setSettings(r.settings);
      setEnv(r.environment);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch("/api/settings", settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => (s ? { ...s, [k]: v } : s));

  if (!settings || !env) {
    return error ? <Problem>{error}</Problem> : <p className="px-3 py-4 plate">loading</p>;
  }

  const guidellmMismatch =
    env.guidellmVersion != null && env.guidellmVersion !== env.guidellmPinned;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] min-h-full">
      <div className="min-w-0 flex flex-col">
        {error && <Problem>{error}</Problem>}

        <Panel label="environment" ticked>
          <div className="flex flex-col gap-3 px-3 py-2.5 hairline-t">
            <label className="flex flex-col gap-1">
              <span className="plate">
                python environment — the directory containing the vllm executable
              </span>
              <input
                value={settings.vllmBinDir ?? ""}
                onChange={(e) => set("vllmBinDir", e.target.value || null)}
                placeholder={env.detectedVllmBinDir ?? "/path/to/.venv/bin"}
              />
              {env.detectedVllmBinDir &&
                env.detectedVllmBinDir !== settings.vllmBinDir && (
                  <button
                    className="plate text-left hover:text-signal transition-colors"
                    onClick={() => set("vllmBinDir", env.detectedVllmBinDir)}
                  >
                    use detected: {env.detectedVllmBinDir}
                  </button>
                )}
            </label>

            <label className="flex flex-col gap-1">
              <span className="plate">
                guidellm environment — keep this separate from the vllm one
              </span>
              <input
                value={settings.guidellmBinDir ?? ""}
                onChange={(e) => set("guidellmBinDir", e.target.value || null)}
                placeholder={env.detectedGuidellmBinDir ?? "~/.local/bin"}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="plate">
                cuda toolkit root — vllm compiles kernels and needs nvcc here
              </span>
              <input
                value={settings.cudaHome ?? ""}
                onChange={(e) => set("cudaHome", e.target.value || null)}
                placeholder={env.cudaHome ?? "no toolkit found"}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="plate">hugging face cache</span>
              <input
                value={settings.hfCacheDir}
                onChange={(e) => set("hfCacheDir", e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="plate">
                hugging face token — needed for gated repositories
              </span>
              <input
                type="password"
                value={settings.hfToken ?? ""}
                onChange={(e) => set("hfToken", e.target.value || null)}
                placeholder={env.hasHfToken ? "using the hf CLI's stored token" : "hf_…"}
              />
            </label>
          </div>
        </Panel>

        <Panel label="serving">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-3 py-2.5 hairline-t">
            <label className="flex flex-col gap-1">
              <span className="plate">bind address</span>
              <input
                value={settings.serveHost}
                onChange={(e) => set("serveHost", e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="plate">first port</span>
              <input
                type="number"
                value={settings.portRangeStart}
                onChange={(e) => set("portRangeStart", Number(e.target.value) || 8000)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="plate">last port</span>
              <input
                type="number"
                value={settings.portRangeEnd}
                onChange={(e) => set("portRangeEnd", Number(e.target.value) || 8099)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="plate">vram safety margin</span>
              <input
                type="number"
                step={0.01}
                min={0}
                max={0.5}
                value={settings.vramSafetyMargin}
                onChange={(e) => set("vramSafetyMargin", Number(e.target.value) || 0)}
              />
            </label>
          </div>
          {settings.serveHost !== "127.0.0.1" && (
            <Note>
              Binding to {settings.serveHost} exposes your model endpoints to the network.
              vLLM has no authentication unless you set <code>--api-key</code>, and this
              admin interface has none at all.
            </Note>
          )}
        </Panel>

        <Panel label="telemetry">
          <div className="grid grid-cols-2 gap-3 px-3 py-2.5 hairline-t">
            <label className="flex flex-col gap-1">
              <span className="plate">sample interval (ms)</span>
              <input
                type="number"
                min={250}
                max={10000}
                step={250}
                value={settings.sampleIntervalMs}
                onChange={(e) => set("sampleIntervalMs", Number(e.target.value) || 1000)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="plate">keep history for (hours)</span>
              <input
                type="number"
                min={1}
                value={settings.telemetryRetentionHours}
                onChange={(e) =>
                  set("telemetryRetentionHours", Number(e.target.value) || 72)
                }
              />
            </label>
          </div>
        </Panel>

        <div className="flex items-center gap-2 p-3 hairline-t">
          <Button tone="primary" onClick={save} disabled={busy}>
            {busy ? "saving" : "save settings"}
          </Button>
          {saved && (
            <span className="plate" style={{ color: THERMAL.t2 }}>
              saved
            </span>
          )}
          <span className="plate">
            changing the python environment reloads the option schema
          </span>
        </div>
      </div>

      <aside className="xl:hairline-l min-w-0">
        <Panel label="detected" ticked>
          <div className="flex flex-col gap-2.5 px-3 py-2.5 hairline-t">
            <Readout
              label="vllm"
              value={env.vllmVersion ?? "not found"}
              size="sm"
              color={env.vllmVersion ? THERMAL.t2 : THERMAL.t4}
            />
            <Readout
              label="guidellm"
              value={env.guidellmVersion ?? "not installed"}
              size="sm"
              color={
                !env.guidellmVersion
                  ? THERMAL.t3
                  : guidellmMismatch
                    ? THERMAL.t3
                    : THERMAL.t2
              }
            />
            <Readout
              label="cuda toolkit"
              value={env.cudaHome ? env.cudaHome.replace(/^.*\/site-packages\//, "…/") : "not found"}
              size="sm"
              color={env.cudaHome ? THERMAL.t2 : THERMAL.t4}
            />
            <Readout
              label="gpu"
              value={env.gpuAvailable ? "nvidia-smi available" : "not available"}
              size="sm"
              color={env.gpuAvailable ? THERMAL.t2 : THERMAL.t4}
            />
            <Readout
              label="hugging face token"
              value={env.hasHfToken ? "present" : "none"}
              size="sm"
            />
          </div>

          {!env.vllmVersion && (
            <Problem>
              No vLLM executable was found, so deployments cannot start and the option
              schema cannot be read. Point the python environment above at a virtualenv
              that has vLLM installed.
            </Problem>
          )}

          {!env.cudaHome && (
            <Problem>
              No CUDA toolkit found, so vLLM cannot compile kernels and every
              deployment will fail at engine start. Install one, or add nvcc to the
              vLLM environment with{" "}
              <code className="num text-[11px]">pip install nvidia-cuda-nvcc</code>.
            </Problem>
          )}

          {!env.guidellmVersion && (
            <Note>
              GuideLLM is not installed, so benchmarks cannot run. Install it in its own
              environment so it cannot disturb your vLLM one:
              <br />
              <code className="num text-[11px]">
                uv tool install &apos;guidellm[recommended]&apos;
              </code>
            </Note>
          )}

          {guidellmMismatch && (
            <Note>
              This app builds commands for GuideLLM {env.guidellmPinned}, and{" "}
              {env.guidellmVersion} is installed. Benchmarks will probably still work,
              but check the run log if a command is rejected.
            </Note>
          )}
        </Panel>

        <Panel label="where things are kept">
          <dl className="px-3 py-2.5 hairline-t flex flex-col gap-2 text-[11px]">
            <div>
              <dt className="plate">app data</dt>
              <dd className="num text-ink-dim break-all">~/.vllm-admin</dd>
            </div>
            <div>
              <dt className="plate">deployment logs</dt>
              <dd className="num text-ink-dim break-all">~/.vllm-admin/logs</dd>
            </div>
            <div>
              <dt className="plate">benchmark reports</dt>
              <dd className="num text-ink-dim break-all">~/.vllm-admin/benchmarks</dd>
            </div>
            <div>
              <dt className="plate">model weights</dt>
              <dd className="num text-ink-dim break-all">{settings.hfCacheDir}</dd>
            </div>
          </dl>
        </Panel>
      </aside>
    </div>
  );
}
