import { fail, guard, ok } from "@/lib/server/api";
import { getModelDetail } from "@/lib/hf/search";
import { readCachedConfig } from "@/lib/hf/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Model metadata. Repo ids contain a slash, so they arrive as a query
 * parameter rather than a path segment.
 */
export async function GET(req: Request) {
  return guard(async () => {
    const repo = new URL(req.url).searchParams.get("repo")?.trim();
    if (!repo) return fail("Name a model repository.");

    try {
      return ok({ detail: await getModelDetail(repo) });
    } catch (err) {
      // Offline, or a gated repo: fall back to whatever is already on disk so
      // the page still works without network access.
      const config = await readCachedConfig(repo);
      if (!config) throw err;
      return ok({
        detail: {
          repoId: repo,
          author: repo.split("/")[0],
          downloads: 0,
          likes: 0,
          lastModified: null,
          tags: [],
          pipelineTag: null,
          gated: false,
          quantization: config.quantization,
          cached: true,
          files: [],
          totalSizeBytes: null,
          config,
          cardUrl: `https://huggingface.co/${repo}`,
        },
        offline: true,
      });
    }
  });
}
