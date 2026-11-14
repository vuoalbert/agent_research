import { beforeEach, describe, expect, it, vi } from "vitest";

import { installTelemFakeFrom } from "@/test/telem-fake";

/**
 * cross_reference with Telem (fake) and the nested Claude call mocked: which pages
 * it reads (and does not re-read), what the analysis turns into, and what goes
 * back to Claude and to the client.
 */
type Handler = (args: { topic: string }, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
}));
const extract = vi.fn();
vi.mock("@tavily/core", () => ({ tavily: () => ({ extract }) }));

const {
  __clearPageCache,
  analyseWithClaude,
  createCrossReferenceTool,
  createResearchLog,
  formatCrossref,
  toCrossref,
} = await import("./cross-reference");

const page = (url: string, body: string) => ({ url, title: `Title ${url}`, rawContent: body.padEnd(200, ".") });
const MC = "https://www.minecraft.net/en-us/article/sales";
const WIKI = "https://en.wikipedia.org/wiki/Minecraft";
const NEWS = "https://news.example.com/minecraft";

/** the analysis the nested call "returns": MC and WIKI agree on sales, NEWS disagrees */
const analysis = {
  claims: [
    {
      id: "C1",
      text: "Minecraft has sold over 300 million copies.",
      sources: [
        { source: "S1", stance: "supports" as const, quote: "300 million copies" },
        { source: "S2", stance: "supports" as const, quote: "over 300 million" },
        { source: "S3", stance: "contradicts" as const, quote: "238 million copies" },
      ],
    },
    {
      id: "C2",
      text: "Minecraft has about 140 million monthly players.",
      sources: [
        { source: "S2", stance: "supports" as const, quote: "140 million monthly active" },
        { source: "S3", stance: "mentions" as const, quote: "players" },
        { source: "S9", stance: "supports" as const, quote: "unknown label" },
      ],
    },
    // only one page addresses it, and nobody contradicts it: dropped
    { id: "C3", text: "Notch founded Mojang.", sources: [{ source: "S1", stance: "supports" as const, quote: "Notch" }] },
  ],
};

function setup(chatSources = [
  { title: "Minecraft sales", url: MC },
  { title: "Minecraft — Wikipedia", url: WIKI },
]) {
  const log = createResearchLog(chatSources);
  const activity: unknown[] = [];
  const analyse = vi.fn().mockResolvedValue(analysis);
  const tool = createCrossReferenceTool({ log, onActivity: (a) => activity.push(a), analyse }) as unknown as {
    name: string;
    handler: Handler;
  };
  return { log, activity, analyse, tool };
}

