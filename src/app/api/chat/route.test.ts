import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route with the Agent SDK mocked. What is asserted here is the contract
 * either side depends on: the SSE frames the store parses, the history cap, and
 * that a failure is reported rather than swallowed.
 *
 * The live model is exercised separately, opt-in, in
 * `src/__tests__/sonnet.live.test.ts`.
 */
const query = vi.fn();
/* `tool` and `createSdkMcpServer` stand in as plain records, so a test can
   reach the handler the route registered and call it the way Claude would. */
type Handler = (args: { query: string } | { urls: string[] }, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));

/* Tavily is only the fallback when Telem errors */
const tavilySearch = vi.fn();
const tavilyExtract = vi.fn();
const tavily = vi.fn((_options: { apiKey: string }) => ({ search: tavilySearch, extract: tavilyExtract }));
vi.mock("@tavily/core", () => ({ tavily: (options: { apiKey: string }) => tavily(options) }));

import { fetchResponse, installTelemFake, searchResponse } from "@/test/telem-fake";

let search: ReturnType<typeof vi.fn>;
let extract: ReturnType<typeof vi.fn>;

/** the web_search handler the route handed the SDK in its latest call */
const searchHandler = () => {
  const { options } = query.mock.calls.at(-1)![0];
  return options.mcpServers.research.tools[0] as { name: string; handler: Handler };
};
/** the web_read (Telem fetch) handler */
const extractHandler = () => {
  const { options } = query.mock.calls.at(-1)![0];
  return options.mcpServers.research.tools[1] as { name: string; handler: Handler };
};

/** the SDK's frame for one Messages API streaming event */
const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

async function* stream(...messages: unknown[]) {
  for (const message of messages) yield message;
}

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/chat/route");
  return POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }));
};

const readAll = async (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
};

