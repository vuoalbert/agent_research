// Ported from nyc-world by menonsprithvi-web (server.mjs @ a4e4a44, the chat's
// in-process Telem MCP server).

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { TelemLineage } from "@/server/telem/client";
import { planSearch, readWithTelem, type PlanIntent } from "@/server/worlds/telem";

/**
 * The World Labs chat's research tools: `telem_search` (one step of the
 * screens' search plan, chosen by focus: routed, trust-filtered) and
 * `telem_fetch` (read a page through Telem Fetch). Every call is reported to
 * the viewer as a `trace` event (its chat log and Search trace panel).
 */

export const WORLD_TELEM_SERVER = "telem";
export const TELEM_SEARCH_TOOL = "telem_search";
export const TELEM_FETCH_TOOL = "telem_fetch";
export const WORLD_TELEM_TOOL_IDS = [TELEM_SEARCH_TOOL, TELEM_FETCH_TOOL].map((name) => `mcp__${WORLD_TELEM_SERVER}__${name}`);

export type Focus = "general" | "official" | "research" | "news";
const STEP_OF: Record<Focus, PlanIntent> = { general: "overview", official: "official", research: "research", news: "news" };

export type SearchTrace = {
  tool: "search";
  query: string;
  focus: Focus;
  intent: PlanIntent;
  note: string;
  providers: string[];
  ms: number;
  found: number;
  kept: number;
  dropped: number;
  error?: string;
};
export type FetchTrace = { tool: "fetch"; url: string; provider?: string | null; ms: number; chars?: number; trust?: string; error?: string };
export type WorldTrace = SearchTrace | FetchTrace;

/** what telem_fetch hands the model, at most */
const FETCH_CHARS = 12_000;

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

export function createWorldTelemTools({
  lineage,
  onTrace,
  signal,
  search = planSearch,
  read = readWithTelem,
}: {
  lineage?: TelemLineage;
  onTrace: (trace: WorldTrace) => void;
  signal?: AbortSignal;
  search?: typeof planSearch;
  read?: typeof readWithTelem;
}) {
  const telemSearch = tool(
    TELEM_SEARCH_TOOL,
    "Search the live web through Telem, which routes the query across many search engines. Results are filtered to trustworthy sources and labelled with a trust type and score. focus: 'general' (all engines), 'official' (government / intergovernmental sites), 'research' (journals, universities), 'news' (reputable outlets, last 12 months).",
    {
      query: z.string().describe("what to search for"),
      focus: z.enum(["general", "official", "research", "news"]).optional().describe("which kind of source to target"),
    },
    async ({ query, focus }) => {
      const f: Focus = focus ?? "general";
      const r = await search(query, [STEP_OF[f]], { lineage, signal });
      onTrace({ tool: "search", query, focus: f, ...r.trace[0], kept: r.results.length, dropped: r.dropped.length });
      const lines = r.results
        .slice(0, 8)
        .map(
          (x, i) =>
            `${i + 1}. ${x.title}\n   ${x.url}\n   trust: ${x.trust.label} (${Math.round(x.trust.score * 100)}) · via ${x.provider}\n   ${x.summary.slice(0, 300)}`,
        );
      return text(lines.length ? lines.join("\n\n") : r.trace[0]?.error ? `Search failed: ${r.trace[0].error}` : "No trustworthy results.");
    },
  );

  const telemFetch = tool(
    TELEM_FETCH_TOOL,
    "Read a web page's main content (markdown) through Telem Fetch. Use it to check what a source actually says before relying on it.",
    { url: z.string().describe("the page URL") },
    async ({ url }) => {
      const t0 = Date.now();
      const d = await read(url, { lineage, maxChars: FETCH_CHARS, signal });
      if (!d.ok) {
        onTrace({ tool: "fetch", url: URL.canParse(url) ? url : "about:invalid", ms: Date.now() - t0, error: d.error });
        return text(`Could not read ${url}: ${d.error}`, true);
      }
      onTrace({ tool: "fetch", url: d.url, provider: d.provider, ms: Date.now() - t0, chars: d.content.length, trust: d.trust.label });
      return text(`# ${d.title}\nSource: ${d.url} (trust: ${d.trust.label})\n\n${d.content}`);
    },
  );

  return { telemSearch, telemFetch };
}

export function createWorldTelemServer(options: Parameters<typeof createWorldTelemTools>[0]) {
  const { telemSearch, telemFetch } = createWorldTelemTools(options);
  return createSdkMcpServer({ name: WORLD_TELEM_SERVER, version: "1.0.0", tools: [telemSearch, telemFetch] });
}
