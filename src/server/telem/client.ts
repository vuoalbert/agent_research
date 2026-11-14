import { tavily } from "@tavily/core";
import Telem, {
  TelemError,
  buildMetadata,
  buildSnapshot,
  toolMarker,
  withTrajectory,
  type FetchResponse,
  type SearchResponse,
  type TrajectorySnapshot,
} from "@telemai/sdk";

import { sourceKey } from "@/lib/source-key";

import { emitTelemCall, type TelemCallMeta, type TelemCaller, type TelemProviderRun } from "./events";

/**
 * The app's one Telem client (https://docs.telem.ai) — web search and page
 * reads for the chat, its subagents, cross-reference and anything else on the
 * server. Server-only: the key is `process.env.TELEM_API_KEY` and never leaves.
 *
 * STABLE API (other features build on it — add, don't break):
 *   telemSearch(query, options?)  → { results: TelemSearchResult[], meta }
 *   telemFetch(urls, options?)    → { pages: TelemPage[], failed: TelemFetchFailure[], meta }
 *   createLineage({ chatId?, turnId?, question? }) → TelemLineage   one chat turn
 *   childLineage(parent, { agentId, title, task }) → TelemLineage   a subagent of that turn
 *   PLATFORMS / platformProviders(platform)          pinnable platform providers
 *   EMPHASES                                         provider lists by research emphasis
 * Every call also emits one `TelemCallMeta` on `onTelemCall` (./events.ts).
 *
 * LINEAGE (what Telem's Observe console shows as the research tree), built with
 * the SDK's trajectory helpers so the derived ids join Telem's own rows:
 *   - one Telem **session per chat**: conversationId = windowId = the app chatId
 *     (a random one when a caller has no chat), so every turn of a chat lands in
 *     the same session;
 *   - each **chat turn** is a model turn (`messageId` = turnId), and every search
 *     or read inside it is an event node of its own `trajectory_id`;
 *   - each **subagent** is its own conversation (`<chatId>/agent/<agentId>`)
 *     whose ancestors end in a snapshot of the lead at the delegating turn, so its
 *     calls carry `parent_trajectory_id` = that snapshot and the console draws the
 *     subagents side by side under the turn that deployed them.
 * The history sent with each call is the turn's question plus `telem_search` /
 * `telem_fetch` tool markers (the console reads goals from them).
 *
 * FALLBACK: when Telem itself errors (no key, network, 4xx/5xx, or a search
 * where every provider failed), the call is served by Tavily if
 * `TAVILY_API_KEY` is set — logged, and flagged `fallback: "tavily"` on the
 * meta. Results keep the same shape either way.
 */

export const TELEM_HARNESS = "agent-research";
/** search tier: `default` adds each result's summary, which the model reads to pick pages */
export const SEARCH_TIER = "default";
/** fetch tier: `default` is the page text plus title/canonical URL — enough to read and cite */
export const FETCH_TIER = "default";
/** rows each provider returns */
export const RESULTS_PER_PROVIDER = 5;
/** merged results one search hands back */
export const MAX_MERGED_RESULTS = 8;
/** Telem fetch takes at most this many URLs a call */
export const MAX_FETCH_URLS = 5;
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 45_000;
const HISTORY_MARKERS = 40;

/* ------------------------------------------------------------------ shapes */

export type TelemSearchResult = {
  title: string;
  url: string;
  /** the provider's summary / highlights for this page */
  excerpt: string;
  /** the first provider that returned it */
  provider: string;
  /** every provider that returned it */
  providers: string[];
  /** agreement: how many providers returned this page (higher = surfaced more widely) */
  score: number;
  publishedAt?: string;
};

export type TelemPage = { url: string; title: string; text: string; provider: string; truncated?: boolean };
export type TelemFetchFailure = { url: string; error: string };

/* ------------------------------------------------------------------ platforms */

/**
 * Pinnable platform providers (https://docs.telem.ai/resources/supported-platforms/).
 * Auto-routing never picks these, so a platform search names them and turns
 * routing off. One provider per platform where several exist: each is a charge.
 */
