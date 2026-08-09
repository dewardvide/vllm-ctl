import { fail, guard, ok, readJson } from "@/lib/server/api";
import { supervisor } from "@/lib/vllm/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return guard(async () => {
    const { runId } = await readJson<{ runId: number }>(req);
    const result = await supervisor().restart(runId);
    if (!result) return fail("That deployment is no longer running.", 404);
    return ok(result);
  });
}
