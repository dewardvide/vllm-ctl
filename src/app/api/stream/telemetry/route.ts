import { sseResponse } from "@/lib/server/broadcast";
import { sampler, TELEMETRY_TOPIC } from "@/lib/telemetry/sampler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live host + GPU telemetry.
 *
 * The `history` event fires once on connect with the sampler's whole in-memory
 * window, so charts arrive fully drawn instead of filling in a pixel per
 * second. After that, one `sample` event per tick.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const count = Number.parseInt(url.searchParams.get("history") ?? "300", 10);

  const s = sampler(); // idempotent; guarantees the loop is running

  return sseResponse(TELEMETRY_TOPIC, {
    initial: () => ({
      event: "history",
      data: {
        samples: s.window(Number.isFinite(count) ? count : 300),
        gpuUnavailableReason: s.gpuUnavailableReason,
      },
    }),
  });
}
