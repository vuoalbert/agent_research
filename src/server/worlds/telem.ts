// Ported from nyc-world by menonsprithvi-web (server.mjs @ a4e4a44: the
// per-label Telem search plan + trust scoring for /api/sources, Telem Fetch
// for /api/read and the chat's telem_fetch), with this app's SSRF guard on
// reads. Every Telem call goes through the shared client
// (src/server/telem/client.ts), so it carries the chat's lineage and is
// reported on onTelemCall like the rest of the app's Telem traffic.

import { assertPublicHost } from "@/app/api/embed-check/check";
import {
  createLineage,
  telemFetch,
  telemSearch,
  type TelemFetchOptions,
  type TelemFetchOutcome,
  type TelemLineage,
  type TelemSearchOptions,
  type TelemSearchOutcome,
} from "@/server/telem/client";

/**
 * Telem AI for the World Labs screens and their chat: each label's topic runs
 * as a small search plan (four Telem searches in parallel, each auto-routed
 * across engines with its own settings), the results are scored for trust
 * here (the trust badge on each screen), merged and picked round-robin across
 * the steps; Telem Fetch reads pages our own reader cannot. Needs
 * TELEM_API_KEY; without it the screens fall back to Wikipedia + OpenAlex.
 */

export const telemKey = () => process.env.TELEM_API_KEY;
/** the `caller` on every World Labs Telem call (onTelemCall / usage) */
export const WORLD_CALLER = "world";

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
/** governments that don't use .gov (cities, provinces, transit authorities) */
const CIVIC = ["toronto.ca", "canada.ca", "ontario.ca", "vancouver.ca", "montreal.ca", "paris.fr", "service-public.fr",
  "bund.de", "berlin.de", "tokyo.lg.jp", "go.jp", "gov.sg", "gov.au", "govt.nz", "mta.info", "panynj.gov", "tfl.gov.uk",
  "london.gov.uk", "nycedc.com", "nysenate.gov", "europarl.europa.eu"];
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
  if (CIVIC.some((d) => endsWith(host, d))) return { score: 0.9, label: "Government", host };
  if (/\.museum$/.test(host) || /museum/.test(host.split(".")[0])) return { score: 0.86, label: "Museum / library", host };
  for (const [score, label, list] of TRUSTED) if (list.some((d) => endsWith(host, d))) return { score, label, host };
  if (/\.org$/.test(host)) return { score: 0.55, label: "Organisation", host };
  return { score: 0.4, label: "Unverified", host };
}
export const TRUST_MIN = 0.7;

/** same page, different spelling: drop protocol, www, trailing slash and #hash */
export const normUrl = (u: string) => {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase();
  } catch {
    return u;
  }
};

/** ---- The search plan: each label / question becomes a few Telem searches. ---- */

export const OFFICIAL = ["gov.uk", "europa.eu", "un.org", "who.int", "worldbank.org", "oecd.org", "nyc.gov", "ny.gov", "usa.gov",
  "census.gov", "transportation.gov", "epa.gov", "nasa.gov", "loc.gov", "nps.gov", "nih.gov", "noaa.gov", "energy.gov", "ca.gov", "mta.info"];
export const RESEARCH = ["nature.com", "sciencedirect.com", "springer.com", "wiley.com", "tandfonline.com", "jstor.org", "sagepub.com",
  "cambridge.org", "academic.oup.com", "plos.org", "pnas.org", "ieee.org", "acm.org", "arxiv.org", "mit.edu", "harvard.edu",
  "stanford.edu", "berkeley.edu", "columbia.edu", "nyu.edu"];
export const NEWS = ["reuters.com", "apnews.com", "bbc.com", "nytimes.com", "npr.org", "theguardian.com", "washingtonpost.com",
  "bloomberg.com", "theatlantic.com", "wired.com", "technologyreview.com", "scientificamerican.com", "economist.com", "pbs.org"];
const yearAgo = (now: number) => new Date(now - 365 * 864e5).toISOString().slice(0, 10);

export type PlanIntent = "overview" | "official" | "research" | "news";
export const PLAN_INTENTS: PlanIntent[] = ["overview", "official", "research", "news"];

type PlanStep = { search: Pick<TelemSearchOptions, "numResults" | "includeDomains" | "publishedAfter" | "goal">; note: string };

/** every step is its own Telem call, auto-routed across providers, with options suited to its job */
export const PLAN_STEPS: Record<PlanIntent, (now: number) => PlanStep> = {
  overview: () => ({ search: { numResults: 8, goal: "overview" }, note: "auto-routed across all engines" }),
  official: () => ({
    search: { numResults: 5, includeDomains: OFFICIAL, goal: "official sources" },
    note: `limited to ${OFFICIAL.length} government / intergovernmental sites`,
  }),
  research: () => ({
    search: { numResults: 5, includeDomains: RESEARCH, goal: "research sources" },
    note: `limited to ${RESEARCH.length} journals and universities`,
  }),
  news: (now) => ({
    search: { numResults: 5, includeDomains: NEWS, publishedAfter: yearAgo(now), goal: "recent news" },
    note: `${NEWS.length} reputable outlets, published in the last 12 months`,
  }),
};

export type TrustedResult = {
  url: string;
  title: string;
  summary: string;
  rank: number;
  provider?: string;
  /** the plan step that found it (its best-trust sighting) */
  intent: PlanIntent;
  /** every plan step that found it */
  intents: PlanIntent[];
  trust: Trust;
};
export type StepRun = { intent: PlanIntent; note: string; providers: string[]; ms: number; results: Omit<TrustedResult, "intents">[]; error?: string };
export type StepTrace = { intent: PlanIntent; note: string; providers: string[]; ms: number; found: number; kept: number; error?: string };
export type PlanResult = {
  query: string;
  trace: StepTrace[];
  ms: number;
  providers: string[];
  total: number;
  dropped: { host: string; label: string }[];
  results: TrustedResult[];
};

