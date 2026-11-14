import { describe, expect, it, vi } from "vitest";

import { createLineage } from "@/server/telem/client";
import type { PlanResult } from "@/server/worlds/telem";

import { WORLD_TELEM_TOOL_IDS, createWorldTelemTools, type WorldTrace } from "./tools";

/** The World Labs chat's Telem tools: what Claude gets back and the trace events the viewer sees */

const plan = (over: Partial<PlanResult> = {}): PlanResult => ({
  query: "q",
  trace: [{ intent: "official", note: "limited to 20 sites", providers: ["exa", "brave"], ms: 1200, found: 5, kept: 2 }],
  ms: 1200,
  providers: ["exa", "brave"],
  total: 5,
  dropped: [{ host: "reddit.com", label: "User-generated / social" }],
  results: [
    {
      url: "https://www.nyc.gov/a",
      title: "NYC A",
      summary: "About A",
      rank: 1,
      provider: "exa",
      intent: "official",
      intents: ["official"],
      trust: { score: 0.95, label: "Government", host: "nyc.gov" },
    },
  ],
  ...over,
});

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const call = (t: { handler: unknown }, args: Record<string, unknown>) => (t.handler as Handler)(args, {});

describe("world Telem tools", () => {
  it("are the two telem tools on the telem server", () => {
    expect(WORLD_TELEM_TOOL_IDS).toEqual(["mcp__telem__telem_search", "mcp__telem__telem_fetch"]);
  });

  it("telem_search runs the focus's plan step in the chat's lineage and traces it", async () => {
    const traces: WorldTrace[] = [];
    const search = vi.fn(async () => plan());
    const lineage = createLineage({ chatId: "chat-1" });
    const { telemSearch } = createWorldTelemTools({ lineage, onTrace: (t) => traces.push(t), search });

    const out = await call(telemSearch, { query: "congestion pricing", focus: "official" });
    expect(search).toHaveBeenCalledWith("congestion pricing", ["official"], expect.objectContaining({ lineage }));
    expect(out.content[0].text).toContain("1. NYC A\n   https://www.nyc.gov/a\n   trust: Government (95) · via exa");
    expect(traces).toEqual([
      expect.objectContaining({ tool: "search", query: "congestion pricing", focus: "official", intent: "official", providers: ["exa", "brave"], found: 5, kept: 1, dropped: 1 }),
    ]);
  });

  it("telem_search defaults to the general (overview) step and says when nothing is trustworthy", async () => {
    const search = vi.fn(async () => plan({ results: [], trace: [{ intent: "overview", note: "", providers: [], ms: 1, found: 0, kept: 0 }] }));
    const { telemSearch } = createWorldTelemTools({ onTrace: () => {}, search });
    const out = await call(telemSearch, { query: "q" });
    expect(search).toHaveBeenCalledWith("q", ["overview"], expect.anything());
    expect(out.content[0].text).toBe("No trustworthy results.");
  });

  it("telem_fetch reads through Telem Fetch and traces the read", async () => {
    const traces: WorldTrace[] = [];
    const read = vi.fn(async () => ({
      ok: true as const,
      url: "https://www.nyc.gov/a",
      title: "A",
      content: "Body",
      provider: "jina",
      trust: { score: 0.95, label: "Government", host: "nyc.gov" },
    }));
    const { telemFetch } = createWorldTelemTools({ onTrace: (t) => traces.push(t), read });
    const out = await call(telemFetch, { url: "https://www.nyc.gov/a" });
    expect(read).toHaveBeenCalledWith("https://www.nyc.gov/a", expect.objectContaining({ maxChars: 12_000 }));
    expect(out.content[0].text).toBe("# A\nSource: https://www.nyc.gov/a (trust: Government)\n\nBody");
    expect(traces[0]).toMatchObject({ tool: "fetch", url: "https://www.nyc.gov/a", provider: "jina", chars: 4, trust: "Government" });
  });

  it("telem_fetch reports a failed read as a tool error and a trace the viewer can render", async () => {
    const traces: WorldTrace[] = [];
    const read = vi.fn(async () => ({ ok: false as const, status: 403, error: "address not allowed" }));
    const { telemFetch } = createWorldTelemTools({ onTrace: (t) => traces.push(t), read });
    const out = await call(telemFetch, { url: "not a url" });
    expect(out.isError).toBe(true);
    expect(traces[0]).toMatchObject({ tool: "fetch", url: "about:invalid", error: "address not allowed" });
  });
});