describe("POST /api/chat", () => {
  beforeEach(() => {
    query.mockReset();
    ({ search, fetch: extract } = installTelemFake());
    tavilySearch.mockReset();
    tavilyExtract.mockReset();
    tavily.mockClear();
    vi.stubEnv("TAVILY_API_KEY", "");
  });

  it("streams text deltas as SSE, then done", async () => {
    query.mockReturnValue(stream(delta("Pack "), delta("wool.")));
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));

    expect(body).toContain('event: delta\ndata: {"text":"Pack "}');
    expect(body).toContain('event: delta\ndata: {"text":"wool."}');
    expect(body.trimEnd().endsWith("event: done\ndata: {}")).toBe(true);
  });

  it("is a Node-runtime event stream", async () => {
    query.mockReturnValue(stream(delta("x")));
    const route = await import("@/app/api/chat/route");
    expect(route.runtime).toBe("nodejs");
    const response = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await readAll(response);
  });

  it("asks Opus 5.5 at high effort, with only Telem search, read, cross_reference, the vault and subagents, and no repo settings", async () => {
    query.mockReturnValue(stream(delta("x")));
    await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));

    const { options, prompt } = query.mock.calls[0][0];
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.effort).toBe("high");
    expect(options.thinking).toEqual({ type: "adaptive" });
    expect(options.systemPrompt).toContain("You are Agent Research, an AI assistant. Be concise.");
    expect(options.systemPrompt).toContain("web_search");
    expect(options.systemPrompt).toMatch(/cite/i);
    // no built-ins; the one MCP tool pre-approved, everything else denied
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(Object.keys(options.mcpServers)).toEqual(["research", "visualize", "telem_watch"]);
    expect(options.mcpServers.research.tools.map((t: { name: string }) => t.name)).toEqual([
      "web_search",
      "web_read",
      "cross_reference",
      "vault_search",
      "vault_read",
      "vault_write",
      "deploy_subagents",
    ]);
    expect(options.allowedTools).toEqual([
      "mcp__research__web_search",
      "mcp__research__web_read",
      "mcp__research__cross_reference",
      "mcp__research__vault_search",
      "mcp__research__vault_read",
      "mcp__research__vault_write",
      "mcp__research__deploy_subagents",
      "mcp__visualize__visualize",
      "mcp__visualize__message_visualize",
      "mcp__visualize__visualize_status",
      "mcp__telem_watch__watch_topic",
      "mcp__telem_watch__monitor_status",
      "mcp__telem_watch__ask_monitor",
      "mcp__telem_watch__pause_monitor",
      "mcp__telem_watch__resume_monitor",
      "mcp__telem_watch__run_monitor_now",
    ]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.maxTurns).toBe(16);
    expect(options.includePartialMessages).toBe(true);
    // a single-turn ask goes over as itself, with no transcript preamble
    expect(prompt).toBe("hi");
  });

  it("tells Claude to read and cross-reference sources, without counting them", async () => {
    query.mockReturnValue(stream(delta("x")));
    await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    const { systemPrompt } = query.mock.calls[0][0].options;
    expect(systemPrompt).toContain("web_read");
    expect(systemPrompt).toMatch(/cross-reference/i);
    expect(systemPrompt).toMatch(/at least two sources/i);
    expect(systemPrompt).toMatch(/disagree/i);
    expect(systemPrompt).toMatch(/primary or official/i);
    expect(systemPrompt).toMatch(/do not mention how many sources/i);
    expect(systemPrompt).toMatch(/don't need outside facts/i);
    expect(systemPrompt).toMatch(/call cross_reference once/i);
  });

  it("streams a page read as a 'read' tool event and hands Claude each page, capped", async () => {
    const long = "x".repeat(7000);
    extract.mockResolvedValue(
      fetchResponse([
        { url: "https://www.minecraft.net/en-us/article/sales", title: "Minecraft sales", content: "300 million copies.", provider: "exa" },
        { url: "https://en.wikipedia.org/wiki/Minecraft", content: long, provider: "jina" },
        { url: "https://blocked.example.com/a", error: { message: "403 Forbidden" } },
      ]),
    );
    let toolText = "";
    const urls = [
      "https://www.minecraft.net/en-us/article/sales",
      "https://en.wikipedia.org/wiki/Minecraft",
      "https://blocked.example.com/a",
    ];
    query.mockImplementation(() =>
      (async function* () {
        const result = await extractHandler().handler({ urls }, {});
        toolText = result.content[0].text;
        yield delta("Both agree.");
      })(),
    );
    const body = await readAll(await post({ messages: [{ role: "user", content: "minecraft sales" }] }));

    expect(extractHandler().name).toBe("web_read");
    // Telem's failover chain (no pinned providers), at the default tier
    expect(extract).toHaveBeenCalledWith(urls, expect.objectContaining({ tier: "default" }));
    expect(extract.mock.calls[0][1]).not.toHaveProperty("providers");
    expect(tavily).not.toHaveBeenCalled();
    const frames = [...body.matchAll(/event: tool\ndata: (.*)/g)].map((m) => JSON.parse(m[1]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      name: "Telem",
      action: "read",
      query: "minecraft.net, en.wikipedia.org, blocked.example.com",
      status: "running",
    });
    // the pages actually read become sources; the failed one does not
    expect(frames[1]).toEqual({
      id: frames[0].id,
      status: "done",
      sources: [
        { title: "Minecraft sales", url: "https://www.minecraft.net/en-us/article/sales" },
        { title: "https://en.wikipedia.org/wiki/Minecraft", url: "https://en.wikipedia.org/wiki/Minecraft" },
      ],
      telem: { providers: ["exa", "jina"], latencyMs: expect.any(Number) },
    });
    expect(toolText).toContain("[1] Minecraft sales\nURL: https://www.minecraft.net/en-us/article/sales\n300 million copies.");
    expect(toolText).toContain("x".repeat(6000));
    expect(toolText).not.toContain("x".repeat(6001));
    expect(toolText).toContain("[truncated: showing the first 6000 of 7000 characters]");
    expect(toolText).toContain("Could not read https://blocked.example.com/a: 403 Forbidden");
  });

  it("returns an error to Claude when no page could be read, and when Telem fetch throws", async () => {
    extract.mockResolvedValueOnce(fetchResponse([{ url: "https://a.com", error: { message: "timeout" } }], { status: "partially_succeeded" }));
    extract.mockRejectedValueOnce(new Error("rate limited"));
    const results: Awaited<ReturnType<Handler>>[] = [];
    query.mockImplementation(() =>
      (async function* () {
        results.push(await extractHandler().handler({ urls: ["https://a.com"] }, {}));
        results.push(await extractHandler().handler({ urls: ["https://a.com"] }, {}));
        yield delta("ok");
      })(),
    );
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    expect(results[0].isError).toBe(true);
    expect(results[0].content[0].text).toContain("Could not read https://a.com: timeout");
    expect(results[1].isError).toBe(true);
    expect(results[1].content[0].text).toContain("rate limited");
    expect(body).toMatch(/"status":"error"/);
  });

  it("streams a search as tool events and hands Claude the results as text", async () => {
    search.mockResolvedValue(
      searchResponse({
        exa: [
          { title: "Marble", url: "https://www.worldlabs.ai/blog/marble", summary: "Marble makes 3D worlds." },
          { title: "", url: "https://example.com/x", summary: "Second." },
        ],
        brave: [{ title: "Marble", url: "https://worldlabs.ai/blog/marble/", summary: "Marble, by World Labs." }],
      }),
    );
    let toolText = "";
    query.mockImplementation(() =>
      (async function* () {
        yield delta("Let me look.");
        yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use" } } };
        const result = await searchHandler().handler({ query: "World Labs Marble" }, {});
        toolText = result.content[0].text;
        yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } };
        yield delta("Marble is a world model.");
      })(),
    );
    const body = await readAll(await post({ messages: [{ role: "user", content: "what is marble" }] }));

    expect(tavily).not.toHaveBeenCalled();
    // auto-routed across Telem's providers, 5 rows each, at the default tier
    expect(search).toHaveBeenCalledWith(
      "World Labs Marble",
      expect.objectContaining({ tier: "default", autoRouting: "accuracy", numResults: 5 }),
    );
    expect(search.mock.calls[0][1]).not.toHaveProperty("providersInclude");

    const frames = [...body.matchAll(/event: tool\ndata: (.*)/g)].map((m) => JSON.parse(m[1]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ name: "Telem", query: "World Labs Marble", status: "running" });
    // one page two providers found is one source, ranked first
    expect(frames[1]).toEqual({
      id: frames[0].id,
      status: "done",
      sources: [
        { title: "Marble", url: "https://www.worldlabs.ai/blog/marble" },
        { title: "https://example.com/x", url: "https://example.com/x" },
      ],
      telem: { providers: ["exa", "brave"], latencyMs: expect.any(Number) },
    });
    // in order: the text before the search, the search, the answer after it
    expect(body.indexOf("Let me look.")).toBeLessThan(body.indexOf("event: tool"));
    expect(body.lastIndexOf("event: tool")).toBeLessThan(body.indexOf("Marble is a world model."));
    // the answer after the search starts a new paragraph
    expect(body).toContain('data: {"text":"\\n\\nMarble is a world model."}');

    expect(toolText).toContain("[1] Marble");
    expect(toolText).toContain("URL: https://www.worldlabs.ai/blog/marble");
    expect(toolText).toContain("Found by: exa, brave");
    expect(toolText).toContain("Marble makes 3D worlds.");
    expect(body.trimEnd().endsWith("event: done\ndata: {}")).toBe(true);
  });

  it("reports a missing key as a tool error, not a crash", async () => {
    vi.stubEnv("TELEM_API_KEY", "");
    let result: Awaited<ReturnType<Handler>> | undefined;
    query.mockImplementation(() =>
      (async function* () {
        result = await searchHandler().handler({ query: "q" }, {});
        yield delta("Search is down.");
      })(),
    );
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));

    expect(search).not.toHaveBeenCalled();
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/TELEM_API_KEY/);
    expect(body).toMatch(/event: tool\ndata: \{[^\n]*"status":"error"/);
    expect(body).toContain("Search is down.");
    expect(body.trimEnd().endsWith("event: done\ndata: {}")).toBe(true);
  });

  it("falls back to Tavily only when Telem errors, and says so in the log", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tavily-key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    search.mockRejectedValue(new Error("502 bad gateway"));
    tavilySearch.mockResolvedValue({ results: [{ title: "Marble", url: "https://www.worldlabs.ai/blog/marble", content: "3D." }] });
    let toolText = "";
    query.mockImplementation(() =>
      (async function* () {
        toolText = (await searchHandler().handler({ query: "World Labs Marble" }, {})).content[0].text;
        yield delta("ok");
      })(),
    );
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    expect(tavily).toHaveBeenCalledWith({ apiKey: "tavily-key" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/falling back to Tavily/));
    expect(toolText).toContain("URL: https://www.worldlabs.ai/blog/marble");
    // the row is still a Telem row, and its sources are the fallback's
    const frames = [...body.matchAll(/event: tool\ndata: (.*)/g)].map((m) => JSON.parse(m[1]));
    expect(frames[0]).toMatchObject({ name: "Telem", status: "running" });
    expect(frames[1]).toMatchObject({ status: "done", sources: [{ url: "https://www.worldlabs.ai/blog/marble" }] });
    warn.mockRestore();
  });

  it("reports a failed search as a tool error", async () => {
    search.mockRejectedValue(new Error("rate limited"));
    let result: Awaited<ReturnType<Handler>> | undefined;
    query.mockImplementation(() =>
      (async function* () {
        result = await searchHandler().handler({ query: "q" }, {});
        yield delta("ok");
      })(),
    );
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain("rate limited");
    expect(body).toMatch(/"status":"error"/);
  });

  it("caps the history at the last 30 turns and labels the speakers", async () => {
    query.mockReturnValue(stream(delta("x")));
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    await readAll(await post({ messages }));

    const { prompt } = query.mock.calls[0][0];
    expect(prompt).not.toContain("turn 9"); // dropped: outside the last 30
    expect(prompt).toContain("turn 10"); // kept: the oldest of the 30
    expect(prompt).toContain("User: turn 10");
    expect(prompt).toContain("Agent Research: turn 11");
    // the newest turn is the question, not part of the transcript
    expect(prompt.trimEnd().endsWith("User: turn 39")).toBe(true);
  });

  it("reports a failure as an error event rather than a dead stream", async () => {
    query.mockImplementation(() => {
      throw new Error("Claude Code is not logged in");
    });
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    expect(body).toContain("event: error");
    expect(body).toContain("Claude Code is not logged in");
  });

  it("accepts the chat's sources and rejects malformed ones", async () => {
    query.mockReturnValue(stream(delta("x")));
    const messages = [{ role: "user", content: "hi" }];
    const ok = await post({ messages, sources: [{ title: "A", url: "https://a.com" }, { url: "http://b.com/x" }] });
    expect(ok.status).toBe(200);
    await readAll(ok);
    expect((await post({ messages, sources: "nope" })).status).toBe(400);
    expect((await post({ messages, sources: [{ title: "x", url: "javascript:alert(1)" }] })).status).toBe(400);
    expect((await post({ messages, sources: [{ title: "x" }] })).status).toBe(400);
    const tooMany = Array.from({ length: 61 }, (_, i) => ({ title: `${i}`, url: `https://s${i}.com` }));
    expect((await post({ messages, sources: tooMany })).status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("hands cross_reference the chat's sources plus this request's finds", async () => {
    search.mockResolvedValue(
      searchResponse([{ title: "New", url: "https://new.example.com/a", summary: "Sold 238 million. ".repeat(10) }]),
    );
    extract.mockResolvedValue(
      fetchResponse([
        { url: "https://a.com", title: "A", content: "Sold 300 million. ".repeat(10) },
        { url: "https://new.example.com/a", title: "New", content: "Sold 238 million. ".repeat(10) },
      ]),
    );
    let toolText = "";
    const analysis = {
      claims: [
        {
          id: "C1",
          text: "Minecraft sold 300 million copies.",
          sources: [
            { source: "S1", stance: "supports", quote: "Sold 300 million." },
            { source: "S2", stance: "contradicts", quote: "Sold 238 million." },
          ],
        },
      ],
    };
    query.mockImplementation((args: { options: { outputFormat?: unknown } }) =>
      args.options.outputFormat
        ? // the nested, structured analysis call
          (async function* () {
            yield { type: "result", subtype: "success", result: "", structured_output: analysis };
          })()
        : (async function* () {
            await searchHandler().handler({ query: "minecraft sales" }, {});
            const crossref = options().mcpServers.research.tools[2] as { name: string; handler: Handler };
            expect(crossref.name).toBe("cross_reference");
            toolText = (await crossref.handler({ topic: "sales" } as never, {})).content[0].text;
            yield delta("ok");
          })(),
    );
    const options = () => query.mock.calls[0][0].options;
    const body = await readAll(
      await post({ messages: [{ role: "user", content: "hi" }], sources: [{ title: "A", url: "https://a.com" }] }),
    );
    expect(extract).toHaveBeenCalledWith(
      ["https://a.com", "https://new.example.com/a"],
      expect.objectContaining({ tier: "default", metadata: { caller: "crossref" } }),
    );
    expect(toolText).toContain('✗ new.example.com ("Sold 238 million.")');
    const frames = [...body.matchAll(/event: tool\ndata: (.*)/g)].map((m) => JSON.parse(m[1]));
    const start = frames.find((f) => f.name === "Cross-reference");
    expect(start).toMatchObject({ action: "crossref", query: "sales", status: "running" });
    expect(frames.find((f) => f.id === start.id && f.status === "done").crossref.relations).toEqual([
      { a: "https://a.com", b: "https://new.example.com/a", kind: "conflicts", claims: ["C1"] },
    ]);
  });

  it("rejects a body with no turns in it", async () => {
    const response = await post({ messages: [] });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