/** at most this many pages from one site on a label's screens */
const PER_HOST = 2;

/**
 * Merge the plan's runs: one entry per page (normalised URL) keeping its
 * best-trust sighting, only trustworthy ones, then picked round-robin across
 * the steps (variety) with at most two pages per site.
 */
export function mergePlan(query: string, runs: StepRun[], ms: number): PlanResult {
  const byUrl = new Map<string, TrustedResult>();
  for (const run of runs) {
    for (const r of run.results) {
      const k = normUrl(r.url);
      const prev = byUrl.get(k);
      if (!prev || r.trust.score > prev.trust.score) byUrl.set(k, { ...r, intents: [...new Set([...(prev?.intents ?? []), r.intent])] });
      else prev.intents = [...new Set([...prev.intents, r.intent])];
    }
  }
  const all = [...byUrl.values()];
  const trusted = all.filter((r) => r.trust.score >= TRUST_MIN).sort((a, b) => b.trust.score - a.trust.score || a.rank - b.rank);
  const perHost = new Map<string, number>();
  const queues = runs.map((run) => trusted.filter((r) => r.intent === run.intent));
  const picked: TrustedResult[] = [];
  const pickedKeys = new Set<string>();
  while (queues.some((q) => q.length)) {
    for (const q of queues) {
      while (q.length) {
        const r = q.shift()!;
        const k = normUrl(r.url);
        if (pickedKeys.has(k) || (perHost.get(r.trust.host) ?? 0) >= PER_HOST) continue;
        perHost.set(r.trust.host, (perHost.get(r.trust.host) ?? 0) + 1);
        pickedKeys.add(k);
        picked.push(r);
        break;
      }
    }
  }
  return {
    query,
    trace: runs.map((run) => ({
      intent: run.intent,
      note: run.note,
      providers: run.providers,
      ms: run.ms,
      found: run.results.length,
      kept: picked.filter((p) => p.intent === run.intent).length,
      ...(run.error ? { error: run.error } : {}),
    })),
    ms,
    providers: [...new Set(runs.flatMap((r) => r.providers))],
    total: all.length,
    dropped: all.filter((r) => r.trust.score < TRUST_MIN).map((r) => ({ host: r.trust.host, label: r.trust.label })),
    results: picked,
  };
}

type Search = (query: string, options?: TelemSearchOptions) => Promise<TelemSearchOutcome>;

/** run the plan's steps in parallel through the shared Telem client; a failed step is reported, not thrown */
export async function planSearch(
  q: string,
  steps: PlanIntent[] = PLAN_INTENTS,
  { lineage, search = telemSearch, now = Date.now, signal }: { lineage?: TelemLineage; search?: Search; now?: () => number; signal?: AbortSignal } = {},
): Promise<PlanResult> {
  const t0 = now();
  const runs = await Promise.all(
    steps.map(async (intent): Promise<StepRun> => {
      const step = PLAN_STEPS[intent](t0);
      const s0 = now();
      try {
        // keep every merged row: trust filtering happens here, not in the client
        const { results, meta } = await search(q, { ...step.search, maxResults: 50, lineage, caller: WORLD_CALLER, signal });
        return {
          intent,
          note: step.note,
          providers: meta.providers.filter((p) => p.results > 0).map((p) => p.provider),
          ms: now() - s0,
          results: results
            .filter((r) => /^https?:\/\//.test(r.url))
            .map((r, i) => ({ url: r.url, title: r.title || r.url, summary: r.excerpt ?? "", rank: i + 1, provider: r.provider, intent, trust: trustOf(r.url) })),
        };
      } catch (error) {
        return { intent, note: step.note, providers: [], ms: now() - s0, results: [], error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return mergePlan(q, runs, now() - t0);
}

/** ---- Telem Fetch: /api/world/read and the chat's telem_fetch ---- */

export type ReadResult =
  | { ok: true; url: string; title: string; content: string; provider: string | null; trust: Trust }
  | { ok: false; status: number; error: string };

type Fetch = (urls: readonly string[], options?: TelemFetchOptions) => Promise<TelemFetchOutcome>;

/** clean page content (markdown) for sites our own reader can't read; public hosts only */
export async function readWithTelem(
  rawUrl: string | null,
  {
    lineage,
    maxChars,
    read = telemFetch,
    guard = assertPublicHost,
    signal,
  }: { lineage?: TelemLineage; maxChars?: number; read?: Fetch; guard?: (host: string) => Promise<void>; signal?: AbortSignal } = {},
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
    const { pages } = await read([target.href], { lineage, caller: WORLD_CALLER, signal });
    const doc = pages.find((p) => p.text);
    if (!doc) return { ok: false, status: 502, error: "Telem could not read this page" };
    const url = doc.url && /^https?:\/\//.test(doc.url) ? doc.url : target.href;
    const content = maxChars ? doc.text.slice(0, maxChars) : doc.text;
    return { ok: true, url, title: doc.title === doc.url ? "" : doc.title, content, provider: doc.provider || null, trust: trustOf(url) };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
  }
}

/** ---- Lineage: World Labs calls join the chat's own Telem session ---- */

/** the chat id a viewer request names (`?chat=` / body.chatId), if it looks like one */
export function worldChatId(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[\w-]{1,128}$/.test(raw) ? raw : undefined;
}

export function worldLineage(chatId: unknown, question?: string): TelemLineage {
  return createLineage({ chatId: worldChatId(chatId), question: question?.slice(0, 2000) });
}
