import { sseResponse } from "@/lib/server/broadcast";
import { benchmarks, BENCHMARKS_TOPIC } from "@/lib/guidellm/runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return sseResponse(BENCHMARKS_TOPIC, {
    initial: () => ({
      event: "state",
      data: { runs: benchmarks().list(30), activeId: benchmarks().activeId },
    }),
  });
}
