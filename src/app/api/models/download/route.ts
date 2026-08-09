import { fail, guard, ok, readJson } from "@/lib/server/api";
import { downloads } from "@/lib/hf/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(() => ok({ downloads: downloads().list() }));
}

export async function POST(req: Request) {
  return guard(async () => {
    const { repo, revision } = await readJson<{ repo: string; revision?: string }>(req);
    if (!repo?.trim()) return fail("Name a model repository to download.");
    return ok({ job: downloads().start(repo.trim(), revision?.trim() || "main") }, { status: 201 });
  });
}

export async function DELETE(req: Request) {
  return guard(async () => {
    const { id } = await readJson<{ id: number }>(req);
    downloads().cancel(id);
    return ok({ cancelled: true });
  });
}