describe("cross_reference", () => {
  beforeEach(() => {
    __clearPageCache();
    extract.mockReset();
    query.mockReset();
    vi.stubEnv("TAVILY_API_KEY", "");
    installTelemFakeFrom({ extract });
  });

  it("checks the chat's sources plus this request's finds, and reports claims and relations", async () => {
    const { log, activity, analyse, tool } = setup();
    // found by this request's search: an excerpt only
    log.recordPages([{ url: NEWS, title: "News", text: "Minecraft sold 238 million copies. ".repeat(5), full: false }]);
    extract.mockResolvedValue({
      results: [page(MC, "300 million copies"), page(WIKI, "over 300 million")],
      failedResults: [{ url: NEWS, error: "403" }],
    });

    const result = await tool.handler({ topic: "Minecraft sales" }, {});

    expect(tool.name).toBe("cross_reference");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith([MC, WIKI, NEWS], expect.objectContaining({ tier: "default", metadata: { caller: "crossref" } }));
    // the failed extract fell back to the search excerpt
    const pages = analyse.mock.calls[0][1] as { label: string; url: string; text: string }[];
    expect(pages.map((p) => [p.label, p.url])).toEqual([["S1", MC], ["S2", WIKI], ["S3", NEWS]]);
    expect(pages[2].text).toContain("238 million");
    expect(pages.every((p) => p.text.length <= 4000)).toBe(true);

    expect(activity[0]).toMatchObject({ name: "Cross-reference", action: "crossref", query: "Minecraft sales", status: "running" });
    const done = activity[1] as { status: string; crossref: { claims: { id: string; text: string; sources: unknown[] }[]; relations: unknown[] } };
    expect(done.status).toBe("done");
    expect(done.crossref.claims.map((c) => c.text)).toEqual([
      "Minecraft has sold over 300 million copies.",
      "Minecraft has about 140 million monthly players.",
    ]);
    // the unknown label S9 is dropped
    expect(done.crossref.claims[1].sources).toHaveLength(2);
    expect(done.crossref.relations).toEqual([
      { a: WIKI, b: MC, kind: "agrees", claims: ["C1"] },
      { a: WIKI, b: NEWS, kind: "conflicts", claims: ["C1"] },
      { a: MC, b: NEWS, kind: "conflicts", claims: ["C1"] },
    ]);

    const text = result.content[0].text;
    expect(result.isError).toBeUndefined();
    expect(text).toContain("C1. Minecraft has sold over 300 million copies.");
    expect(text).toContain('✓ minecraft.net ("300 million copies"); en.wikipedia.org ("over 300 million")');
    expect(text).toContain('✗ news.example.com ("238 million copies")');
    expect(text).toContain("Conflicts:");
    expect(text).toContain("en.wikipedia.org vs news.example.com on C1");
  });

  it("reads each page once: a second run is served from the cache", async () => {
    extract.mockResolvedValue({ results: [page(MC, "a"), page(WIKI, "b")], failedResults: [] });
    const first = setup();
    await first.tool.handler({ topic: "t" }, {});
    const second = setup();
    await second.tool.handler({ topic: "t" }, {});
    expect(extract).toHaveBeenCalledTimes(1);
    expect(second.analyse).toHaveBeenCalledTimes(1);
  });

  it("does not re-fetch a page web_read already read in full", async () => {
    const { log, tool } = setup([]);
    log.recordPages([
      { url: MC, title: "MC", text: "x".repeat(500), full: true },
      { url: `${WIKI}/`, title: "Wiki", text: "y".repeat(500), full: true },
    ]);
    await tool.handler({ topic: "t" }, {});
    expect(extract).not.toHaveBeenCalled();
  });

  it("keeps the 20 most recent sources", () => {
    const log = createResearchLog(Array.from({ length: 25 }, (_, i) => ({ title: `${i}`, url: `https://s${i}.com/` })));
    log.recordPages([{ url: "https://s0.com", title: "again", text: "", full: false }]);
    const recent = log.recent();
    expect(recent).toHaveLength(20);
    expect(recent.at(-1)!.url).toBe("https://s0.com"); // re-seen: now the newest
    expect(recent[0].url).toBe("https://s6.com/");
  });

  it("puts pages read in full first when there are more sources than it takes", () => {
    const log = createResearchLog();
    // a subagent read two pages early; then 25 search hits pile up after them
    log.recordPages([
      { url: "https://read-a.com/", title: "A", text: "full text A", full: true },
      { url: "https://read-b.com/", title: "B", text: "full text B", full: true },
    ]);
    log.recordPages(Array.from({ length: 25 }, (_, i) => ({ url: `https://hit${i}.com/`, title: `${i}`, text: "x", full: false })));
    const recent = log.recent();
    expect(recent).toHaveLength(20);
    // both reads kept, in log order (oldest first), then the 18 newest hits
    expect(recent.slice(0, 2).map((s) => s.url)).toEqual(["https://read-a.com/", "https://read-b.com/"]);
    expect(recent[2].url).toBe("https://hit7.com/");
    expect(recent.at(-1)!.url).toBe("https://hit24.com/");
  });

  it("is an error, not a crash, with too few sources or a failing analysis", async () => {
    const lone = setup([{ title: "a", url: MC }]);
    const few = await lone.tool.handler({ topic: "t" }, {});
    expect(few.isError).toBe(true);
    expect(lone.activity.at(-1)).toMatchObject({ status: "error" });

    extract.mockResolvedValue({ results: [page(MC, "a"), page(WIKI, "b")], failedResults: [] });
    const broken = setup();
    broken.analyse.mockRejectedValue(new Error("overloaded"));
    const result = await broken.tool.handler({ topic: "t" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("overloaded");
  });

  it("cuts quotes to 200 characters and claims to 25", () => {
    const pages = [
      { label: "S1", url: MC, title: "a", text: "" },
      { label: "S2", url: WIKI, title: "b", text: "" },
    ];
    const many = {
      claims: Array.from({ length: 30 }, (_, i) => ({
        id: `C${i}`,
        text: `claim ${i}`,
        sources: [
          { source: "S1", stance: "supports" as const, quote: "q".repeat(300) },
          { source: "[S2]", stance: "supports" as const, quote: "ok" },
        ],
      })),
    };
    const crossref = toCrossref(many, pages);
    expect(crossref.claims).toHaveLength(25);
    expect(crossref.claims[0].sources[0].quote.length).toBe(200);
    expect(crossref.claims[0].sources[1].url).toBe(WIKI);
    expect(formatCrossref("t", { claims: [], relations: [] }, pages)).toMatch(/no claim/);
  });

  it("asks Claude once, tool-less, for structured output at medium effort", async () => {
    query.mockReturnValue(
      (async function* () {
        yield { type: "result", subtype: "success", result: "", structured_output: analysis };
      })(),
    );
    const out = await analyseWithClaude("topic", [{ label: "S1", url: MC, title: "a", text: "body" }]);
    expect(out.claims).toHaveLength(3);
    const { options, prompt } = query.mock.calls[0][0];
    expect(options).toMatchObject({ model: "claude-opus-5-5", effort: "medium", tools: [], settingSources: [] });
    expect(options.outputFormat.type).toBe("json_schema");
    // the CLI rejects a draft-2020-12 `$schema` URI
    expect(options.outputFormat.schema.$schema).toBeUndefined();
    expect(options.outputFormat.schema.properties.claims.type).toBe("array");
    expect(prompt).toContain("[S1] a\nURL: " + MC);
  });
});
