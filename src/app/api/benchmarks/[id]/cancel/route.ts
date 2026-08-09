import { guard, intParam, ok } from "@/lib/server/api";
import { benchmarks } from "@/lib/guidellm/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    benchmarks().cancel(intParam((await ctx.params).id));
    return ok({ cancelled: true });
  });
}
