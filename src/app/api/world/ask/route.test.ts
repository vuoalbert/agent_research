import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/world/ask with the Agent SDK mocked: with a Telem key, Claude's
 * only research tools are the in-process telem_search / telem_fetch, and a
 * tool call streams a `trace` event before the answer; without a key it falls
 * back to web search.
 */

type Options = { tools: string[]; allowedTools: string[]; mcpServers?: Record<string, { tools: { name: string; handler: Function }[] }>; systemPrompt: string; maxTurns: number };
const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));
const planSearch = vi.fn();
vi.mock("@/server/worlds/telem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/worlds/telem")>()),
  planSearch: (...args: unknown[]) => planSearch(...args),
}));

beforeEach(() => {
  query.mockReset();
  planSearch.mockReset();
});
afterEach(() => {
  delete process.env.TELEM_API_KEY;
});

async function ask(body: Record<string, unknown>) {
  const { POST } = await import("./route");
  const response = await POST(new Request("http://localhost/api/world/ask", { method: "POST", body: JSON.stringify(body) }));
  return (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => ({ event: block.match(/^event: (.*)$/m)![1], data: JSON.parse(block.match(/^data: (.*)$/m)![1]) }));
}
const body = { question: "What changed?", pages: [{ title: "A", url: "https://a.gov", text: "text" }], chatId: "chat-1" };

describe("POST /api/world/ask", () => {
  it("researches with the Telem tools and streams each call as a trace event", async () => {
    process.env.TELEM_API_KEY = "k";
    planSearch.mockResolvedValue({
      query: "q",
      trace: [{ intent: "news", note: "n", providers: ["exa"], ms: 900, found: 3, kept: 1 }],
      ms: 900,
      providers: ["exa"],
      total: 3,
      dropped: [],
      results: [{ url: "https://apnews.com/a", title: "AP", summary: "", rank: 1, provider: "exa", intent: "news", intents: ["news"], trust: { score: 0.82, label: "Reputable news", host: "apnews.com" } }],
    });
    query.mockImplementation(({ options }: { options: Options }) =>
      (async function* () {
        const search = options.mcpServers!.telem.tools.find((t) => t.name === "telem_search")!;
        await search.handler({ query: "congestion pricing", focus: "news" }, {});
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Per AP [web]." } } };
        yield { type: "result", subtype: "success" };
      })(),
    );
    const events = await ask(body);
    const { options } = query.mock.calls[0][0] as { options: Options };
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(["mcp__telem__telem_search", "mcp__telem__telem_fetch"]);
    expect(options.maxTurns).toBe(8);
    expect(options.systemPrompt).toContain("telem_search");
    expect(planSearch.mock.calls[0][2].lineage).toMatchObject({ chatId: "chat-1" });
    expect(events.map((e) => e.event)).toEqual(["trace", "delta", "done"]);
    expect(events[0].data).toMatchObject({ tool: "search", focus: "news", query: "congestion pricing", providers: ["exa"], kept: 1 });
  });

  it("falls back to web search without a Telem key", async () => {
    query.mockImplementation(() => (async function* () { yield { type: "result", subtype: "success" }; })());
    await ask(body);
    const { options } = query.mock.calls[0][0] as { options: Options };
    expect(options.tools).toEqual(["WebSearch"]);
    expect(options.allowedTools).toEqual(["WebSearch"]);
    expect(options.mcpServers).toBeUndefined();
    expect(options.systemPrompt).not.toContain("telem_search");
  });
});
