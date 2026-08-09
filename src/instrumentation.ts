/**
 * Process boot hook.
 *
 * Next runs this once per server process, before serving any request, which is
 * where the long-lived singletons belong. Starting them here rather than lazily
 * on first request means the dashboard already has a populated history window
 * by the time anyone opens it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { sampler, pruneTelemetry } = await import("@/lib/telemetry/sampler");
  const { supervisor } = await import("@/lib/vllm/supervisor");
  const { metricsPoller } = await import("@/lib/vllm/metrics");
  const { downloads } = await import("@/lib/hf/download");
  const { benchmarks } = await import("@/lib/guidellm/runner");

  pruneTelemetry();
  sampler();
  metricsPoller();

  // Anything left running by an unclean shutdown is stopped and marked, so the
  // UI never shows a deployment or download that no longer exists.
  await supervisor().reconcileOrphans();
  downloads().reconcile();
  benchmarks().reconcile();
}