export const PLATFORMS = {
  x: ["fetchlayer_x"],
  youtube: ["socialdatax_youtube"],
  tiktok: ["fetchlayer_tiktok"],
  instagram: ["socialdatax_instagram"],
  linkedin: ["apify_linkedin"],
  substack: ["apify_substack"],
  quora: ["apify_quora"],
  pinterest: ["apify_pinterest"],
  telegram: ["tikhub_telegram"],
  weibo: ["tikhub_weibo"],
  zhihu: ["tikhub_zhihu"],
  bilibili: ["tikhub_bilibili"],
  xiaohongshu: ["socialdatax_xhs"],
  maps: ["outscraper_gmaps"],
  reviews: ["fetchlayer_trustpilot", "outscraper_tripadvisor"],
  products: ["fetchlayer_amazon"],
  producthunt: ["fetchlayer_producthunt"],
  apps: ["fetchlayer_playstore"],
  airbnb: ["fetchlayer_airbnb"],
  ads: ["fetchlayer_facebook_ads", "fetchlayer_linkedin_ads"],
  // specialist web sources (not platforms, but likewise only when named)
  pubmed: ["ncbi_pubmed"],
  sec: ["sec_edgar"],
  patents: ["uspto_applications"],
  clinical_trials: ["ctgov_studies"],
} as const satisfies Record<string, readonly string[]>;

export type TelemPlatform = keyof typeof PLATFORMS;
const PLATFORM_PROVIDERS: ReadonlySet<string> = new Set(Object.values(PLATFORMS).flat());
export const PLATFORM_NAMES = Object.keys(PLATFORMS) as TelemPlatform[];

export function platformProviders(platform: TelemPlatform): string[] {
  return [...PLATFORMS[platform]];
}

/**
 * Provider emphases, so parallel researchers draw from different indexes and
 * their sources overlap less. Auto-routing still picks among the listed ones.
 */
export const EMPHASES = {
  /** semantic / research-grade indexes: papers, primary docs, long-form analysis */
  deep: ["exa", "parallel", "seltz"],
  /** fresh reporting and answer engines with citations */
  news: ["perplexity", "linkup", "tavily"],
  /** classic broad web indexes */
  web: ["brave", "you", "ceramic"],
  /** what people are saying: X, YouTube, Substack — plus one general index to anchor */
  social: ["fetchlayer_x", "socialdatax_youtube", "apify_substack", "brave"],
} as const satisfies Record<string, readonly string[]>;

export type TelemEmphasis = keyof typeof EMPHASES;

/* ------------------------------------------------------------------ client */

let client: Telem | null = null;
let clientKey: string | undefined;

/** the shared SDK client, or null when TELEM_API_KEY is unset */
export function getTelem(): Telem | null {
  const apiKey = process.env.TELEM_API_KEY;
  if (!apiKey) return null;
  if (!client || clientKey !== apiKey) {
    client = new Telem({ apiKey, maxRetries: 1, userAgent: `${TELEM_HARNESS}/1` });
    clientKey = apiKey;
  }
  return client;
}

/** test-only: swap the SDK client (null restores the env-built one) */
export function __setTelemForTests(fake: Pick<Telem, "search" | "fetch"> | null) {
  client = fake as Telem | null;
  clientKey = fake ? process.env.TELEM_API_KEY : undefined;
}

/* ------------------------------------------------------------------ lineage */

type HistoryEntry = Record<string, string>;

export type TelemLineage = {
  readonly chatId: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly windowId: string;
  readonly agentId?: string;
  readonly agentTitle?: string;
  /** root-first snapshot chain; the last is the direct parent */
  readonly ancestors: readonly TrajectorySnapshot[];
  /** the question, then completed tool markers — grows as calls finish */
  readonly history: HistoryEntry[];
};

