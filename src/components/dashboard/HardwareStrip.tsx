"use client";

import { useMemo } from "react";

import { useTelemetry } from "@/lib/client/telemetry-store";
import { fixed, int, mibToGiB } from "@/lib/format";
import { INK, rampPct, THERMAL } from "@/lib/thermal";
import { Sparkline } from "@/components/charts/Sparkline";
import { Panel, Readout } from "@/components/ui/primitives";

/**
 * The hardware gauges: GPU first because it is the constraint that matters,
 * then the host. Each gauge pairs one large tabular figure with its trace —
 * the number tells you where you are, the trace tells you how you got here.
 */
export function HardwareStrip() {
  const { latest, samples, gpuUnavailableReason } = useTelemetry();
  const gpu = latest?.gpus[0];

  const series = useMemo(() => {
    const util: number[] = [];
    const mem: number[] = [];
    const power: number[] = [];
    const temp: number[] = [];
    const cpu: number[] = [];
    const ram: number[] = [];
    for (const s of samples) {
      const g = s.gpus[0];
      if (g) {
        util.push(g.utilGpu);
        mem.push(g.memTotalMiB > 0 ? (g.memUsedMiB / g.memTotalMiB) * 100 : 0);
        power.push(g.powerW);
        temp.push(g.tempC);
      }
      cpu.push(s.host.cpuPct);
      ram.push(
        s.host.ramTotalMiB > 0 ? (s.host.ramUsedMiB / s.host.ramTotalMiB) * 100 : 0,
      );
    }
    return { util, mem, power, temp, cpu, ram };
  }, [samples]);

  if (!gpu) {
    return (
      <Panel label="hardware">
        <p className="px-3 py-6 text-ink-faint text-[12px]">
          {gpuUnavailableReason
            ? `No GPU telemetry: ${gpuUnavailableReason}`
            : "Waiting for the first telemetry sample."}
        </p>
      </Panel>
    );
  }

  const memPct = gpu.memTotalMiB > 0 ? (gpu.memUsedMiB / gpu.memTotalMiB) * 100 : 0;
  const powerPct = gpu.powerCapW > 0 ? (gpu.powerW / gpu.powerCapW) * 100 : 0;
  // 83 °C is the RTX 30-series thermal throttle point.
  const tempPct = Math.min(100, (gpu.tempC / 83) * 100);
  const host = latest.host;
  const ramPct =
    host.ramTotalMiB > 0 ? (host.ramUsedMiB / host.ramTotalMiB) * 100 : 0;

  return (
    <Panel
      label={`${gpu.name.replace(/^NVIDIA\s+/, "")} · ${gpu.pstate}`}
      ticked
      actions={
        <span className="plate">
          {int(gpu.clockSmMhz)} mhz · fan {int(gpu.fanPct)}%
        </span>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Gauge
          label="gpu util"
          value={fixed(gpu.utilGpu, 0)}
          unit="%"
          pct={gpu.utilGpu}
          series={series.util}
        />
        <Gauge
          label="vram"
          value={fixed(mibToGiB(gpu.memUsedMiB), 1)}
          unit={`/ ${fixed(mibToGiB(gpu.memTotalMiB), 0)} gib`}
          pct={memPct}
          series={series.mem}
        />
        <Gauge
          label="power"
          value={fixed(gpu.powerW, 0)}
          unit={`/ ${fixed(gpu.powerCapW, 0)} w`}
          pct={powerPct}
          series={series.power}
          max={gpu.powerCapW}
        />
        <Gauge
          label="temp"
          value={fixed(gpu.tempC, 0)}
          unit="°c"
          pct={tempPct}
          series={series.temp}
          max={100}
          threshold={83}
          note={gpu.tempC >= 83 ? "throttling" : undefined}
        />
        <Gauge
          label={`cpu · ${host.coresPct.length} cores`}
          value={fixed(host.cpuPct, 0)}
          unit="%"
          pct={host.cpuPct}
          series={series.cpu}
        />
        <Gauge
          label="ram"
          value={fixed(mibToGiB(host.ramUsedMiB), 1)}
          unit={`/ ${fixed(mibToGiB(host.ramTotalMiB), 0)} gib`}
          pct={ramPct}
          series={series.ram}
          last
        />
      </div>
    </Panel>
  );
}

function Gauge({
  label,
  value,
  unit,
  pct,
  series,
  max,
  threshold,
  note,
  last = false,
}: {
  label: string;
  value: string;
  unit: string;
  pct: number;
  series: number[];
  max?: number;
  threshold?: number;
  note?: string;
  last?: boolean;
}) {
  return (
    <div className={`px-3 py-2 hairline-t ${last ? "" : "xl:hairline-r"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Readout label={label} value={value} unit={unit} color={rampPct(pct)} size="lg" />
        {note && (
          <span className="plate is-transitional" style={{ color: THERMAL.t4 }}>
            {note}
          </span>
        )}
      </div>
      <div className="mt-1">
        <Sparkline
          values={series}
          min={0}
          max={max ?? 100}
          height={26}
          threshold={threshold}
          color={series.length ? undefined : INK.rule}
          ariaLabel={`${label} over the last ${series.length} seconds`}
        />
      </div>
    </div>
  );
}
