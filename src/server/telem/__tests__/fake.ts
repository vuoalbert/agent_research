import { vi } from "vitest";

import { createMonitorsClient, type FetchLike } from "../monitors";

/**
 * A fake Telem: routes (method + path) to JSON answers, recording each call.
 * Unrouted calls answer 404 in Telem's monitor error shape.
 */
export function fakeTelem(routes: Record<string, unknown | ((body: unknown, url: URL) => unknown)>) {
  const calls: { method: string; path: string; search: string; body: unknown; auth: string | null }[] = [];
  const fetch: FetchLike = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, path: url.pathname, search: url.search, body, auth });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no such monitor" } }), { status: 404 });
    }
    const value = typeof route === "function" ? (route as (b: unknown, u: URL) => unknown)(body, url) : route;
    if (value instanceof Response) return value;
    if (value === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createMonitorsClient({ apiKey: "test-key", fetch, sleep: async () => undefined });
  return { client, calls, fetch };
}

export const MONITOR_ID = "6f1c0000-0000-4000-8000-000000000001";

export const monitorJson = (over: Record<string, unknown> = {}) => ({
  id: MONITOR_ID,
  query: "Solid-state battery production announcements",
  frequency: "1d",
  status: "active",
  session_id: "s",
  created_at: "2026-11-14T10:00:00Z",
  last_polled_at: null,
  expires_at: "2026-11-21T10:00:00Z",
  agent_state: { status: "compiling", watermark: 0 },
  ...over,
});
