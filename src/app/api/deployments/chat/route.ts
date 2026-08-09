import { fail, guard, ok, readJson } from "@/lib/server/api";
import { buildChatBody, chatErrorMessage, type ChatMessage, type ChatParams } from "@/lib/vllm/chat";
import { baseUrl } from "@/lib/vllm/host";
import { supervisor } from "@/lib/vllm/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A chat completion against one live deployment, proxied.
 *
 * The browser never dials the engine itself. `serveHost` is user-configurable,
 * so the engine may be bound to an address the browser cannot route to, and
 * vLLM sends no CORS headers in any case — a direct fetch would fail in exactly
 * the configurations this app already supports. Proxying also keeps engine
 * URLs out of client code and leaves one obvious place for `--api-key`.
 *
 * A flat route taking `runId` in the body, like `start`, `stop` and `restart`.
 * The neighbouring `[id]` segment addresses a saved *profile*, which is a
 * different identifier entirely — nesting this under it would invite exactly
 * the mix-up the two id spaces already make easy.
 */
export async function POST(req: Request) {
  return guard(async () => {
    const { runId, messages, params } = await readJson<{
      runId: number;
      messages: ChatMessage[];
      params: ChatParams;
    }>(req);

    if (!Number.isInteger(runId)) return fail("Invalid run id.");
    if (!Array.isArray(messages) || messages.length === 0) {
      return fail("Send at least one message.");
    }

    // The run's own bind address, resolved to something dialable: a wildcard
    // bind is not a destination, so `http://0.0.0.0:8000` would never connect.
    const live = supervisor().list().find((d) => d.runId === runId);
    if (!live) return fail("That deployment is no longer running.", 409);
    if (live.status !== "healthy") {
      return fail(`${live.name} is not ready yet (${live.status}).`, 409);
    }
    const model = live.servedName ?? live.model;

    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl(live.host, live.port)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildChatBody(model, messages, params)),
        // Carries a cancelled request through to the engine. Without it,
        // pressing stop leaves the engine generating to completion, holding a
        // scheduler slot and skewing every metric on the page it sits under.
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted) return fail("Cancelled.", 499);
      return fail(
        `Could not reach ${live.name} on ${live.host}:${live.port} — ${(err as Error).message}`,
        502,
      );
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return fail(chatErrorMessage(text, upstream.status), upstream.status);
    }

    // Non-streaming responses are already JSON; hand them straight back.
    if (!params.stream) return ok(await upstream.json());

    if (!upstream.body) return fail("The engine returned an empty stream.", 502);

    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Next buffers nothing here, but a reverse proxy in front of the app
        // would, which turns a token stream into one late blob.
        "x-accel-buffering": "no",
      },
    });
  });
}
