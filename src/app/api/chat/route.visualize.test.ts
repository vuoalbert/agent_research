import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chat route's Visualize rule, end to end through POST /api/chat with the
 * Agent SDK mocked and a stand-in runner: a research turn always ends with
 * exactly one visualization, Claude's own or the route's fallback; a turn
 * without research gets none.
 */

type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: { text: string }[] }>;
const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));
vi.mock("@tavily/core", () => ({ tavily: () => ({ search: vi.fn(), extract: vi.fn() }) }));

const KEY = Symbol.for("agent_research.visualize.runner");
type Holder = { [KEY]?: unknown };
const startJob = vi.fn();

beforeEach(() => {
  query.mockReset();
  startJob.mockReset();
  startJob.mockImplementation((input: { subject: string }) => ({
    status: "started",
    job: { id: `20261114-1300-job-${startJob.mock.calls.length}`, subject: input.subject, status: "running", createdAt: 1 },
  }));
  (globalThis as Holder)[KEY] = { startJob };
});
afterEach(() => {
  delete (globalThis as Holder)[KEY];
});

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content } });
const success = { type: "result", subtype: "success", num_turns: 3, result: "" };

async function post(question: string) {
  const { POST } = await import("@/app/api/chat/route");
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: question }] }),
    }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => ({ event: /^event: (.+)$/m.exec(frame)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "null") }));
}

const visualizeFrames = (frames: { event?: string; data: { name?: string } }[]) =>
  frames.filter((f) => f.event === "tool" && f.data?.name === "Visualize");

describe("POST /api/chat — every research turn ends with one figure", () => {
  it("starts one itself, before `done`, after a research turn Claude did not visualize", async () => {
    query.mockImplementation(async function* () {
      yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__tavily_search", input: { query: "EV share Norway" } });
      yield delta("88.9% of new cars were electric in 2024.");
      yield assistant({ type: "text", text: "88.9% of new cars were electric in 2024." });
      yield success;
    });
    const frames = await post("What share of new cars in Norway are electric?");

    expect(startJob).toHaveBeenCalledTimes(1);
    expect(startJob.mock.calls[0][0]).toMatchObject({
      subject: "What share of new cars in Norway are electric?",
      origin: "research",
      brief: expect.stringContaining("Key numbers:\n- 88.9 % (2024)"),
    });
    const rows = visualizeFrames(frames);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ action: "visualize", jobId: "20261114-1300-job-1", status: "running" });
    // the row, and its done frame, go out before the turn's own done
    const order = frames.map((f) => f.event);
    expect(order.lastIndexOf("tool")).toBeLessThan(order.indexOf("done"));
  });

  it("adds nothing when Claude called visualize itself", async () => {
    query.mockImplementation(async function* (args: { options: { mcpServers: Record<string, { tools: { handler: Handler }[] }> } }) {
      yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__tavily_extract", input: {} });
      await args.options.mcpServers.visualize.tools[0].handler({ subject: "EV share as a tally counter", explicit: false });
      yield success;
    });
    const frames = await post("Read these two reports on EV share");
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(startJob.mock.calls[0][0]).toMatchObject({ subject: "EV share as a tally counter", origin: "chat", explicit: false });
    expect(visualizeFrames(frames)).toHaveLength(1);
  });

  it("starts nothing for a turn without research", async () => {
    query.mockImplementation(async function* () {
      yield delta("Hello!");
      yield assistant({ type: "text", text: "Hello!" });
      yield success;
    });
    const frames = await post("hi");
    expect(startJob).not.toHaveBeenCalled();
    expect(visualizeFrames(frames)).toHaveLength(0);
  });

  it("starts nothing for a research turn that did not finish", async () => {
    query.mockImplementation(async function* () {
      yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__tavily_search", input: {} });
      yield { type: "result", subtype: "error_max_turns", num_turns: 16 };
    });
    await post("What share of new cars in Norway are electric?");
    expect(startJob).not.toHaveBeenCalled();
  });

  it("registers the tool and tells Claude about it", async () => {
    query.mockImplementation(async function* () {
      yield success;
    });
    await post("hi");
    const { options } = query.mock.calls[0][0];
    expect(options.allowedTools).toContain("mcp__visualize__visualize");
    expect(options.mcpServers.visualize.tools.map((t: { name: string }) => t.name)).toEqual(["visualize"]);
    expect(options.systemPrompt).toMatch(/collect material that visualizes well/);
  });
});
