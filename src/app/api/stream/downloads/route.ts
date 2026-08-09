import { sseResponse } from "@/lib/server/broadcast";
import { downloads, DOWNLOADS_TOPIC } from "@/lib/hf/download";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return sseResponse(DOWNLOADS_TOPIC, {
    initial: () => ({ event: "state", data: { downloads: downloads().list() } }),
  });
}
