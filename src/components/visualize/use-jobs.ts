"use client";

import { useCallback, useEffect, useState } from "react";

import { CURRENT_ENDPOINT, POLL_MS, isActive, jobEndpoint, type JobDetail } from "@/lib/visualize";

/**
 * The Visualize job(s), from `/api/visualize/*`, for the tool rows and the
 * Visualize view. Polling is on demand, never global:
 *   - the view asks for the current visualization every POLL_MS while it is
 *     mounted (open);
 *   - a tool row asks for its own job every POLL_MS while that job is queued
 *     or running, and then never again — a finished job does not change, and
 *     a replaced one is gone (404).
 */

/**
 * GET `url` now and then again every POLL_MS for as long as `again(value)`
 * says so. `undefined` until the first answer, `null` for a 404. A failed
 * request keeps the last value and tries again.
 */
function usePolled<T>(
  url: string | null,
  read: (body: unknown) => T | null,
  again: (value: T | null) => boolean,
): { value: T | null | undefined; refresh: () => void } {
  const [state, setState] = useState<{ url: string | null; value: T | null | undefined }>({
    url,
    value: undefined,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const tick = async () => {
      let next: T | null | undefined;
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (response.status === 404) next = null;
        else if (response.ok) next = read(await response.json());
      } catch {
        /* offline or aborted: keep what we had */
      }
      if (cancelled) return;
      if (next !== undefined) setState({ url, value: next });
      if (next === undefined || again(next)) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
    // read/again are module-level functions; nonce re-runs the loop on demand
  }, [url, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // a value fetched for another url is not this one's
  return { value: state.url === url ? state.value : undefined, refresh };
}

const readJob = (body: unknown) => ((body as { job?: JobDetail | null }).job ?? null) as JobDetail | null;
const always = () => true;
const whileActive = (job: JobDetail | null) => job !== null && isActive(job.status);

/** the current visualization (null when there is none); polled while the caller is mounted */
export function useCurrentVisualization(lines = 50) {
  const { value, refresh } = usePolled(`${CURRENT_ENDPOINT}?lines=${lines}`, readJob, always);
  return { job: value, refresh };
}

/** one job, with `lines` of its log; polled while it is queued or running; null once replaced */
export function useVisualizeJob(id: string | null | undefined, lines = 50) {
  const url = id ? `${jobEndpoint(id)}?lines=${lines}` : null;
  const { value, refresh } = usePolled(url, readJob, whileActive);
  return { job: value, refresh };
}

/** a clock that ticks once a second while `on` */
export function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}
