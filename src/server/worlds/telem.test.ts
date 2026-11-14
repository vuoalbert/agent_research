import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setTelemForTests, createLineage, type TelemSearchOptions, type TelemSearchOutcome } from "@/server/telem/client";

import { NEWS, OFFICIAL, RESEARCH, mergePlan, normUrl, planSearch, readWithTelem, trustOf, type StepRun } from "./telem";

/** The World Labs screens' Telem sources: trust scoring, the 4-step search plan's merge, and Telem Fetch's guard */

beforeEach(() => {
  process.env.TELEM_API_KEY = "test-telem-key";
});
afterEach(() => {
  delete process.env.TELEM_API_KEY;
  __setTelemForTests(null);
});

describe("trust scoring", () => {
  it("scores sources by kind and drops social and unknown sites", () => {
    expect(trustOf("https://www.nyc.gov/site/tlc")).toMatchObject({ score: 0.95, label: "Government" });
    expect(trustOf("https://web.mit.edu/x")).toMatchObject({ label: "University" });
    expect(trustOf("https://www.reuters.com/a")).toMatchObject({ score: 0.82, label: "Reputable news" });
    expect(trustOf("https://en.wikipedia.org/wiki/X")).toMatchObject({ label: "Encyclopedia (cited)" });
    expect(trustOf("https://www.reddit.com/r/nyc").score).toBeLessThan(0.7);
    expect(trustOf("https://some-blog.example/post").label).toBe("Unverified");
  });

  it("counts city / provincial governments and museums", () => {
    expect(trustOf("https://www.toronto.ca/services")).toMatchObject({ score: 0.9, label: "Government" });
    expect(trustOf("https://new.mta.info/fares")).toMatchObject({ score: 0.9, label: "Government" });
    expect(trustOf("https://www.tfl.gov.uk/x")).toMatchObject({ label: "Government" });
    expect(trustOf("https://www.guggenheim.museum/a")).toMatchObject({ score: 0.86, label: "Museum / library" });
    expect(trustOf("https://brooklynmuseum.org/a")).toMatchObject({ label: "Museum / library" });
  });

  it("normalises URLs: protocol, www, trailing slash, hash and case", () => {
    expect(normUrl("https://www.NYC.gov/a/#top")).toBe(normUrl("http://nyc.gov/a"));
    expect(normUrl("https://nyc.gov/a?b=1")).not.toBe(normUrl("https://nyc.gov/a"));
  });
});

const hit = (intent: StepRun["intent"], url: string, rank = 1, provider = "exa") => ({
  url,
  title: url,
  summary: "",
  rank,
  provider,
  intent,
  trust: trustOf(url),
});
const run = (intent: StepRun["intent"], urls: string[], providers = ["exa"]): StepRun => ({
  intent,
  note: intent,
  providers,
  ms: 100,
  results: urls.map((u, i) => hit(intent, u, i + 1, providers[0])),
});

describe("mergePlan — merge, trust filter, round-robin", () => {
  it("merges the same page across steps, keeping every step that found it", () => {
    const out = mergePlan("q", [run("overview", ["https://www.nyc.gov/a/"]), run("official", ["http://nyc.gov/a#x"])], 10);
    expect(out.total).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ intent: "overview", intents: ["overview", "official"] });
  });

  it("drops untrusted results and reports them", () => {
    const out = mergePlan("q", [run("overview", ["https://www.reddit.com/r/x", "https://blog.example/p", "https://www.nasa.gov/a"])], 10);
    expect(out.results.map((r) => r.url)).toEqual(["https://www.nasa.gov/a"]);
    expect(out.dropped).toEqual([
      { host: "reddit.com", label: "User-generated / social" },
      { host: "blog.example", label: "Unverified" },
    ]);
  });

  it("picks round-robin across steps so one step cannot fill every screen", () => {
    const out = mergePlan(
      "q",
      [
        run("overview", ["https://a.gov/1", "https://b.gov/1", "https://c.gov/1"]),
        run("official", ["https://d.gov/1", "https://e.gov/1"]),
        run("news", ["https://www.reuters.com/1"]),
      ],
      10,
    );
    expect(out.results.map((r) => r.intent)).toEqual(["overview", "official", "news", "overview", "official", "overview"]);
    expect(out.trace.map((t) => [t.intent, t.found, t.kept])).toEqual([
      ["overview", 3, 3],
      ["official", 2, 2],
      ["news", 1, 1],
    ]);
  });

  it("keeps at most two pages per site, best trust first within a step", () => {
    const out = mergePlan(
      "q",
      [run("overview", ["https://en.wikipedia.org/1", "https://www.nyc.gov/1", "https://www.nyc.gov/2", "https://www.nyc.gov/3"])],
      10,
    );
    expect(out.results.map((r) => r.url)).toEqual(["https://www.nyc.gov/1", "https://www.nyc.gov/2", "https://en.wikipedia.org/1"]);
    expect(out.trace[0]).toMatchObject({ found: 4, kept: 3 });
  });

  it("lists every engine that returned rows, once", () => {
    const out = mergePlan("q", [run("overview", ["https://a.gov/1"], ["exa", "brave"]), run("news", [], ["brave", "you"])], 10);
    expect(out.providers).toEqual(["exa", "brave", "you"]);
  });
});

