import { getDb } from "@/lib/server/db";
import { fail, guard, intParam, ok, readJson } from "@/lib/server/api";

import { rowToProfile } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const id = intParam((await ctx.params).id);
    const row = getDb().prepare("SELECT * FROM deployments WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return fail("That deployment profile no longer exists.", 404);
    return ok({ profile: rowToProfile(row) });
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const id = intParam((await ctx.params).id);
    const body = await readJson<Record<string, unknown>>(req);

    const row = getDb().prepare("SELECT * FROM deployments WHERE id = ?").get(id);
    if (!row) return fail("That deployment profile no longer exists.", 404);

    getDb()
      .prepare(
        `UPDATE deployments
            SET name = COALESCE(?, name),
                model = COALESCE(?, model),
                served_name = ?,
                port = ?,
                flags = COALESCE(?, flags),
                notes = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        (body.name as string) ?? null,
        (body.model as string) ?? null,
        (body.servedName as string) ?? null,
        (body.port as number) ?? null,
        body.flags ? JSON.stringify(body.flags) : null,
        (body.notes as string) ?? null,
        Date.now(),
        id,
      );

    const updated = getDb()
      .prepare("SELECT * FROM deployments WHERE id = ?")
      .get(id) as Record<string, unknown>;
    return ok({ profile: rowToProfile(updated) });
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const id = intParam((await ctx.params).id);
    getDb().prepare("DELETE FROM deployments WHERE id = ?").run(id);
    return ok({ deleted: true });
  });
}
