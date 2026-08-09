import { sseResponse } from "@/lib/server/broadcast";
import { DEPLOYMENTS_TOPIC, supervisor } from "@/lib/vllm/supervisor";
import { metricsPoller } from "@/lib/vllm/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Live supervised deployments, pushed whenever any of them changes state. */
export async function GET() {
  metricsPoller(); // idempotent
  return sseResponse(DEPLOYMENTS_TOPIC, {
    initial: () => ({ event: "state", data: { live: supervisor().list() } }),
  });
}
