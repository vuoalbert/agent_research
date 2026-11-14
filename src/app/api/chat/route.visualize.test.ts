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
const sendMessage = vi.fn();
const currentJob = vi.fn();

beforeEach(() => {
  query.mockReset();
  startJob.mockReset();
  sendMessage.mockReset();
  currentJob.mockReset();
  startJob.mockImplementation((input: { subject: string }) => ({
    status: "started",
    job: { id: `20261114-1300-job-${startJob.mock.calls.length}`, subject: input.subject, status: "running", createdAt: 1 },
  }));
  (globalThis as Holder)[KEY] = { startJob, sendMessage, currentJob };
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
      yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__web_search", input: { query: "EV share Norway" } });
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
      yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__web_read", input: {} });
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
      yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__web_search", input: {} });
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
    expect(options.mcpServers.visualize.tools.map((t: { name: string }) => t.name)).toEqual([
      "visualize",
      "message_visualize",
      "visualize_status",
    ]);
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(["mcp__visualize__message_visualize", "mcp__visualize__visualize_status"]),
    );
    expect(options.systemPrompt).toMatch(/collect material that visualizes well/);
    // a change to the current figure is a message, not a new figure
    expect(options.systemPrompt).toMatch(/change, adjust, fix or annotate the current figure[^\n]*call message_visualize/);
    expect(options.systemPrompt).toMatch(/Don't call visualize for this/);
  });
});

describe("POST /api/chat — talking to the Visualize agent", () => {
  type Tools = { name: string; handler: Handler }[];
  type Args = { options: { mcpServers: Record<string, { tools: Tools }> } };
  const handler = (args: Args, name: string) => args.options.mcpServers.visualize.tools.find((t) => t.name === name)!.handler;
  const running = { id: "20261114-1300-bell-0001", subject: "a bicycle bell", status: "running", createdAt: 1 };

  it("sends the request to the current figure's agent, reports a visualize-message row, and starts no figure", async () => {
    sendMessage.mockReturnValue({ status: "live", job: running });
    let reply = "";
    query.mockImplementation(async function* (args: Args) {
      // research in the same turn would otherwise end with a figure of its own
      yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__web_search", input: { query: "bell" } });
      reply = (await handler(args, "message_visualize")({ message: "Make the bell dome blue and label the striker." })).content[0].text;
      yield success;
    });
    const frames = await post("make the bell dome blue and label the striker");

    expect(sendMessage).toHaveBeenCalledWith("Make the bell dome blue and label the striker.");
    expect(reply).toMatch(/Sent to the Visualize agent; it's applying it now/);
    const rows = visualizeFrames(frames);
    expect(rows.map((r) => r.data)).toEqual([
      {
        id: expect.any(String),
        name: "Visualize",
        action: "visualize-message",
        query: "Make the bell dome blue and label the striker.",
        jobId: running.id,
        status: "running",
      },
    ]);
    expect(frames.filter((f) => f.event === "tool").map((f) => f.data.status)).toContain("done");
    expect(startJob).not.toHaveBeenCalled();
  });

  it("says when the figure was picked back up", async () => {
    sendMessage.mockReturnValue({ status: "resumed", job: { ...running, status: "running" } });
    let reply = "";
    query.mockImplementation(async function* (args: Args) {
      reply = (await handler(args, "message_visualize")({ message: "add a caption saying 'ring ring'" })).content[0].text;
      yield success;
    });
    await post("add a caption saying 'ring ring'");
    expect(reply).toMatch(/picked the finished figure of "a bicycle bell" back up/);
  });

  it("tells Claude there is nothing to message when there is no visualization, with no row", async () => {
    sendMessage.mockReturnValue({ status: "none" });
    let reply = "";
    query.mockImplementation(async function* (args: Args) {
      reply = (await handler(args, "message_visualize")({ message: "make it blue" })).content[0].text;
      // so Claude can still start one in the same turn
      await handler(args, "visualize")({ subject: "a bicycle bell", explicit: true });
      yield success;
    });
    const frames = await post("make it blue");
    expect(reply).toMatch(/no visualization to message/);
    expect(reply).toMatch(/call visualize/);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(visualizeFrames(frames).map((r) => r.data)).toEqual([expect.objectContaining({ action: "visualize" })]);
  });

  it("reports a figure that can't take messages as a failed row", async () => {
    sendMessage.mockReturnValue({ status: "unavailable", job: { ...running, status: "done" }, reason: "Its agent session wasn't saved" });
    let result: { content: { text: string }[]; isError?: boolean } | undefined;
    query.mockImplementation(async function* (args: Args) {
      result = await handler(args, "message_visualize")({ message: "make it blue" });
      yield success;
    });
    const frames = await post("make it blue");
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/session wasn't saved/) }] });
    expect(frames.filter((f) => f.event === "tool").map((f) => f.data)).toEqual([
      expect.objectContaining({ action: "visualize-message", status: "running" }),
      expect.objectContaining({ status: "error", message: "Its agent session wasn't saved" }),
    ]);
  });

  it("visualize_status reads the current figure: subject, status, elapsed, reply and progress", async () => {
    currentJob.mockReturnValue({
      ...running,
      startedAt: 1,
      elapsedMs: 125_000,
      messages: 1,
      lastReply: "Made the dome blue and labelled the striker.",
      log: [
        { t: 1, text: "Message from chat: make it blue" },
        { t: 2, text: "Bash: node build.mjs --light" },
      ],
    });
    let reply = "";
    query.mockImplementation(async function* (args: Args) {
      reply = (await handler(args, "visualize_status")({})).content[0].text;
      yield success;
    });
    const frames = await post("how is the figure going?");
    expect(currentJob).toHaveBeenCalledWith(8);
    expect(reply).toContain("Subject: a bicycle bell");
    expect(reply).toContain("Status: building (running for 2m 05s)");
    expect(reply).toContain("Agent's last reply: Made the dome blue and labelled the striker.");
    expect(reply).toContain("- Bash: node build.mjs --light");
    // read-only: no row, nothing started or sent
    expect(visualizeFrames(frames)).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  });
});
