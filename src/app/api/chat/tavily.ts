import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { tavily } from "@tavily/core";
import { z } from "zod";

/**
 * Tavily web search, as the one tool Claude gets in /api/chat.
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
export const MAX_RESULTS = 5;
/** how much of each page's excerpt goes back to Claude */
const EXCERPT_CHARS = 1200;

export type Source = { title: string; url: string };

export type ToolActivity =
  | { id: string; name: "Tavily"; query: string; status: "running" }
  | { id: string; status: "done"; sources: Source[] }
  | { id: string; status: "error"; message: string };

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

export function createTavilyServer(onActivity: (activity: ToolActivity) => void) {
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
    ],
  });
}
