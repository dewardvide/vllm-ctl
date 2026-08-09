"use client";

import { useEffect, useRef, useState } from "react";

import { useChat, type ChatTurn } from "@/lib/client/use-chat";
import { fixed, ms, msUnit } from "@/lib/format";
import type { ChatParams } from "@/lib/vllm/chat";
import type { LiveDeployment } from "@/lib/types";
import { Button, Empty, Panel, Problem, Readout } from "@/components/ui/primitives";

/**
 * Talk to one deployment.
 *
 * Sits between the engine panel and the log deliberately: send a message and
 * you can watch `requests running` rise above and vLLM's own log react below,
 * in one glance. That correlation is the reason this is a panel here rather
 * than a screen of its own.
 */
export function ChatPanel({
  runId,
  deployment,
}: {
  runId: number;
  deployment: LiveDeployment;
}) {
  const { turns, params, setParams, streaming, send, stop, reset } = useChat(runId);
  const [draft, setDraft] = useState("");
  const [showParams, setShowParams] = useState(false);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Same follow behaviour as the log view: stick to the bottom until the reader
  // scrolls away, then leave them where they are.
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, follow]);

  const ready = deployment.status === "healthy";

  const submit = () => {
    if (!draft.trim() || streaming) return;
    send(draft);
    setDraft("");
    setFollow(true);
  };

  return (
    <Panel
      label="chat"
      actions={
        <span className="flex gap-1 items-center">
          <Button
            onClick={() => setShowParams((s) => !s)}
            tone={showParams ? "primary" : "default"}
          >
            parameters
          </Button>
          <Button onClick={reset} disabled={turns.length === 0}>
            clear
          </Button>
        </span>
      }
    >
      {!ready ? (
        <div className="hairline-t">
          <Empty
            title={`${deployment.name} is not ready to answer.`}
            hint={
              deployment.status === "loading" || deployment.status === "starting"
                ? "It is still coming up. The chat opens as soon as the engine reports healthy."
                : `The engine is ${deployment.status}. Restart it to send a message.`
            }
          />
        </div>
      ) : (
        <>
          {showParams && <ParamsRow params={params} onChange={setParams} />}

          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              if (!atBottom && follow) setFollow(false);
              if (atBottom && !follow) setFollow(true);
            }}
            className="overflow-auto hairline-t"
            // Grows with the conversation instead of reserving its maximum up
            // front: a fixed height leaves a screen of empty panel under a
            // two-line answer, which reads as something failing to load.
            style={{ minHeight: 96, maxHeight: "min(38vh, 420px)" }}
          >
            {turns.length === 0 ? (
              <Empty
                title="Nothing sent yet."
                hint={`Messages go to ${deployment.servedName ?? deployment.model} on ${deployment.host}:${deployment.port}, and count as real load on the metrics above.`}
              />
            ) : (
              <ol>
                {turns.map((t) => (
                  <Turn key={t.id} turn={t} />
                ))}
              </ol>
            )}
          </div>

          <div className="flex gap-2 items-end px-3 py-2 hairline-t">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="a message — enter to send, shift-enter for a new line"
              className="resize-none"
              style={{ lineHeight: 1.5 }}
              aria-label="message"
            />
            {streaming ? (
              <Button tone="danger" onClick={stop}>
                stop
              </Button>
            ) : (
              <Button tone="primary" onClick={submit} disabled={!draft.trim()}>
                send
              </Button>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One turn.
 *
 * Roles are told apart by an engraved gutter label rather than by bubbles —
 * bubbles are the one shape this interface does not have anywhere else.
 */
function Turn({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  const waiting = turn.pending && !turn.content && !turn.reasoning;

  return (
    <li className="flex gap-3 px-3 py-2 hairline-t">
      <span
        // Wide enough for "model" at the nameplate's tracking, so both roles'
        // text starts on the same column.
        className={`plate w-14 shrink-0 pt-0.5 ${waiting ? "is-transitional" : ""}`}
        style={isUser ? undefined : { color: "var(--color-signal-dim)" }}
      >
        {isUser ? "you" : "model"}
      </span>

      <div className="min-w-0 flex-1">
        {turn.reasoning && (
          <p
            className="text-[12px] leading-relaxed whitespace-pre-wrap break-words mb-1.5 pl-2"
            style={{
              color: "var(--color-ink-faint)",
              borderLeft: "1px solid var(--color-rule)",
            }}
          >
            {turn.reasoning}
          </p>
        )}

        {waiting ? (
          <p className="text-[12px] text-ink-faint">waiting for the first token</p>
        ) : (
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
            {turn.content}
            {turn.pending && <span className="is-transitional text-signal">▍</span>}
          </p>
        )}

        {turn.error && <Problem>{turn.error}</Problem>}

        {!isUser && !turn.pending && !turn.error && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
            <Readout label="ttft" value={ms(turn.ttftMs)} unit={msUnit(turn.ttftMs)} size="sm" />
            <Readout
              label="tok/s"
              value={turn.tokPerS != null ? fixed(turn.tokPerS, 1) : "—"}
              size="sm"
            />
            <Readout
              label="out tok"
              value={turn.completionTokens != null ? String(turn.completionTokens) : "—"}
              size="sm"
            />
            <Readout
              label="prompt tok"
              value={turn.promptTokens != null ? String(turn.promptTokens) : "—"}
              size="sm"
            />
            {turn.stopped && <Readout label="ended" value="stopped" size="sm" />}
          </div>
        )}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The sampling controls.
 *
 * Every field is empty by default and says so. A blank box means the parameter
 * is not sent at all, leaving the model's own generation config in charge —
 * which is what you want when the question is "how does this deployment
 * behave", not "how does it behave under our defaults".
 */
function ParamsRow({
  params,
  onChange,
}: {
  params: ChatParams;
  onChange: (next: ChatParams) => void;
}) {
  const set = <K extends keyof ChatParams>(key: K, value: ChatParams[K]) =>
    onChange({ ...params, [key]: value });

  const num = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="hairline-t px-3 py-2.5 flex flex-col gap-2.5">
      <label className="flex flex-col gap-1">
        <span className="plate">system prompt</span>
        <textarea
          rows={2}
          value={params.system ?? ""}
          onChange={(e) => set("system", e.target.value === "" ? null : e.target.value)}
          placeholder="none — the model's default behaviour"
          className="resize-none"
        />
      </label>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <label className="flex flex-col gap-1">
          <span className="plate">temperature</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={params.temperature ?? ""}
            onChange={(e) => set("temperature", num(e.target.value))}
            placeholder="model default"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="plate">top p</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={params.topP ?? ""}
            onChange={(e) => set("topP", num(e.target.value))}
            placeholder="model default"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="plate">max tokens</span>
          <input
            type="number"
            min={1}
            value={params.maxTokens ?? ""}
            onChange={(e) => set("maxTokens", num(e.target.value))}
            placeholder="until stop"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="plate">seed</span>
          <input
            type="number"
            value={params.seed ?? ""}
            onChange={(e) => set("seed", num(e.target.value))}
            placeholder="random"
          />
        </label>
        <label className="flex flex-col gap-1 justify-end pb-1">
          <span className="plate">stream</span>
          <span className="flex items-center gap-2 h-[26px]">
            <input
              type="checkbox"
              checked={params.stream}
              onChange={(e) => set("stream", e.target.checked)}
              className="w-auto"
            />
            <span className="text-[11px] text-ink-faint">
              {params.stream ? "token by token" : "one response"}
            </span>
          </span>
        </label>
      </div>
      <p className="text-[11px] text-ink-faint">
        Timings are measured in the browser, so they include this app&apos;s proxy hop —
        a millisecond or two above what the engine itself reports.
      </p>
    </div>
  );
}
