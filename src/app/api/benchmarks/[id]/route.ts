import { fail, guard, intParam, ok } from "@/lib/server/api";
import { benchmarks, telemetryForRun } from "@/lib/guidellm/runner";
import { findSaturationPoint } from "@/lib/guidellm/ingest";
import { getDb } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const id = intParam((await ctx.params).id);
    const run = benchmarks().get(id);
    if (!run) return fail("That benchmark run no longer exists.", 404);

    const results = benchmarks().results(id);
    return ok({
      run,
      results,
      saturation: findSaturationPoint(results),
      telemetry: telemetryForRun(id),
    });
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const id = intParam((await ctx.params).id);
    getDb().prepare("DELETE FROM benchmark_runs WHERE id = ?").run(id);
    benchmarks().publish();
    return ok({ deleted: true });
  });
}
