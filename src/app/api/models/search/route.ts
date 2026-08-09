import { guard, ok } from "@/lib/server/api";
import { searchModels } from "@/lib/hf/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return guard(async () => {
    const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) return ok({ results: [] });
    return ok({ results: await searchModels(q, { limit: 30 }) });
  });
}
