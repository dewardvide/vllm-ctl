import { guard, ok } from "@/lib/server/api";
import { getDb } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Past launches, for post-mortem on a crash. */
export async function GET() {
  return guard(() => {
    const runs = getDb()
      .prepare(
        `SELECT r.id, r.port, r.status, r.started_at, r.stopped_at, r.error,
                COALESCE(d.model, '') AS model
           FROM deployment_runs r
           LEFT JOIN deployments d ON d.id = r.deployment_id
          WHERE r.status NOT IN ('starting','loading','healthy','stopping')
          ORDER BY r.started_at DESC
          LIMIT 25`,
      )
      .all();
    return ok({ runs });
  });
}
