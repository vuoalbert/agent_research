import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  MAX_FETCH_URLS,
  MAX_MERGED_RESULTS,
  PLATFORM_NAMES,
  createLineage,
  telemFetch,
  telemSearch,
  type TelemEmphasis,
  type TelemLineage,
  type TelemPlatform,
} from "@/server/telem/client";

/**
 * Web search and page reading for /api/chat, both through Telem
 * (`src/server/telem/client.ts`): `web_search` finds candidate sources across
 * several providers (auto-routed, or pinned to a platform or a provider list),
 * `web_read` reads a few of them in full through Telem's fetch failover chain,
 * so facts can be cross-referenced rather than taken from a search snippet.
 *
 * An in-process SDK MCP server built per request (the chat's, or one per
 * subagent), so the handler closes over that request's stream and lineage: it
 * reports each call to the client (`onActivity`) as it starts and ends, and
 * every call carries the turn's (or subagent's) Telem trajectory. Tavily is
 * used only when Telem itself fails — the client falls back and logs it. Keys
 * stay on the server.
 */

export const RESEARCH_SERVER = "research";
export const WEB_SEARCH_TOOL = "web_search";
/** the name Claude Code knows the tool by, for `allowedTools` */
export const WEB_SEARCH_TOOL_ID = `mcp__${RESEARCH_SERVER}__${WEB_SEARCH_TOOL}`;
export const WEB_READ_TOOL = "web_read";
export const WEB_READ_TOOL_ID = `mcp__${RESEARCH_SERVER}__${WEB_READ_TOOL}`;
/** the row label of every Telem search and read */
export const TELEM_ROW = "Telem";
export const MAX_RESULTS = MAX_MERGED_RESULTS;
/** pages one read may ask for */
export const MAX_READ_URLS = MAX_FETCH_URLS;
/** how much of each read page goes back to Claude */
export const PAGE_CHARS = 6000;
/** how much of each result's excerpt goes back to Claude */
const EXCERPT_CHARS = 1200;
const MAX_PINNED_PROVIDERS = 6;

export type Source = { title: string; url: string };

/** what a row reports. `name` is "Telem" now; chats saved earlier have "Tavily" rows */
export type ToolActivity =
  | { id: string; name: typeof TELEM_ROW; action?: "read"; query: string; status: "running" }
  /** `providers`: who answered, for the row's hover title only */
  | { id: string; status: "done"; sources: Source[]; providers?: string[] }
  | { id: string; status: "error"; message: string };

/** a page's host without `www.`, for the read row's label */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];

/** a page's text as a search (excerpt) or a read (full) returned it */
export type PageSeen = { url: string; title: string; text: string; full: boolean };

