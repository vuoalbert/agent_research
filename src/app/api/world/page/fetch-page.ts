// Ported from nyc-world by menonsprithvi-web (server.mjs, GET /api/fetch), with
// this app's SSRF guard (src/app/api/embed-check/check.ts) on every hop.

import { BlockedTargetError, assertPublicHost } from "@/app/api/embed-check/check";

/**
 * Fetch a public web page for a World Labs screen. The viewer turns it into a
 * script-free reading view (browsers block most cross-site fetches, which is
 * why the server fetches it). Only http(s); every redirect hop's host must
 * resolve to public addresses; HTML only; at most 5 MB; 12 s.
 */

export const PAGE_TIMEOUT_MS = 12_000;
export const MAX_PAGE_BYTES = 5_000_000;
export const MAX_HOPS = 5;
const USER_AGENT = "Mozilla/5.0 (Macintosh) agent-research-world-reader/1.0";

export type PageResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; status: number; message: string };

export async function fetchPage(
  rawUrl: string | null,
  { fetch: fetchImpl = globalThis.fetch, guard = assertPublicHost }: { fetch?: typeof fetch; guard?: (host: string) => Promise<void> } = {},
): Promise<PageResult> {
  let current: URL;
  try {
    current = new URL(rawUrl ?? "");
  } catch {
    return { ok: false, status: 400, message: "bad url" };
  }
  if (current.protocol !== "https:" && current.protocol !== "http:") return { ok: false, status: 400, message: "only http(s)" };
  const signal = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      await guard(current.hostname);
      const upstream = await fetchImpl(current, {
        redirect: "manual",
        signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      });
      const location = upstream.headers.get("location");
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        void upstream.body?.cancel().catch(() => {});
        current = new URL(location, current); // re-checked at the top of the loop
        if (current.protocol !== "https:" && current.protocol !== "http:") return { ok: false, status: 400, message: "only http(s)" };
        continue;
      }
      if (!upstream.ok) return { ok: false, status: 502, message: `upstream ${upstream.status}` };
      if (!/html/.test(upstream.headers.get("content-type") ?? "")) return { ok: false, status: 415, message: "not a web page" };
      const text = await upstream.text();
      return { ok: true, html: text.slice(0, MAX_PAGE_BYTES), finalUrl: current.href };
    }
    return { ok: false, status: 508, message: "too many redirects" };
  } catch (error) {
    if (error instanceof BlockedTargetError) return { ok: false, status: 403, message: "address not allowed" };
    return { ok: false, status: 502, message: error instanceof Error ? error.message : String(error) };
  }
}
