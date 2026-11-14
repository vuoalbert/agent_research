import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { tavily } from "@tavily/core";
import { z } from "zod";

/**
 * Tavily web search and page reading, the two tools Claude gets in /api/chat:
 * `tavily_search` finds candidate sources, `tavily_extract` reads a few of them
 * in full so their facts can be cross-referenced rather than taken from a
 * search snippet.
 *
 * An in-process SDK MCP server built per request, so the handler closes over
 * that request's stream: it reports each search to the client (`onActivity`)
 * at the exact moment it starts and ends, rather than the route guessing from
 * the model's tool_use blocks. The key is read from `process.env` on the
 * server only and never leaves it.
 */

export const TAVILY_SERVER = "research";
export const TAVILY_TOOL = "tavily_search";
/** the name Claude Code knows the tool by, for `allowedTools` */
export const TAVILY_TOOL_ID = `mcp__${TAVILY_SERVER}__${TAVILY_TOOL}`;
export const EXTRACT_TOOL = "tavily_extract";
export const EXTRACT_TOOL_ID = `mcp__${TAVILY_SERVER}__${EXTRACT_TOOL}`;
export const MAX_RESULTS = 5;
/** pages one read may ask for */
export const MAX_EXTRACT_URLS = 5;
/** how much of each read page goes back to Claude */
export const PAGE_CHARS = 6000;
/** how much of each page's excerpt goes back to Claude */
const EXCERPT_CHARS = 1200;

export type Source = { title: string; url: string };

export type ToolActivity =
  | { id: string; name: "Tavily"; action?: "read"; query: string; status: "running" }
  | { id: string; status: "done"; sources: Source[] }
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

/** a page's text as a search (excerpt) or a read (full) returned it */
export type PageSeen = { url: string; title: string; text: string; full: boolean };

export function createTavilyServer(
  onActivity: (activity: ToolActivity) => void,
  {
    onPages,
    tools: extraTools = [],
  }: {
    /** every page a search or read returned, for the request's research log */
    onPages?: (pages: PageSeen[]) => void;
    /** further tools on the same `research` server (cross_reference) */
    // `any`: the SDK types its own tools list this way
    tools?: SdkMcpToolDefinition<any>[];
  } = {},
) {
  return createSdkMcpServer({
    name: TAVILY_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        TAVILY_TOOL,
        "Search the web with Tavily. Returns the top results, each with a title, URL and an excerpt of the page.",
        { query: z.string().min(1).describe("What to search the web for") },
        async ({ query }) => {
          const id = crypto.randomUUID();
          onActivity({ id, name: "Tavily", query, status: "running" });

          const apiKey = process.env.TAVILY_API_KEY;
          if (!apiKey) {
            const message = "Web search is unavailable: TAVILY_API_KEY is not set on the server.";
            onActivity({ id, status: "error", message });
            return text(message, true);
          }

          try {
            const response = await tavily({ apiKey }).search(query, {
              searchDepth: "basic",
              maxResults: MAX_RESULTS,
            });
            const results = response.results.slice(0, MAX_RESULTS);
            onPages?.(
              results.map((r) => ({ url: r.url, title: r.title || r.url, text: r.content ?? "", full: false })),
            );
            onActivity({
              id,
              status: "done",
              sources: results.map(({ title, url }) => ({ title: title || url, url })),
            });
            if (results.length === 0) return text(`No results for "${query}".`);
            return text(
              results
                .map(
                  (r, i) =>
                    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content ?? "").slice(0, EXCERPT_CHARS)}`,
                )
                .join("\n\n"),
            );
          } catch (error) {
            const message = `Web search failed: ${error instanceof Error ? error.message : String(error)}`;
            onActivity({ id, status: "error", message });
            return text(message, true);
          }
        },
      ),
      tool(
        EXTRACT_TOOL,
        "Read web pages in full with Tavily Extract. Pass 1-5 URLs (usually from tavily_search results); " +
          "returns each page's cleaned text so facts can be checked against the source itself.",
        {
          urls: z
            .array(z.string().url())
            .min(1)
            .max(MAX_EXTRACT_URLS)
            .describe("The pages to read, 1 to 5 URLs"),
        },
        async ({ urls }) => {
          const id = crypto.randomUUID();
          const hosts = [...new Set(urls.map(hostOf))].join(", ");
          onActivity({ id, name: "Tavily", action: "read", query: hosts, status: "running" });

          const apiKey = process.env.TAVILY_API_KEY;
          if (!apiKey) {
            const message = "Reading pages is unavailable: TAVILY_API_KEY is not set on the server.";
            onActivity({ id, status: "error", message });
            return text(message, true);
          }

          try {
            const response = await tavily({ apiKey }).extract(urls, {
              extractDepth: "basic",
              format: "text",
            });
            const pages = response.results ?? [];
            const failed = response.failedResults ?? [];
            onPages?.(
              pages.map((p) => ({ url: p.url, title: p.title || p.url, text: p.rawContent ?? "", full: true })),
            );
            onActivity({
              id,
              status: "done",
              sources: pages.map(({ title, url }) => ({ title: title || url, url })),
            });
            const read = pages.map((page, i) => {
              const content = page.rawContent ?? "";
              const truncated = content.length > PAGE_CHARS;
              return (
                `[${i + 1}] ${page.title || page.url}\nURL: ${page.url}\n${content.slice(0, PAGE_CHARS)}` +
                (truncated ? `\n[truncated: showing the first ${PAGE_CHARS} of ${content.length} characters]` : "")
              );
            });
            const errors = failed.map((page) => `Could not read ${page.url}: ${page.error}`);
            if (read.length === 0) {
              return text(errors.length ? errors.join("\n") : "No pages could be read.", true);
            }
            return text([...read, ...errors].join("\n\n"));
          } catch (error) {
            const message = `Reading pages failed: ${error instanceof Error ? error.message : String(error)}`;
            onActivity({ id, status: "error", message });
            return text(message, true);
          }
        },
      ),
      ...extraTools,
    ],
  });
}
