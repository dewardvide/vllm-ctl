import { buildLlamaArgv } from "@/lib/backends/llamacpp";
import type { BackendId, ModelSource } from "@/lib/types";
import { getDb } from "@/lib/server/db";
import { fail, guard, ok, readJson } from "@/lib/server/api";
import type { DeploymentProfile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function rowToProfile(r: Record<string, unknown>): DeploymentProfile {
  return {
    backend: (r.backend as BackendId) ?? "vllm",
    modelSource: r.model_source ? JSON.parse(r.model_source as string) : null,
    id: r.id as number,
    name: r.name as string,
    model: r.model as string,
    servedName: (r.served_name as string) ?? null,
    port: (r.port as number) ?? null,
    flags: JSON.parse((r.flags as string) ?? "{}"),
    notes: (r.notes as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

/** Saved launch profiles. */
export async function GET() {
  return guard(() => {
    const rows = getDb()
      .prepare("SELECT * FROM deployments ORDER BY updated_at DESC")
      .all() as Record<string, unknown>[];
    return ok({ profiles: rows.map(rowToProfile) });
  });
}

interface CreateBody {
  backend?: BackendId;
  modelSource?: ModelSource;
  name: string;
  model: string;
  servedName?: string | null;
  port?: number | null;
  flags?: Record<string, string | number | boolean | string[]>;
  notes?: string | null;
}

export async function POST(req: Request) {
  return guard(async () => {
    const body = await readJson<CreateBody>(req);
    if (!body.name?.trim()) return fail("Give the deployment a name.");
    if (!body.model?.trim()) return fail("Choose a model to serve.");

    if (body.backend && !["vllm", "llamacpp"].includes(body.backend)) return fail("Unknown backend.");
    if (body.backend === "llamacpp") buildLlamaArgv({ ...body, flags: body.flags ?? {} }, { host: "127.0.0.1", port: body.port ?? 8000 }, "server");
    const now = Date.now();
    const info = getDb()
      .prepare(
        `INSERT INTO deployments (name, model, served_name, port, flags, notes, created_at, updated_at, backend, model_source)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        body.name.trim(),
        body.model.trim(),
        body.servedName?.trim() || null,
        body.port ?? null,
        JSON.stringify(body.flags ?? {}),
        body.notes?.trim() || null,
        now,
        now,
        body.backend ?? "vllm",
        body.modelSource ? JSON.stringify(body.modelSource) : null,
      );

    const row = getDb()
      .prepare("SELECT * FROM deployments WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Record<string, unknown>;
    return ok({ profile: rowToProfile(row) }, { status: 201 });
  });
}