/** a fake shared-client search: rows per step, keyed by the step's goal */
function fakeSearch(rows: Record<string, { url: string; provider?: string }[] | Error>) {
  return vi.fn(async (query: string, options: TelemSearchOptions = {}): Promise<TelemSearchOutcome> => {
    const r = rows[options.goal ?? ""];
    if (r instanceof Error) throw r;
    const list = r ?? [];
    return {
      results: list.map((x) => ({ title: x.url, url: x.url, excerpt: "sum", provider: x.provider ?? "exa", providers: [x.provider ?? "exa"], score: 1 })),
      meta: {
        id: "m",
        kind: "search",
        caller: options.caller ?? "chat",
        query,
        status: "succeeded",
        providers: [
          { provider: "exa", status: "succeeded", latencyMs: 1, results: list.length },
          { provider: "brave", status: "succeeded", latencyMs: 1, results: 0 },
        ],
        resultCount: list.length,
        latencyMs: 1,
        startedAt: 0,
        finishedAt: 1,
      },
    };
  });
}

describe("planSearch — the 4-step plan on the shared client", () => {
  it("runs overview / official / research / news with their own settings, in the chat's lineage", async () => {
    const search = fakeSearch({
      overview: [{ url: "https://en.wikipedia.org/wiki/Congestion_pricing" }],
      "official sources": [{ url: "https://www.nyc.gov/a" }],
      "research sources": [{ url: "https://www.nature.com/b" }],
      "recent news": [{ url: "https://apnews.com/c" }],
    });
    const lineage = createLineage({ chatId: "chat-1", question: "congestion pricing" });
    const now = Date.parse("2026-11-14T00:00:00Z");
    const out = await planSearch("congestion pricing", undefined, { lineage, search, now: () => now });

    expect(search).toHaveBeenCalledTimes(4);
    const opts = Object.fromEntries(search.mock.calls.map(([, o]) => [o!.goal, o!]));
    expect(opts.overview).toMatchObject({ numResults: 8, lineage, caller: "world" });
    expect(opts.overview.includeDomains).toBeUndefined();
    expect(opts["official sources"].includeDomains).toEqual(OFFICIAL);
    expect(opts["research sources"].includeDomains).toEqual(RESEARCH);
    expect(opts["recent news"]).toMatchObject({ includeDomains: NEWS, publishedAfter: "2025-11-14" });

    expect(out.trace.map((t) => t.intent)).toEqual(["overview", "official", "research", "news"]);
    expect(out.trace[0]).toMatchObject({ providers: ["exa"], found: 1, kept: 1 });
    expect(out.results.map((r) => r.intent)).toEqual(["overview", "official", "research", "news"]);
    expect(out.results[1]).toMatchObject({ summary: "sum", provider: "exa", trust: { label: "Government" } });
  });

  it("reports a failed step in the trace and keeps the rest", async () => {
    const search = fakeSearch({ overview: [{ url: "https://www.nasa.gov/a" }], "official sources": new Error("boom") });
    const out = await planSearch("q", ["overview", "official"], { search });
    expect(out.trace[1]).toMatchObject({ intent: "official", error: "boom", found: 0, kept: 0 });
    expect(out.results).toHaveLength(1);
  });

  it("goes through the shared Telem SDK client (no direct router calls)", async () => {
    const sdkSearch = vi.fn(async () => ({
      results: [],
      byProvider: [{ provider: "exa", status: "succeeded", latencyMs: 5, results: [{ url: "https://www.nyc.gov/x", title: "X", summary: "s", excerpt: null, rank: 1, provider: "exa" }] }],
      sessionId: "s",
      interactionId: "i",
      status: "succeeded",
      raw: {},
    }));
    __setTelemForTests({ search: sdkSearch, fetch: vi.fn() } as never);
    const out = await planSearch("q", ["official"]);
    expect(sdkSearch).toHaveBeenCalledWith("q", expect.objectContaining({ includeDomains: OFFICIAL, autoRouting: "accuracy" }));
    expect(out.results[0]).toMatchObject({ url: "https://www.nyc.gov/x", intent: "official" });
  });
});

describe("readWithTelem — SSRF guard", () => {
  it("refuses private and non-http targets before calling Telem", async () => {
    const read = vi.fn();
    for (const url of ["http://127.0.0.1/", "http://localhost:3500/", "http://192.168.0.1/", "http://[::1]/"]) {
      expect(await readWithTelem(url, { read })).toMatchObject({ ok: false, status: 403 });
    }
    expect(await readWithTelem("file:///etc/passwd", { read })).toMatchObject({ ok: false, status: 400 });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads a public page through Telem Fetch, with its trust badge, capped to maxChars", async () => {
    const read = vi.fn(async () => ({
      pages: [{ url: "https://www.nyc.gov/a", title: "A", text: "# A\nText", provider: "x" }],
      failed: [],
      meta: {} as never,
    }));
    const out = await readWithTelem("https://www.nyc.gov/a", { read, guard: async () => {}, maxChars: 4 });
    expect(read).toHaveBeenCalledWith(["https://www.nyc.gov/a"], expect.objectContaining({ caller: "world" }));
    expect(out).toMatchObject({ ok: true, url: "https://www.nyc.gov/a", title: "A", content: "# A\n", trust: { label: "Government" } });
  });
});
