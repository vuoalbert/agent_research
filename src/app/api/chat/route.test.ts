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
type Handler = (args: { query: string }, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));

const search = vi.fn();
const tavily = vi.fn((_options: { apiKey: string }) => ({ search }));
vi.mock("@tavily/core", () => ({ tavily: (options: { apiKey: string }) => tavily(options) }));

/** the Tavily handler the route handed the SDK in its latest call */
const searchHandler = () => {
  const { options } = query.mock.calls.at(-1)![0];
  return options.mcpServers.research.tools[0] as { name: string; handler: Handler };
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
    search.mockReset();
    tavily.mockClear();
    vi.stubEnv("TAVILY_API_KEY", "test-key");
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

  it("asks Opus 5.5 at high effort, with only Tavily search and no repo settings", async () => {
    query.mockReturnValue(stream(delta("x")));
    await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));

    const { options, prompt } = query.mock.calls[0][0];
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.effort).toBe("high");
    expect(options.thinking).toEqual({ type: "adaptive" });
    expect(options.systemPrompt).toContain("You are Agent Research, an AI assistant. Be concise.");
    expect(options.systemPrompt).toContain("tavily_search");
    expect(options.systemPrompt).toMatch(/cite/i);
    // no built-ins; the one MCP tool pre-approved, everything else denied
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(Object.keys(options.mcpServers)).toEqual(["research"]);
    expect(options.mcpServers.research.tools.map((t: { name: string }) => t.name)).toEqual(["tavily_search"]);
    expect(options.allowedTools).toEqual(["mcp__research__tavily_search"]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.maxTurns).toBeGreaterThanOrEqual(4);
    expect(options.includePartialMessages).toBe(true);
    // a single-turn ask goes over as itself, with no transcript preamble
    expect(prompt).toBe("hi");
  });

  it("streams a search as tool events and hands Claude the results as text", async () => {
    search.mockResolvedValue({
      results: [
        { title: "Marble", url: "https://www.worldlabs.ai/blog/marble", content: "Marble makes 3D worlds." },
        { title: "", url: "https://example.com/x", content: "Second." },
      ],
    });
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

    expect(tavily).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(search).toHaveBeenCalledWith("World Labs Marble", { searchDepth: "basic", maxResults: 5 });

    const frames = [...body.matchAll(/event: tool\ndata: (.*)/g)].map((m) => JSON.parse(m[1]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ name: "Tavily", query: "World Labs Marble", status: "running" });
    expect(frames[1]).toEqual({
      id: frames[0].id,
      status: "done",
      sources: [
        { title: "Marble", url: "https://www.worldlabs.ai/blog/marble" },
        { title: "https://example.com/x", url: "https://example.com/x" },
      ],
    });
    // in order: the text before the search, the search, the answer after it
    expect(body.indexOf("Let me look.")).toBeLessThan(body.indexOf("event: tool"));
    expect(body.lastIndexOf("event: tool")).toBeLessThan(body.indexOf("Marble is a world model."));
    // the answer after the search starts a new paragraph
    expect(body).toContain('data: {"text":"\\n\\nMarble is a world model."}');

    expect(toolText).toContain("[1] Marble");
    expect(toolText).toContain("URL: https://www.worldlabs.ai/blog/marble");
    expect(toolText).toContain("Marble makes 3D worlds.");
    expect(body.trimEnd().endsWith("event: done\ndata: {}")).toBe(true);
  });

  it("reports a missing key as a tool error, not a crash", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
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
    expect(result?.content[0].text).toMatch(/TAVILY_API_KEY/);
    expect(body).toMatch(/event: tool\ndata: \{[^\n]*"status":"error"/);
    expect(body).toContain("Search is down.");
    expect(body.trimEnd().endsWith("event: done\ndata: {}")).toBe(true);
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

  it("rejects a body with no turns in it", async () => {
    const response = await post({ messages: [] });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
