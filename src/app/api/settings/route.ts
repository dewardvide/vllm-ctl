import { guard, ok, readJson } from "@/lib/server/api";
import {
  detectGuidellmBinDir,
  detectVllmBinDir,
  effectiveHfToken,
  getSettings,
  invalidateSettings,
  saveSettings,
  type Settings,
} from "@/lib/settings";
import { invalidateFlagSchema, getVllmVersion } from "@/lib/vllm/flag-schema";
import { benchmarks } from "@/lib/guidellm/runner";
import { nvidiaSmiAvailable } from "@/lib/telemetry/nvidia";
import { PINNED_GUIDELLM } from "@/lib/guidellm/argv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const settings = getSettings();
    const [vllmVersion, guidellmVersion, gpu] = await Promise.all([
      getVllmVersion(),
      benchmarks().guidellmVersion(),
      nvidiaSmiAvailable(),
    ]);

    return ok({
      settings: { ...settings, hfToken: settings.hfToken ? "••••••••" : null },
      environment: {
        vllmVersion,
        guidellmVersion,
        guidellmPinned: PINNED_GUIDELLM,
        gpuAvailable: gpu,
        hasHfToken: effectiveHfToken(settings) !== null,
        detectedVllmBinDir: detectVllmBinDir(),
        detectedGuidellmBinDir: detectGuidellmBinDir(),
      },
    });
  });
}

export async function PATCH(req: Request) {
  return guard(async () => {
    const patch = await readJson<Partial<Settings>>(req);
    // The masked placeholder must never be written back as a real token.
    if (patch.hfToken && /^•+$/.test(patch.hfToken)) delete patch.hfToken;

    const next = saveSettings(patch);
    // A changed Python environment means a different vLLM, so its option
    // schema is no longer valid.
    if (patch.vllmBinDir !== undefined) invalidateFlagSchema();
    invalidateSettings();

    return ok({ settings: { ...next, hfToken: next.hfToken ? "••••••••" : null } });
  });
}
