import { fail, guard, ok, readJson } from "@/lib/server/api";
import { getDb } from "@/lib/server/db";
import { getSettings } from "@/lib/settings";
import { sampler } from "@/lib/telemetry/sampler";
import { supervisor } from "@/lib/vllm/supervisor";
import { readCachedConfig } from "@/lib/hf/cache";
import { fetchConfig } from "@/lib/hf/search";
import { estimateVram } from "@/lib/vram/estimate";
import type { FlagValue } from "@/lib/vllm/argv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartBody {
  /** Start a saved profile… */
  deploymentId?: number;
  /** …or an ad-hoc configuration. */
  name?: string;
  model?: string;
  servedName?: string | null;
  port?: number | null;
  flags?: Record<string, FlagValue>;
  /** Proceed despite a failing VRAM check. */
  force?: boolean;
}

export async function POST(req: Request) {
  return guard(async () => {
    const body = await readJson<StartBody>(req);

    let name = body.name ?? "";
    let model = body.model ?? "";
    let servedName = body.servedName ?? null;
    let port = body.port ?? null;
    let flags: Record<string, FlagValue> = body.flags ?? {};

    if (body.deploymentId) {
      const row = getDb()
        .prepare("SELECT * FROM deployments WHERE id = ?")
        .get(body.deploymentId) as Record<string, unknown> | undefined;
      if (!row) return fail("That deployment profile no longer exists.", 404);
      name = (row.name as string) ?? name;
      model = (row.model as string) ?? model;
      servedName = (row.served_name as string) ?? null;
      port = (row.port as number) ?? null;
      flags = JSON.parse((row.flags as string) ?? "{}");
    }

    if (!model.trim()) return fail("Choose a model to serve.");
    if (!name.trim()) name = model.split("/").pop() ?? model;

    // --- the guard rail -----------------------------------------------------
    if (!body.force) {
      const check = await checkVram(model, flags);
      if (check && !check.fits) {
        return Response.json(
          {
            error: check.reason,
            vram: check.estimate,
            /** The UI offers "start anyway" when the check merely can't verify. */
            overridable: true,
          },
          { status: 409 },
        );
      }
    }

    const { runId, port: assigned } = await supervisor().start({
      deploymentId: body.deploymentId ?? null,
      name,
      model,
      servedName,
      port,
      flags,
    });

    return ok({ runId, port: assigned }, { status: 201 });
  });
}

/**
 * Projects this deployment's footprint against VRAM that is free *right now*,
 * counting anything already running. Returns null when there is no GPU to
 * check against, in which case the launch proceeds unguarded.
 */
async function checkVram(model: string, flags: Record<string, FlagValue>) {
  const latest = sampler().latest();
  const gpu = latest?.gpus[0];
  if (!gpu) return null;

  const arch = (await readCachedConfig(model)) ?? (await fetchConfig(model).catch(() => null));
  if (!arch) {
    return {
      fits: false,
      reason: `Could not read the configuration for ${model}, so its memory use cannot be checked. Start it anyway to proceed.`,
      estimate: null,
    };
  }

  const num = (k: string, d: number) => {
    const v = flags[k];
    const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : d;
  };
  const str = (k: string, d: string) => {
    const v = flags[k];
    return typeof v === "string" && v ? v : d;
  };

  const settings = getSettings();
  const estimate = estimateVram({
    arch,
    maxModelLen: num("max-model-len", arch.maxPositionEmbeddings ?? 8192),
    gpuMemoryUtilization: num("gpu-memory-utilization", 0.9),
    kvCacheDtype: str("kv-cache-dtype", "auto"),
    dtype: str("dtype", "auto"),
    tensorParallelSize: num("tensor-parallel-size", 1),
    totalVramMiB: gpu.memTotalMiB,
    usedVramMiB: gpu.memUsedMiB,
    safetyMargin: settings.vramSafetyMargin,
  });

  if (estimate.fits) return { fits: true, reason: "", estimate };

  const reason = !estimate.known
    ? `Not enough information about ${model} to verify it fits in VRAM.`
    : `This needs about ${estimate.totalGiB.toFixed(1)} GiB but only ${estimate.availableGiB.toFixed(1)} GiB is available.` +
      (estimate.maxContextThatFits
        ? ` Reduce --max-model-len to about ${estimate.maxContextThatFits.toLocaleString()} tokens, or stop another deployment.`
        : "");

  return { fits: false, reason, estimate };
}
