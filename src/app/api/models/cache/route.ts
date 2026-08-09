import { guard, ok, readJson } from "@/lib/server/api";
import { deleteFromCache, scanCache } from "@/lib/hf/cache";
import type { CachedRepo } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => ok({ repos: await scanCache() }));
}

export async function DELETE(req: Request) {
  return guard(async () => {
    const body = await readJson<{
      repoId: string;
      repoType?: CachedRepo["repoType"];
      revision?: string;
    }>(req);
    const { freedBytes } = await deleteFromCache(body.repoId, {
      repoType: body.repoType,
      revision: body.revision,
    });
    return ok({ freedBytes });
  });
}
