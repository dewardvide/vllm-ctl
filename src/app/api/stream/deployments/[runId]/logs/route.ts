import { sseResponse } from "@/lib/server/broadcast";
import { logTopic, supervisor } from "@/lib/vllm/supervisor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live logs for one deployment.
 *
 * The `lines` event carries a batch, not a single line — the supervisor
 * coalesces bursts so a CUDA graph capture doesn't produce hundreds of frames.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId: raw } = await ctx.params;
  const runId = Number.parseInt(raw, 10);
  if (!Number.isFinite(runId)) {
    return Response.json({ error: "Invalid run id." }, { status: 400 });
  }

  const tail = Number.parseInt(
    new URL(req.url).searchParams.get("tail") ?? "800",
    10,
  );

  return sseResponse(logTopic(runId), {
    initial: () => ({
      event: "lines",
      data: supervisor().logsFor(runId, Number.isFinite(tail) ? tail : 800),
    }),
  });
}
