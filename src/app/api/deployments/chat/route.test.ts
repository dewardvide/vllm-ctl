import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/vllm/supervisor", () => ({ supervisor: () => ({ list: () => [{ runId: 1, backend: "llamacpp", name: "test", model: "LiquidAI/LFM3-Omni-2B-GGUF", servedName: "text-model", status: "healthy", host: "127.0.0.1", port: 8000 }] }) }));
import { POST } from "./route";
import { DEFAULT_CHAT_PARAMS } from "@/lib/vllm/chat";
afterEach(() => vi.unstubAllGlobals());
function request(stream = true, signal?: AbortSignal) {
  return new Request("http://localhost/api/deployments/chat", { method: "POST", signal, body: JSON.stringify({ runId: 1, messages: [{ role: "user", content: "hello" }], params: { ...DEFAULT_CHAT_PARAMS, stream } }) });
}
it("passes llama.cpp text and usage frames through with model alias and LFM defaults", async () => {
  const frames = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}\n\ndata: [DONE]\n\n';
  const fetcher = vi.fn().mockResolvedValue(new Response(frames)); vi.stubGlobal("fetch", fetcher);
  const res = await POST(request());
  expect(await res.text()).toBe(frames);
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.model).toBe("text-model"); expect(body.temperature).toBe(0); expect(body.messages[0].role).toBe("system");
});
it("preserves non-streaming responses and upstream errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"choices":[{"message":{"content":"Hi"}}]}')));
  expect((await (await POST(request(false))).json()).choices[0].message.content).toBe("Hi");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":{"message":"context too long"}}', { status: 400 })));
  const res = await POST(request()); expect(res.status).toBe(400); expect(await res.text()).toContain("context too long");
});
it("forwards cancellation to the engine", async () => {
  const ctl = new AbortController();
  const fetcher = vi.fn().mockImplementation((_url, init) => { expect(init.signal.aborted).toBe(true); throw new Error("aborted"); });
  vi.stubGlobal("fetch", fetcher); ctl.abort();
  expect((await POST(request(true, ctl.signal))).status).toBe(499);
});
