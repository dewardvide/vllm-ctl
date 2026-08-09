"use client";

import { useEffect, useState } from "react";

/**
 * A clock that ticks in state.
 *
 * Uptimes and elapsed times need the current time, but reading `Date.now()`
 * during render makes the render impure — the same props would produce
 * different output. This turns the clock into a normal state input instead.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return now;
}
