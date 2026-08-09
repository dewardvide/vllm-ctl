import { guard, ok } from "@/lib/server/api";
import { getVllmVersion, loadFlagSchema } from "@/lib/vllm/flag-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The vLLM option schema. Regenerating runs `vllm serve --help=all`, which
 * imports torch and takes several seconds — hence the explicit opt-in.
 */
export async function GET(req: Request) {
  return guard(async () => {
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    const schema = await loadFlagSchema({ refresh });
    return ok({ schema, vllmVersion: await getVllmVersion() });
  });
}