/** one chat turn's lineage: its Telem session is the chat's */
export function createLineage({
  chatId,
  turnId,
  question,
}: { chatId?: string; turnId?: string; question?: string } = {}): TelemLineage {
  const chat = chatId || `anon-${crypto.randomUUID()}`;
  return {
    chatId: chat,
    turnId: turnId || crypto.randomUUID(),
    conversationId: chat,
    windowId: chat,
    ancestors: [],
    history: question ? [{ role: "user", content: question }] : [],
  };
}

/** snapshots by parent lineage: subagents deployed in one turn share one parent node */
const snapshots = new WeakMap<TelemLineage, Promise<TrajectorySnapshot>>();

/** a subagent's lineage, a child of `parent`'s current turn */
export async function childLineage(
  parent: TelemLineage,
  { agentId, title, task }: { agentId: string; title: string; task: string },
): Promise<TelemLineage> {
  let snapshot = snapshots.get(parent);
  if (!snapshot) {
    snapshot = buildSnapshot({
      harness: TELEM_HARNESS,
      conversationId: parent.conversationId,
      windowId: parent.windowId,
      messageId: parent.turnId,
      context: parent.history.map((entry) => ({ ...entry })),
      ancestors: [...parent.ancestors],
    });
    snapshots.set(parent, snapshot);
  }
  const conversationId = `${parent.conversationId}/agent/${agentId}`;
  return {
    chatId: parent.chatId,
    turnId: `${parent.turnId}/agent/${agentId}`,
    conversationId,
    windowId: conversationId,
    agentId,
    agentTitle: title,
    ancestors: [...parent.ancestors, await snapshot],
    history: [{ role: "user", content: `${title}: ${task}` }],
  };
}

/** the call's trajectory envelope; `done` records it as completed in the lineage's history */
async function envelopeFor(lineage: TelemLineage, toolName: string, input: Record<string, unknown>) {
  const toolCallId = crypto.randomUUID();
  const envelope = await buildMetadata({
    harness: TELEM_HARNESS,
    conversationId: lineage.conversationId,
    windowId: lineage.windowId,
    messageId: lineage.turnId,
    toolCallId,
    history: [...lineage.history, { role: "assistant", content: toolMarker(toolName, "running", input) }],
    ancestors: lineage.ancestors as unknown as Record<string, unknown>[],
  });
  return {
    envelope,
    done() {
      lineage.history.push({ role: "assistant", content: toolMarker(toolName, "completed", input) });
      // keep the question and the most recent markers
      if (lineage.history.length > HISTORY_MARKERS + 1) {
        const [first, ...rest] = lineage.history;
        lineage.history.splice(0, lineage.history.length, first, ...rest.slice(-HISTORY_MARKERS));
      }
    },
  };
}

/* ------------------------------------------------------------------ helpers */

type Json = Record<string, unknown>;

