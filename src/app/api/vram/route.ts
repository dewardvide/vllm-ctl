import { fail, guard, ok, readJson } from "@/lib/server/api";
import { getSettings } from "@/lib/settings";
import { sampler } from "@/lib/telemetry/sampler";
import { readCachedConfig } from "@/lib/hf/cache";
import { fetchConfig } from "@/lib/hf/search";
import { estimateVram } from "@/lib/vram/estimate";
import type { ModelArchInfo } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  model?: string;
  /** Pass a config directly to avoid a second lookup from the model page. */
  arch?: ModelArchInfo;
  maxModelLen?: number;
  gpuMemoryUtilization?: number;
  kvCacheDtype?: string;
  dtype?: string;
  tensorParallelSize?: number;
}

/** Powers the fit badge, the context slider, and the rail's ghost segment. */
export async function POST(req: Request) {
  return guard(async () => {
    const body = await readJson<Body>(req);

    const arch =
      body.arch ??
      (body.model
        ? ((await readCachedConfig(body.model)) ??
          (await fetchConfig(body.model).catch(() => null)))
        : null);
    if (!arch) return fail("Could not read that model's configuration.", 404);

    const gpu = sampler().latest()?.gpus[0];
    const estimate = estimateVram({
      arch,
      maxModelLen: body.maxModelLen ?? arch.maxPositionEmbeddings ?? 8192,
      gpuMemoryUtilization: body.gpuMemoryUtilization ?? 0.9,
      kvCacheDtype: body.kvCacheDtype ?? "auto",
      dtype: body.dtype ?? "auto",
      tensorParallelSize: body.tensorParallelSize ?? 1,
      totalVramMiB: gpu?.memTotalMiB ?? 0,
      usedVramMiB: gpu?.memUsedMiB ?? 0,
      safetyMargin: getSettings().vramSafetyMargin,
    });

    return ok({ estimate, arch });
  });
}
