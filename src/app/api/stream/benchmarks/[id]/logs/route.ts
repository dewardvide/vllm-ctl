import fs from "node:fs";

import { sseResponse } from "@/lib/server/broadcast";
import { benchLogTopic, benchmarks } from "@/lib/guidellm/runner";
import { getDb } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id)) {
    return Response.json({ error: "Invalid run id." }, { status: 400 });
  }

  return sseResponse(benchLogTopic(id), {
    initial: () => ({ event: "lines", data: readTail(id) }),
  });
}

/**
 * A finished run has no in-memory log, so the tail is read back from the file
 * the runner wrote. This is what makes the log pane work on an old run.
 */
function readTail(id: number, lines = 500): string[] {
  const row = getDb()
    .prepare("SELECT log_path FROM benchmark_runs WHERE id = ?")
    .get(id) as { log_path?: string } | undefined;
  if (!row?.log_path) return [];
  try {
    return fs.readFileSync(row.log_path, "utf8").split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

// Referenced so the runner module is loaded and its singleton exists.
void benchmarks;
