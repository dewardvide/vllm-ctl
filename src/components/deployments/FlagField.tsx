"use client";

import type { FlagSpec } from "@/lib/types";
import type { FlagValue } from "@/lib/vllm/argv";

/**
 * One vLLM option, rendered according to the type the schema parser inferred.
 *
 * Every field shows argparse's own help text and default. A flag with no value
 * set is *not sent at all*, so the engine's default applies — that distinction
 * is the difference between a 274-option form and 274 opportunities to
 * accidentally pin a value.
 */
export function FlagField({
  spec,
  value,
  error,
  onChange,
}: {
  spec: FlagSpec;
  value: FlagValue | undefined;
  error?: string;
  onChange: (v: FlagValue | undefined) => void;
}) {
  const isSet = value !== undefined;
  const id = `flag-${spec.name}`;

  return (
    <div
      className={`px-3 py-2 hairline-t grid grid-cols-[minmax(0,1fr)_260px] gap-3 items-start ${
        isSet ? "bg-panel" : ""
      }`}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="flex items-center gap-2 flex-wrap">
          <code className="num text-[12px] text-ink">--{spec.name}</code>
          {isSet && (
            <span className="plate" style={{ color: "var(--color-signal)" }}>
              set
            </span>
          )}
          {spec.aliases.length > 0 && (
            <span className="plate">
              {spec.aliases.map((a) => (a.length === 1 ? `-${a}` : `--${a}`)).join(" ")}
            </span>
          )}
        </label>
        {spec.help && (
          // vLLM's help paragraphs run to a dozen lines. Clamped so the list
          // stays scannable; the full text is one hover away.
          <p
            title={spec.help}
            className="text-[11px] text-ink-faint leading-snug mt-0.5 max-w-prose line-clamp-2"
          >
            {spec.help}
          </p>
        )}
        {error && (
          <p className="text-[11px] mt-0.5" style={{ color: "var(--color-t4)" }}>
            {error}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Control id={id} spec={spec} value={value} onChange={onChange} />
        <div className="flex items-center gap-2">
          <span className="plate truncate flex-1">
            default {spec.default ?? "none"}
          </span>
          {isSet && (
            <button
              onClick={() => onChange(undefined)}
              className="plate hover:text-ink-dim transition-colors"
              title="Remove this option so vLLM's default applies"
            >
              clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Control({
  id,
  spec,
  value,
  onChange,
}: {
  id: string;
  spec: FlagSpec;
  value: FlagValue | undefined;
  onChange: (v: FlagValue | undefined) => void;
}) {
  if (spec.type === "boolean") {
    // Three states, because "unset" is meaningfully different from "false":
    // unset lets vLLM's own default win.
    const current = value === undefined ? "" : value ? "true" : "false";
    return (
      <select
        id={id}
        value={current}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : e.target.value === "true")
        }
      >
        <option value="">unset — use default</option>
        <option value="true">enabled</option>
        <option value="false">disabled</option>
      </select>
    );
  }

  if (spec.type === "enum" && spec.choices) {
    return (
      <select
        id={id}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      >
        <option value="">unset — use default</option>
        {spec.choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  }

  if (spec.type === "json") {
    return (
      <textarea
        id={id}
        rows={2}
        value={value === undefined ? "" : String(value)}
        placeholder={spec.default ?? "JSON"}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      />
    );
  }

  const numeric = spec.type === "int" || spec.type === "float";
  return (
    <input
      id={id}
      type={numeric ? "number" : "text"}
      step={spec.type === "float" ? "any" : undefined}
      inputMode={numeric ? "decimal" : undefined}
      value={value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value)}
      placeholder={spec.default ?? (spec.type === "list" ? "comma separated" : "")}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    />
  );
}
