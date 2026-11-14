import type { FetchResponse, SearchResponse, SearchResult } from "@telemai/sdk";
import { vi } from "vitest";

import { __setTelemForTests } from "@/server/telem/client";

/**
 * A stand-in for the Telem SDK client in tests: `search` / `fetch` are mocks
 * that resolve SDK-shaped responses built by `searchResponse` / `fetchResponse`.
 * `installTelemFake()` sets TELEM_API_KEY and routes the shared client to it.
 */

type Row = { title?: string; url: string; summary?: string | null; publishDate?: string | null };

export const IDS = {
  session_id: "sess-1",
  interaction_id: "int-1",
  trajectory_id: "traj-1",
  parent_trajectory_id: null,
};

const row = (provider: string, r: Row, index: number): SearchResult => ({
  url: r.url,
  title: r.title ?? "",
  summary: r.summary ?? null,
  excerpt: null,
  fullContent: null,
  publishDate: r.publishDate ?? null,
  rank: index + 1,
  thumbnail: null,
  favicon: null,
  source: null,
  enrichments: null,
  fetchMeta: null,
  provider,
  raw: {},
});

/** a search response: rows by provider (a plain list is one "exa" run) */
export function searchResponse(
  runs: Row[] | Record<string, Row[]>,
  { status = "succeeded", raw = {} }: { status?: string; raw?: Record<string, unknown> } = {},
): SearchResponse {
  const byProvider = Object.entries(Array.isArray(runs) ? { exa: runs } : runs).map(([provider, rows], batch) => ({
    provider,
    status: "succeeded",
    results: rows.map((r, i) => row(provider, r, i)),
    error: null,
    latencyMs: 100 + batch,
    preprocessorRunId: null,
    tier: "default",
    fields: [],
    query: "",
    batchIndex: 0,
    answer: null,
    entities: null,
    related: null,
    verticals: null,
    usage: null,
    warnings: [],
    sameStory: null,
    raw: null,
  }));
  return {
    results: byProvider.flatMap((run) => run.results),
    byProvider,
    sessionId: IDS.session_id,
    interactionId: IDS.interaction_id,
    status,
    normalizedSchemaVersion: 2,
    raw: { ...IDS, status, routing: [{ topic: "news", providers: byProvider.map((r) => r.provider) }], ...raw },
  };
}

type Page = { url: string; title?: string; content?: string | null; status?: string; error?: unknown; provider?: string };

/** a fetch response: one result per page; a page without content is a failure */
export function fetchResponse(pages: Page[], { status }: { status?: string } = {}): FetchResponse {
  const results = pages.map((p, batchIndex) => {
    const ok = p.content != null && p.status !== "failed";
    return {
      url: p.url,
      canonicalUrl: null,
      title: p.title ?? "",
      status: p.status ?? (ok ? "succeeded" : "failed"),
      content: p.content ?? null,
      contentTruncated: null,
      contentFormat: "markdown",
      contentSha256: null,
      contentType: null,
      contentRef: null,
      provider: p.provider ?? (ok ? "jina" : ""),
      httpStatus: ok ? 200 : null,
      fetchedAt: null,
      latencyMs: 50,
      providerMetadata: null,
      error: (p.error ?? (ok ? null : { message: "failed" })) as Record<string, unknown> | null,
      batchIndex,
      raw: {},
    };
  });
  const okCount = results.filter((r) => r.content).length;
  const overall = status ?? (okCount === results.length ? "succeeded" : okCount ? "partially_succeeded" : "failed");
  return { results, sessionId: IDS.session_id, interactionId: IDS.interaction_id, status: overall, raw: { ...IDS, status: overall } };
}

export function installTelemFake() {
  const search = vi.fn();
  const fetch = vi.fn();
  vi.stubEnv("TELEM_API_KEY", "test-telem-key");
  __setTelemForTests({ search, fetch } as never);
  return { search, fetch };
}

type TavilyLikeSearch = { results?: { title?: string; url: string; content?: string }[] };
type TavilyLikeExtract = { results?: { url: string; title?: string | null; rawContent?: string }[]; failedResults?: { url: string; error: string }[] };

/**
 * The Telem fake, answering from fixtures in the simple `{ results: [{ title, url, content }] }` /
 * `{ results: [{ url, title, rawContent }], failedResults }` shape that older tests were written in:
 * `search(query, options)` and `extract(urls, options)` are the caller's mocks.
 */
export function installTelemFakeFrom({
  search,
  extract,
}: {
  search?: (query: string, options: unknown) => Promise<TavilyLikeSearch> | TavilyLikeSearch;
  extract?: (urls: string[], options: unknown) => Promise<TavilyLikeExtract> | TavilyLikeExtract;
}) {
  const fake = installTelemFake();
  fake.search.mockImplementation(async (query: string, options: unknown) => {
    const response = (await search?.(query, options)) ?? {};
    return searchResponse((response.results ?? []).map((r) => ({ title: r.title, url: r.url, summary: r.content })));
  });
  fake.fetch.mockImplementation(async (urls: string[], options: unknown) => {
    const response = (await extract?.(urls, options)) ?? {};
    return fetchResponse([
      ...(response.results ?? []).map((p) => ({ url: p.url, title: p.title ?? undefined, content: p.rawContent ?? null })),
      ...(response.failedResults ?? []).map((f) => ({ url: f.url, error: { message: f.error } })),
    ]);
  });
  return fake;
}
