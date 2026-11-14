// Ported from nyc-world by menonsprithvi-web (server.mjs @ e4c0f97: Telem
// search + trust scoring for /api/sources, Telem Fetch for /api/read), with
// this app's SSRF guard on reads. Swap in the shared src/server/telem/client.ts
// once it lands on main.

import { assertPublicHost } from "@/app/api/embed-check/check";

/**
 * Telem AI (https://router.telem.ai) for the World Labs screens: a search
 * auto-routed across engines, filtered here to trustworthy sources (each
 * scored and labelled — the trust badge on its screen), and Telem Fetch for
 * pages our own reader cannot read. Needs TELEM_API_KEY; without it the
 * screens fall back to Wikipedia + OpenAlex.
 */

export const TELEM_BASE = "https://router.telem.ai";
export const telemKey = () => process.env.TELEM_API_KEY;

export async function telem<T = unknown>(path: string, body: unknown, timeoutMs = 20_000, fetchImpl: typeof fetch = globalThis.fetch): Promise<T> {
  const res = await fetchImpl(TELEM_BASE + path, {
    method: "POST",
    headers: { authorization: `Bearer ${telemKey()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Telem ${path} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** ---- Trust scoring: why a source deserves a screen. ---- */

export type Trust = { score: number; label: string; host: string };

const TRUSTED: [number, string, string[]][] = [
  [0.92, "Peer-reviewed publisher", ["nature.com", "science.org", "sciencedirect.com", "springer.com", "link.springer.com",
    "wiley.com", "tandfonline.com", "jstor.org", "plos.org", "cell.com", "thelancet.com", "nejm.org", "bmj.com", "pnas.org",
    "acm.org", "ieee.org", "cambridge.org", "academic.oup.com", "sagepub.com", "annualreviews.org", "aps.org", "iop.org"]],
  [0.9, "Intergovernmental", ["un.org", "who.int", "worldbank.org", "oecd.org", "imf.org", "unesco.org", "europa.eu", "ipcc.ch"]],
  [0.86, "Museum / library", ["metmuseum.org", "moma.org", "britishmuseum.org", "nypl.org", "archive.org", "si.edu",
    "smithsonianmag.com", "nationalgeographic.com", "mcny.org"]],
  [0.85, "Encyclopedia", ["britannica.com", "plato.stanford.edu", "iep.utm.edu"]],
  [0.82, "Reputable news", ["reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "nytimes.com", "npr.org", "pbs.org",
    "theguardian.com", "washingtonpost.com", "wsj.com", "economist.com", "ft.com", "bloomberg.com", "theatlantic.com",
    "newyorker.com", "scientificamerican.com", "wired.com", "arstechnica.com", "technologyreview.com", "citylab.com"]],
  [0.8, "Encyclopedia (cited)", ["wikipedia.org"]],
  [0.74, "Preprint / scholarly index", ["arxiv.org", "biorxiv.org", "ssrn.com", "researchgate.net", "semanticscholar.org",
    "openalex.org", "doi.org", "mdpi.com", "frontiersin.org", "hindawi.com"]],
];
const BLOCKED = ["reddit.com", "quora.com", "medium.com", "substack.com", "pinterest.com", "tiktok.com", "facebook.com",
  "instagram.com", "x.com", "twitter.com", "youtube.com", "linkedin.com", "fandom.com", "blogspot.com", "wordpress.com",
  "tumblr.com", "answers.com", "wikihow.com", "steamcommunity.com"];
const endsWith = (host: string, d: string) => host === d || host.endsWith("." + d);

export function trustOf(url: string): Trust {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { score: 0, label: "Invalid", host: "" };
  }
  if (BLOCKED.some((d) => endsWith(host, d))) return { score: 0.1, label: "User-generated / social", host };
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /(^|\.)gov\.[a-z]{2}$/.test(host)) return { score: 0.95, label: "Government", host };
  if (/\.(edu)(\.[a-z]{2})?$/.test(host) || /\.ac\.[a-z]{2}$/.test(host)) return { score: 0.9, label: "University", host };
  if (/\.int$/.test(host)) return { score: 0.9, label: "Intergovernmental", host };
  for (const [score, label, list] of TRUSTED) if (list.some((d) => endsWith(host, d))) return { score, label, host };
  if (/\.org$/.test(host)) return { score: 0.55, label: "Organisation", host };
  return { score: 0.4, label: "Unverified", host };
}
export const TRUST_MIN = 0.7;

/** ---- GET /api/world/sources?q= ---- */

type SearchRun = { preprocessor_name?: string; output_payload?: { results?: { url?: string; title?: string; summary?: string; excerpt?: string; rank?: number }[] } };
export type TrustedResult = { url: string; title: string; summary: string; rank: number; provider?: string; trust: Trust };

/**
 * Telem search (auto-routed across providers), then only the trustworthy
 * results, ranked by trust then provider rank, at most two per site — and
 * what was routed, found and dropped, for the chat panel to report.
 */
export async function searchTrusted(q: string, { fetch: fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const t0 = now();
  const out = await telem<{ preprocessor_runs?: SearchRun[] }>(
    "/v1/search",
    { user_input: { query: q }, search: { auto_routing: "accuracy", num_results: 10, tier: "default" } },
    20_000,
    fetchImpl,
  );
  const runs = out.preprocessor_runs ?? [];
  const seen = new Set<string>();
  const all: TrustedResult[] = [];
  for (const run of runs) {
    for (const r of run.output_payload?.results ?? []) {
      if (!r?.url || seen.has(r.url) || !/^https?:\/\//.test(r.url)) continue;
      seen.add(r.url);
      all.push({ url: r.url, title: r.title ?? r.url, summary: r.summary ?? r.excerpt ?? "", rank: r.rank ?? 99, provider: run.preprocessor_name, trust: trustOf(r.url) });
    }
  }
  const perHost = new Map<string, number>();
  const kept = all
    .filter((r) => r.trust.score >= TRUST_MIN)
    .sort((a, b) => b.trust.score - a.trust.score || a.rank - b.rank)
    .filter((r) => {
      const n = perHost.get(r.trust.host) ?? 0;
      perHost.set(r.trust.host, n + 1);
      return n < 2;
    });
  return {
    query: q,
    providers: runs.map((r) => r.preprocessor_name).filter(Boolean),
    total: all.length,
    dropped: all.filter((r) => r.trust.score < TRUST_MIN).map((r) => ({ host: r.trust.host, label: r.trust.label })),
    results: kept,
    ms: now() - t0,
  };
}

/** ---- GET /api/world/read?url= ---- */

type FetchRun = { output_payload?: { fetched_results?: { url?: string; title?: string; content?: string; provider?: string }[] } };

export type ReadResult =
  | { ok: true; url: string; title: string; content: string; provider: string | null; trust: Trust }
  | { ok: false; status: number; error: string };

/** Telem Fetch: clean page content (markdown) for sites our own reader can't read; public hosts only */
export async function readWithTelem(
  rawUrl: string | null,
  { fetch: fetchImpl = globalThis.fetch, guard = assertPublicHost }: { fetch?: typeof fetch; guard?: (host: string) => Promise<void> } = {},
): Promise<ReadResult> {
  let target: URL;
  try {
    target = new URL(rawUrl ?? "");
  } catch {
    return { ok: false, status: 400, error: "bad url" };
  }
  if (!/^https?:$/.test(target.protocol)) return { ok: false, status: 400, error: "only http(s)" };
  try {
    await guard(target.hostname);
  } catch {
    return { ok: false, status: 403, error: "address not allowed" };
  }
  if (!telemKey()) return { ok: false, status: 503, error: "TELEM_API_KEY is not set" };
  try {
    const out = await telem<{ preprocessor_runs?: FetchRun[] }>("/v1/fetch", { urls: [target.href], options: { tier: "default" } }, 30_000, fetchImpl);
    const doc = (out.preprocessor_runs ?? []).flatMap((r) => r.output_payload?.fetched_results ?? []).find((d) => d?.content);
    if (!doc?.content) return { ok: false, status: 502, error: "Telem could not read this page" };
    const url = doc.url && /^https?:\/\//.test(doc.url) ? doc.url : target.href;
    return { ok: true, url, title: doc.title ?? "", content: doc.content, provider: doc.provider ?? null, trust: trustOf(url) };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
  }
}
