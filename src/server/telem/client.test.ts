// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDS, fetchResponse, installTelemFake, searchResponse } from "@/test/telem-fake";

const tavilySearch = vi.fn();
const tavilyExtract = vi.fn();
vi.mock("@tavily/core", () => ({ tavily: () => ({ search: tavilySearch, extract: tavilyExtract }) }));

const { childLineage, createLineage, mergeResults, telemFetch, telemSearch, __setTelemForTests } = await import("./client");
const { onTelemCall, __clearTelemListeners } = await import("./events");

/** the lineage envelope `withTrajectory` attached to a call's options */
const envelopeOf = (options: unknown) => {
  const record = options as Record<symbol, unknown>;
  return record[Object.getOwnPropertySymbols(record)[0]] as {
    session_key: string;
    node_key: string;
    parent_node_key: string | null;
    message_history: { role: string; content: string }[];
  };
};

let telem: ReturnType<typeof installTelemFake>;
let metas: Parameters<Parameters<typeof onTelemCall>[0]>[0][];

beforeEach(() => {
  telem = installTelemFake();
  vi.stubEnv("TAVILY_API_KEY", "");
  tavilySearch.mockReset();
  tavilyExtract.mockReset();
  metas = [];
  onTelemCall((meta) => metas.push(meta));
});
afterEach(() => {
  __clearTelemListeners();
  __setTelemForTests(null);
});

describe("mergeResults", () => {
  it("de-duplicates pages across providers and ranks agreement first", () => {
    const merged = mergeResults(
      searchResponse({
        exa: [{ url: "https://a.com/1", title: "A1", summary: "short" }, { url: "https://b.com", title: "B" }],
        brave: [{ url: "https://www.a.com/1/", title: "A1", summary: "a longer summary" }, { url: "https://c.com", title: "C" }],
      }),
    );
    expect(merged.map((r) => r.url)).toEqual(["https://a.com/1", "https://b.com", "https://c.com"]);
    expect(merged[0]).toMatchObject({ providers: ["exa", "brave"], score: 2, excerpt: "a longer summary" });
  });
});