export function createWebServer(
  onActivity: (activity: ToolActivity) => void,
  {
    onPages,
    lineage = createLineage(),
    emphasis,
    signal,
    tools: extraTools = [],
  }: {
    /** every page a search or read returned, for the request's research log */
    onPages?: (pages: PageSeen[]) => void;
    /** the Telem trajectory every call belongs to: the chat turn's, or a subagent's */
    lineage?: TelemLineage;
    /** the provider family a search defaults to (subagents draw from different ones) */
    emphasis?: TelemEmphasis;
    /** the request's: Stop aborts calls in flight */
    signal?: AbortSignal;
    /** further tools on the same `research` server (cross_reference, vault, subagents) */
    // `any`: the SDK types its own tools list this way
    tools?: SdkMcpToolDefinition<any>[];
  } = {},
) {
  return createSdkMcpServer({
    name: RESEARCH_SERVER,
    version: "2.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        WEB_SEARCH_TOOL,
        "Search the web with Telem: one call searches several providers and returns merged results, each with a " +
          "title, URL, excerpt and which providers found it. Optional: `platform` searches one platform's own index " +
          "(x, youtube, tiktok, instagram, linkedin, substack, quora, maps, reviews, products, pubmed, sec, " +
          "patents, clinical_trials, …) — use it only when the question is about that platform's " +
          "content; `providers` pins specific Telem providers; `published_after` keeps recent results.",
        {
          query: z.string().min(1).describe("What to search the web for"),
          goal: z.string().max(300).optional().describe("Why you are searching, one short sentence (kept in the research trail)"),
          platform: z
            .enum(PLATFORM_NAMES as [TelemPlatform, ...TelemPlatform[]])
            .optional()
            .describe("Search one platform's own index instead of the general web"),
          providers: z
            .array(z.string().min(1).max(60))
            .max(MAX_PINNED_PROVIDERS)
            .optional()
            .describe("Pin Telem providers by id (e.g. exa, brave, perplexity, parallel, you, linkup); usually omit"),
          published_after: z.string().max(30).optional().describe("Only results published on or after this date, YYYY-MM-DD"),
        },
        async ({ query, goal, platform, providers, published_after }) => {
          const id = crypto.randomUUID();
          onActivity({ id, name: TELEM_ROW, query, status: "running" });
          try {
            const { results, meta } = await telemSearch(query, {
              lineage,
              emphasis: platform || providers?.length ? undefined : emphasis,
              ...(platform ? { platform } : {}),
              ...(providers?.length ? { providers } : {}),
              ...(published_after ? { publishedAfter: published_after } : {}),
              ...(goal ? { goal } : {}),
              signal,
            });
            onPages?.(results.map((r) => ({ url: r.url, title: r.title, text: r.excerpt, full: false })));
            onActivity({
              id,
              status: "done",
              sources: results.map(({ title, url }) => ({ title, url })),
              providers: unique(meta.providers.filter((p) => p.results > 0).map((p) => p.provider)),
            });
            if (results.length === 0) return text(`No results for "${query}".`);
            return text(
              results
                .map(
                  (r, i) =>
                    `[${i + 1}] ${r.title}\nURL: ${r.url}\nFound by: ${r.providers.join(", ")}` +
                    (r.publishedAt ? `\nPublished: ${r.publishedAt.slice(0, 10)}` : "") +
                    `\n${r.excerpt.slice(0, EXCERPT_CHARS)}`,
                )
                .join("\n\n"),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : `Web search failed: ${String(error)}`;
            onActivity({ id, status: "error", message });
            return text(message, true);
          }
        },
      ),
      tool(
        WEB_READ_TOOL,
        "Read web pages in full with Telem fetch (it fails over across fetch providers until one gets the page). " +
          "Pass 1-5 URLs (usually from web_search results); returns each page's clean text so facts can be checked " +
          "against the source itself. Works for X posts, YouTube videos, Reddit threads and other platform links too.",
        {
          urls: z
            .array(z.string().url())
            .min(1)
            .max(MAX_READ_URLS)
            .describe("The pages to read, 1 to 5 URLs"),
          goal: z.string().max(300).optional().describe("What you are checking on these pages, one short sentence"),
        },
        async ({ urls, goal }) => {
          const id = crypto.randomUUID();
          const hosts = unique(urls.map(hostOf)).join(", ");
          onActivity({ id, name: TELEM_ROW, action: "read", query: hosts, status: "running" });
          try {
            const { pages, failed } = await telemFetch(urls, { lineage, ...(goal ? { goal } : {}), signal });
            onPages?.(pages.map((p) => ({ url: p.url, title: p.title, text: p.text, full: true })));
            onActivity({
              id,
              status: "done",
              sources: pages.map(({ title, url }) => ({ title, url })),
              providers: unique(pages.map((p) => p.provider)),
            });
            const read = pages.map((page, i) => {
              const truncated = page.text.length > PAGE_CHARS;
              return (
                `[${i + 1}] ${page.title}\nURL: ${page.url}\n${page.text.slice(0, PAGE_CHARS)}` +
                (truncated ? `\n[truncated: showing the first ${PAGE_CHARS} of ${page.text.length} characters]` : "")
              );
            });
            const errors = failed.map((page) => `Could not read ${page.url}: ${page.error}`);
            if (read.length === 0) {
              return text(errors.length ? errors.join("\n") : "No pages could be read.", true);
            }
            return text([...read, ...errors].join("\n\n"));
          } catch (error) {
            const message = error instanceof Error ? error.message : `Reading pages failed: ${String(error)}`;
            onActivity({ id, status: "error", message });
            return text(message, true);
          }
        },
      ),
      ...extraTools,
    ],
  });
}
