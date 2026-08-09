import { fail, guard, ok, readJson } from "@/lib/server/api";
import { benchmarks } from "@/lib/guidellm/runner";
import { supervisor } from "@/lib/vllm/supervisor";
import { getSettings } from "@/lib/settings";
import type { BenchmarkConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(() =>
    ok({ runs: benchmarks().list(50), activeId: benchmarks().activeId }),
  );
}

export async function POST(req: Request) {
  return guard(async () => {
    const config = await readJson<BenchmarkConfig>(req);

    // Point at a live deployment when one was chosen, so the target and model
    // always agree with what is actually serving.
    if (config.deploymentRunId) {
      const live = supervisor().list().find((d) => d.runId === config.deploymentRunId);
      if (!live) return fail("That deployment is no longer running.", 409);
      if (live.status !== "healthy") {
        return fail(`${live.name} is not ready yet (${live.status}).`, 409);
      }
      config.target = `http://${getSettings().serveHost}:${live.port}`;
      config.model = live.servedName ?? live.model;
    }

    if (!config.target) return fail("Choose a deployment, or give a target URL.");

    // Synthetic data is tokenized client-side by GuideLLM, and it resolves the
    // tokenizer from the model name unless told otherwise. A local served name
    // like "granite-4.1-8b" is not a Hugging Face repo, so the run would fail
    // several seconds in with an opaque error. Fill it in from the real model.
    if (config.data.kind === "synthetic_text" && !config.tokenizer) {
      const live = config.deploymentRunId
        ? supervisor().list().find((d) => d.runId === config.deploymentRunId)
        : null;
      if (live?.model?.includes("/")) config.tokenizer = live.model;
      else if (config.model?.includes("/")) config.tokenizer = config.model;
      else {
        return fail(
          "Set a tokenizer. Synthetic prompts need one, and the served model name is not a Hugging Face repository.",
        );
      }
    }

    return ok({ run: benchmarks().start(config) }, { status: 201 });
  });
}
