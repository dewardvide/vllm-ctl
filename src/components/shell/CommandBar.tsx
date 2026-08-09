"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useTelemetry } from "@/lib/client/telemetry-store";

const NAV = [
  { href: "/", label: "overview" },
  { href: "/models", label: "models" },
  { href: "/deployments", label: "deployments" },
  { href: "/benchmarks", label: "benchmarks" },
  { href: "/settings", label: "settings" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function CommandBar({ runningCount }: { runningCount: number }) {
  const pathname = usePathname();
  const { connected } = useTelemetry();

  return (
    <header className="hairline-b flex items-stretch h-9 shrink-0 bg-panel">
      <Link
        href="/"
        className="flex items-center px-3 hairline-r shrink-0 hover:bg-panel-hi transition-colors"
      >
        <span
          className="text-[13px] font-semibold tracking-tight"
          style={{ fontStretch: "125%" }}
        >
          vllm
          <span className="text-signal">·</span>
          ctl
        </span>
      </Link>

      <nav className="flex items-stretch">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={[
                "plate flex items-center px-3.5 hairline-r transition-colors",
                active
                  ? "text-ink bg-void shadow-[inset_0_-1px_0_0_var(--color-signal)]"
                  : "hover:text-ink-dim hover:bg-panel-hi",
              ].join(" ")}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="flex items-center gap-3 px-3 shrink-0">
        <span className="plate flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block w-[5px] h-[5px] rounded-full"
            style={{
              background: runningCount > 0 ? "var(--status-healthy)" : "var(--status-idle)",
            }}
          />
          {runningCount} live
        </span>
        <span
          className="plate"
          style={{ color: connected ? undefined : "var(--color-t3)" }}
          title={connected ? "Telemetry stream connected" : "Reconnecting to telemetry stream"}
        >
          {connected ? "linked" : "linking"}
        </span>
      </div>
    </header>
  );
}