const errorText = (error: unknown): string => {
  if (error instanceof TelemError) return `${error.code ?? "telem_error"}${error.status ? ` (${error.status})` : ""}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

const providerError = (error: unknown): string | undefined => {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  const e = error as Json;
  return String(e.message ?? e.code ?? JSON.stringify(error)).slice(0, 300);
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function idsOf(raw: Json) {
  return {
    sessionId: str(raw.session_id),
    interactionId: str(raw.interaction_id),
    trajectoryId: str(raw.trajectory_id),
    parentTrajectoryId: (str(raw.parent_trajectory_id) ?? null) as string | null,
  };
}

function lineageFields(lineage: TelemLineage | undefined) {
  if (!lineage) return {};
  return {
    chatId: lineage.chatId,
    turnId: lineage.turnId.split("/agent/")[0],
    ...(lineage.agentId ? { agentId: lineage.agentId, agentTitle: lineage.agentTitle } : {}),
  };
}

/**
 * Merge every provider's rows into one list: pages several providers returned
 * first (agreement), then by best rank, interleaving providers so one index
 * cannot crowd out the rest.
 */
export function mergeResults(response: Pick<SearchResponse, "byProvider">, limit = MAX_MERGED_RESULTS): TelemSearchResult[] {
  const merged = new Map<string, TelemSearchResult & { bestRank: number }>();
  for (const run of response.byProvider) {
    run.results.forEach((row, index) => {
      if (!row.url) return;
      const key = sourceKey(row.url);
      const excerpt = (row.summary ?? (row.excerpt ?? []).join(" ") ?? "").trim();
      const rank = row.rank ?? index + 1;
      const seen = merged.get(key);
      if (seen) {
        if (!seen.providers.includes(row.provider)) seen.providers.push(row.provider);
        seen.score = seen.providers.length;
        seen.bestRank = Math.min(seen.bestRank, rank);
        if (excerpt.length > seen.excerpt.length) seen.excerpt = excerpt;
        if (!seen.title || seen.title === seen.url) seen.title = row.title || seen.title;
        seen.publishedAt ??= row.publishDate ?? undefined;
        return;
      }
      merged.set(key, {
        title: row.title || row.url,
        url: row.url,
        excerpt,
        provider: row.provider,
        providers: [row.provider],
        score: 1,
        bestRank: rank,
        ...(row.publishDate ? { publishedAt: row.publishDate } : {}),
      });
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank)
    .slice(0, limit)
    .map(({ bestRank: _bestRank, ...result }) => result);
}

/* ------------------------------------------------------------------ search */

export type TelemSearchOptions = {
  lineage?: TelemLineage;
  caller?: TelemCaller;
  /** pin these providers (overrides `emphasis`) */
  providers?: string[];
  /** search a platform's own provider(s) — X, YouTube, Maps, reviews, … */
  platform?: TelemPlatform;
  /** draw from one family of indexes (subagents use this to overlap less) */
  emphasis?: TelemEmphasis;
  tier?: string;
  numResults?: number;
  maxResults?: number;
  publishedAfter?: string;
  includeDomains?: string[];
  /** why the agent searched: recorded by Telem, shown in its console */
  goal?: string;
  context?: string;
  signal?: AbortSignal;
};

export type TelemSearchOutcome = { results: TelemSearchResult[]; meta: TelemCallMeta };

class AllProvidersFailed extends Error {}

export async function telemSearch(query: string, options: TelemSearchOptions = {}): Promise<TelemSearchOutcome> {
  const startedAt = Date.now();
  const pinned = options.providers?.length
    ? options.providers
    : options.platform
      ? platformProviders(options.platform)
      : options.emphasis
        ? [...EMPHASES[options.emphasis]]
        : undefined;
  // an explicit list is the caller's decision, and platform providers are
  // pin-only (auto-routing never chooses them): route only among general indexes
  const autoRouting: "accuracy" | "off" =
    options.providers?.length || pinned?.some((name) => PLATFORM_PROVIDERS.has(name)) ? "off" : "accuracy";
  const tier = options.tier ?? SEARCH_TIER;
  const base: Omit<TelemCallMeta, "status" | "providers" | "resultCount" | "latencyMs" | "finishedAt"> = {
    id: crypto.randomUUID(),
    kind: "search",
    caller: options.caller ?? (options.lineage?.agentId ? "subagent" : "chat"),
    ...lineageFields(options.lineage),
    query,
    ...(pinned ? { pinnedProviders: pinned } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    tier,
    autoRouting,
    startedAt,
  };
  const settle = (meta: Partial<TelemCallMeta> & Pick<TelemCallMeta, "status" | "providers" | "resultCount">) => {
    const finishedAt = Date.now();
    const full: TelemCallMeta = { ...base, ...meta, finishedAt, latencyMs: finishedAt - startedAt };
    emitTelemCall(full);
    return full;
  };

  const telem = getTelem();
  let telemFailure: string;
  try {
    if (!telem) throw new Error("TELEM_API_KEY is not set on the server");
    const marker = options.lineage
      ? await envelopeFor(options.lineage, "telem_search", { query, ...(options.goal ? { goal: options.goal } : {}) })
      : undefined;
    const sdkOptions = {
      tier,
      numResults: options.numResults ?? RESULTS_PER_PROVIDER,
      autoRouting,
      ...(pinned ? { providersInclude: pinned } : {}),
      ...(options.publishedAfter ? { publishedAfter: options.publishedAfter } : {}),
      ...(options.includeDomains?.length ? { includeDomains: options.includeDomains } : {}),
      ...(options.goal ? { goal: options.goal } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      metadata: { caller: base.caller },
    };
    const response = await telem.search(
      query,
      marker ? withTrajectory(sdkOptions, marker.envelope) : sdkOptions,
    );
    marker?.done();
    const providers: TelemProviderRun[] = response.byProvider.map((run) => ({
      provider: run.provider,
      status: run.status,
      latencyMs: run.latencyMs,
      results: run.results.length,
      ...(run.error ? { error: providerError(run.error) } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
    }));
    if (response.status === "failed" && response.results.length === 0) {
      throw new AllProvidersFailed(
        `every provider failed: ${providers.map((p) => `${p.provider} ${p.error ?? p.status}`).join("; ") || "no providers ran"}`,
      );
    }
    const results = mergeResults(response, options.maxResults ?? MAX_MERGED_RESULTS);
    const meta = settle({
      ...idsOf(response.raw),
      status: response.status,
      providers,
      routing: (response.raw as Json).routing,
      resultCount: results.length,
    });
    return { results, meta };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    telemFailure = errorText(error);
  }

  // Telem failed: Tavily, if it is configured, keeps the research going
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    settle({ status: "error", providers: [], resultCount: 0, error: telemFailure });
    throw new Error(`Telem search failed: ${telemFailure}`);
  }
  console.warn(`[telem] search failed (${telemFailure}); falling back to Tavily for "${query.slice(0, 80)}"`);
  const t0 = Date.now();
  try {
    const response = await tavily({ apiKey: tavilyKey }).search(query, {
      searchDepth: "basic",
      maxResults: Math.min(options.maxResults ?? MAX_MERGED_RESULTS, 10),
    });
    const results: TelemSearchResult[] = response.results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      excerpt: r.content ?? "",
      provider: "tavily",
      providers: ["tavily"],
      score: 1,
      ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
    }));
    const meta = settle({
      status: "succeeded",
      providers: [{ provider: "tavily", status: "succeeded", latencyMs: Date.now() - t0, results: results.length }],
      resultCount: results.length,
      fallback: "tavily",
      error: telemFailure,
    });
    return { results, meta };
  } catch (fallbackError) {
    const message = `${telemFailure}; Tavily fallback: ${errorText(fallbackError)}`;
    settle({ status: "error", providers: [], resultCount: 0, fallback: "tavily", error: message });
    throw new Error(`Web search failed: ${message}`);
  }
}

/* ------------------------------------------------------------------ fetch */

export type TelemFetchOptions = {
  lineage?: TelemLineage;
  caller?: TelemCaller;
  /** pin the fetch chain (in order); omit for Telem's failover chain */
  providers?: string[];
  tier?: string;
  /** read live, skipping Telem's shared fetch cache */
  noCache?: boolean;
  /** recorded with the call, shown in Telem's console */
  goal?: string;
  signal?: AbortSignal;
};

export type TelemFetchOutcome = { pages: TelemPage[]; failed: TelemFetchFailure[]; meta: TelemCallMeta };

/** read 1-5 pages (more are batched 5 at a time) */
export async function telemFetch(urls: readonly string[], options: TelemFetchOptions = {}): Promise<TelemFetchOutcome> {
  const list = [...new Set(urls)];
  if (list.length > MAX_FETCH_URLS) {
    const chunks: string[][] = [];
    for (let i = 0; i < list.length; i += MAX_FETCH_URLS) chunks.push(list.slice(i, i + MAX_FETCH_URLS));
    const outcomes = await Promise.all(chunks.map((chunk) => telemFetch(chunk, options)));
    return {
      pages: outcomes.flatMap((o) => o.pages),
      failed: outcomes.flatMap((o) => o.failed),
      meta: outcomes[outcomes.length - 1].meta,
    };
  }

  const startedAt = Date.now();
  const tier = options.tier ?? FETCH_TIER;
  const base: Omit<TelemCallMeta, "status" | "providers" | "resultCount" | "latencyMs" | "finishedAt"> = {
    id: crypto.randomUUID(),
    kind: "fetch",
    caller: options.caller ?? (options.lineage?.agentId ? "subagent" : "chat"),
    ...lineageFields(options.lineage),
    urls: list,
    ...(options.providers?.length ? { pinnedProviders: options.providers } : {}),
    tier,
    startedAt,
  };
  const settle = (meta: Partial<TelemCallMeta> & Pick<TelemCallMeta, "status" | "providers" | "resultCount">) => {
    const finishedAt = Date.now();
    const full: TelemCallMeta = { ...base, ...meta, finishedAt, latencyMs: finishedAt - startedAt };
    emitTelemCall(full);
    return full;
  };

  const telem = getTelem();
  let telemFailure: string;
  try {
    if (!telem) throw new Error("TELEM_API_KEY is not set on the server");
    const marker = options.lineage
      ? await envelopeFor(options.lineage, "telem_fetch", { urls: list, ...(options.goal ? { goal: options.goal } : {}) })
      : undefined;
    const sdkOptions = {
      tier,
      ...(options.providers?.length ? { providers: options.providers } : {}),
      ...(options.noCache !== undefined ? { noCache: options.noCache } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      metadata: { caller: base.caller },
    };
    const response: FetchResponse = await telem.fetch(list, marker ? withTrajectory(sdkOptions, marker.envelope) : sdkOptions);
    marker?.done();
    const pages: TelemPage[] = [];
    const failed: TelemFetchFailure[] = [];
    for (const page of response.results) {
      if (page.content && page.status !== "failed") {
        pages.push({
          url: page.url,
          title: page.title || page.url,
          text: page.content,
          provider: page.provider,
          ...(page.contentTruncated ? { truncated: true } : {}),
        });
      } else {
        failed.push({ url: page.url, error: providerError(page.error) ?? page.status ?? "no content" });
      }
    }
    if (pages.length === 0 && response.status === "failed") {
      throw new AllProvidersFailed(failed.map((f) => `${f.url}: ${f.error}`).join("; ") || "no page could be read");
    }
    const meta = settle({
      ...idsOf(response.raw),
      status: response.status,
      providers: response.results.map((page) => ({
        provider: page.provider || "none",
        status: page.status,
        latencyMs: page.latencyMs,
        results: page.content ? 1 : 0,
        ...(page.error ? { error: providerError(page.error) } : {}),
      })),
      resultCount: pages.length,
      failedCount: failed.length,
    });
    return { pages, failed, meta };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    telemFailure = errorText(error);
  }

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    settle({ status: "error", providers: [], resultCount: 0, error: telemFailure });
    throw new Error(`Telem fetch failed: ${telemFailure}`);
  }
  console.warn(`[telem] fetch failed (${telemFailure}); falling back to Tavily Extract for ${list.length} page(s)`);
  const t0 = Date.now();
  try {
    const response = await tavily({ apiKey: tavilyKey }).extract(list, { extractDepth: "basic", format: "text" });
    const pages: TelemPage[] = (response.results ?? [])
      .filter((p) => p.rawContent)
      .map((p) => ({ url: p.url, title: p.title || p.url, text: p.rawContent, provider: "tavily" }));
    const failed: TelemFetchFailure[] = (response.failedResults ?? []).map((p) => ({ url: p.url, error: p.error }));
    const meta = settle({
      status: pages.length ? (failed.length ? "partially_succeeded" : "succeeded") : "failed",
      providers: [{ provider: "tavily", status: "succeeded", latencyMs: Date.now() - t0, results: pages.length }],
      resultCount: pages.length,
      failedCount: failed.length,
      fallback: "tavily",
      error: telemFailure,
    });
    return { pages, failed, meta };
  } catch (fallbackError) {
    const message = `${telemFailure}; Tavily fallback: ${errorText(fallbackError)}`;
    settle({ status: "error", providers: [], resultCount: 0, fallback: "tavily", error: message });
    throw new Error(`Reading pages failed: ${message}`);
  }
}