describe("telemSearch", () => {
  it("auto-routes by default and reports the call on onTelemCall", async () => {
    telem.search.mockResolvedValue(searchResponse([{ url: "https://a.com", title: "A", summary: "x" }]));
    const { results, meta } = await telemSearch("q");
    expect(telem.search).toHaveBeenCalledWith("q", expect.objectContaining({ autoRouting: "accuracy", tier: "default", numResults: 5 }));
    expect(results).toEqual([{ title: "A", url: "https://a.com", excerpt: "x", provider: "exa", providers: ["exa"], score: 1 }]);
    expect(metas).toEqual([meta]);
    expect(meta).toMatchObject({
      kind: "search",
      caller: "chat",
      query: "q",
      sessionId: IDS.session_id,
      interactionId: IDS.interaction_id,
      trajectoryId: IDS.trajectory_id,
      status: "succeeded",
      providers: [{ provider: "exa", status: "succeeded", results: 1 }],
      resultCount: 1,
      routing: [{ topic: "news", providers: ["exa"] }],
    });
    expect(meta.latencyMs).toEqual(expect.any(Number));
  });

  it("pins a platform's providers with routing off, and a provider list as given", async () => {
    telem.search.mockResolvedValue(searchResponse([]));
    await telemSearch("q", { platform: "x" });
    expect(telem.search.mock.calls[0][1]).toMatchObject({ providersInclude: ["fetchlayer_x"], autoRouting: "off" });
    await telemSearch("q", { providers: ["exa"] });
    expect(telem.search.mock.calls[1][1]).toMatchObject({ providersInclude: ["exa"], autoRouting: "off" });
    await telemSearch("q", { emphasis: "deep" });
    expect(telem.search.mock.calls[2][1]).toMatchObject({ providersInclude: ["exa", "parallel", "seltz"], autoRouting: "accuracy" });
  });

  it("carries the chat's lineage: one session per chat, subagents under the delegating turn", async () => {
    telem.search.mockResolvedValue(searchResponse([]));
    const lead = createLineage({ chatId: "chat-1", turnId: "turn-1", question: "What did World Labs ship?" });
    await telemSearch("first", { lineage: lead, goal: "find releases" });
    await telemSearch("second", { lineage: lead });
    const next = createLineage({ chatId: "chat-1", turnId: "turn-2" });
    await telemSearch("third", { lineage: next });
    const kid = await childLineage(lead, { agentId: "a1", title: "Pricing", task: "find prices" });
    await telemSearch("sub", { lineage: kid });

    const [first, second, third, sub] = telem.search.mock.calls.map((call) => envelopeOf(call[1]));
    expect(first.session_key).toBe(second.session_key);
    expect(third.session_key).toBe(first.session_key);
    expect(new Set([first.node_key, second.node_key, third.node_key]).size).toBe(3);
    expect(first.parent_node_key).toBeNull();
    expect(sub.parent_node_key).toEqual(expect.any(String));
    expect(sub.session_key).not.toBe(first.session_key);
    // the history ends with this call, running; the finished one before it is completed
    expect(first.message_history[0]).toEqual({ role: "user", content: "What did World Labs ship?" });
    expect(first.message_history.at(-1)!.content).toMatch(/^\[tool telem_search:running\]|telem_search/);
    expect(second.message_history.some((m) => /telem_search/.test(m.content) && /completed/.test(m.content))).toBe(true);
    expect(metas.at(-1)).toMatchObject({ caller: "subagent", chatId: "chat-1", turnId: "turn-1", agentId: "a1", agentTitle: "Pricing" });
  });

  it("falls back to Tavily when Telem errors, flagged on the meta", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    telem.search.mockRejectedValue(new Error("503"));
    tavilySearch.mockResolvedValue({ results: [{ title: "T", url: "https://t.com", content: "t" }] });
    const { results, meta } = await telemSearch("q");
    expect(results).toMatchObject([{ url: "https://t.com", provider: "tavily" }]);
    expect(meta).toMatchObject({ fallback: "tavily", error: "503", status: "succeeded" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats a search where every provider failed as a Telem failure", async () => {
    telem.search.mockResolvedValue(searchResponse({ exa: [] }, { status: "failed" }));
    await expect(telemSearch("q")).rejects.toThrow(/every provider failed/);
    expect(metas[0]).toMatchObject({ status: "error" });
  });

  it("does not fall back without a Tavily key, and says which key is missing", async () => {
    vi.stubEnv("TELEM_API_KEY", "");
    await expect(telemSearch("q")).rejects.toThrow(/TELEM_API_KEY/);
    expect(tavilySearch).not.toHaveBeenCalled();
  });
});

describe("telemFetch", () => {
  it("returns pages and failures and batches more than 5 URLs", async () => {
    telem.fetch.mockImplementation(async (urls: string[]) =>
      fetchResponse(urls.map((url) => (url.endsWith("bad") ? { url } : { url, title: url, content: `text of ${url}`, provider: "exa" }))),
    );
    const urls = ["1", "2", "3", "4", "5", "6", "bad"].map((n) => `https://p.com/${n}`);
    const { pages, failed } = await telemFetch(urls, { caller: "crossref" });
    expect(telem.fetch).toHaveBeenCalledTimes(2);
    expect(telem.fetch.mock.calls[0][0]).toHaveLength(5);
    expect(pages).toHaveLength(6);
    expect(failed).toEqual([{ url: "https://p.com/bad", error: "failed" }]);
    expect(metas.map((m) => [m.kind, m.caller, m.resultCount])).toEqual([
      ["fetch", "crossref", 5],
      ["fetch", "crossref", 1],
    ]);
  });
});
