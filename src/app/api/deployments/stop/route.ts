import { guard, ok, readJson } from "@/lib/server/api";
import { supervisor } from "@/lib/vllm/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return guard(async () => {
    const { runId } = await readJson<{ runId: number }>(req);
    await supervisor().stop(runId);
    return ok({ stopped: true });
  });
}
