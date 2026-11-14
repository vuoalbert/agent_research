import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chat route's World Labs trigger, end to end through POST /api/chat with
 * the Agent SDK mocked and a stand-in world service: a chat's FIRST research
 * turn starts its one world and reports a World Labs row; a later one, or a
 * turn without research, does nothing.
 */

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));
vi.mock("@tavily/core", () => ({ tavily: () => ({ search: vi.fn(), extract: vi.fn() }) }));

const WORLDS = Symbol.for("agent_research.worlds.service");
const RUNNER = Symbol.for("agent_research.visualize.runner");
type Holder = { [WORLDS]?: unknown; [RUNNER]?: unknown };
const worlds = new Set<string>();
const startWorld = vi.fn((chatId: string) => {
  worlds.add(chatId);
  return { status: "started" };
});

beforeEach(() => {
  query.mockReset();
  startWorld.mockClear();
  worlds.clear();
  (globalThis as Holder)[WORLDS] = { hasWorld: (id: string) => worlds.has(id), startWorld };
  (globalThis as Holder)[RUNNER] = { startJob: () => ({ status: "busy", job: { subject: "x" } }) };
});
afterEach(() => {
  delete (globalThis as Holder)[WORLDS];
  delete (globalThis as Holder)[RUNNER];
});

const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content } });
const success = { type: "result", subtype: "success", num_turns: 3, result: "" };
const research = async function* () {
  yield assistant({ type: "tool_use", id: "t1", name: "mcp__research__tavily_search", input: { query: "EV share Norway" } });
  yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "88.9%." } } };
  yield success;
};

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/chat/route");
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }));
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

const worldRows = (frames: { event?: string; data: { name?: string } }[]) =>
  frames.filter((f) => f.event === "tool" && f.data?.name === "World Labs");

describe("POST /api/chat — a chat's first research turn starts its world", () => {
  it("starts the world after the first research turn and reports one World Labs row before done", async () => {
    query.mockImplementation(research);
    const frames = await post({ chatId: "chat-1", messages: [{ role: "user", content: "What share of new cars in Norway are electric?" }] });

    expect(startWorld).toHaveBeenCalledTimes(1);
    expect(startWorld.mock.calls[0]).toEqual(["chat-1", expect.objectContaining({ topic: "What share of new cars in Norway are electric?", answer: "88.9%." })]);
    const rows = worldRows(frames);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ action: "world", chatId: "chat-1", status: "running", query: "What share of new cars in Norway are electric?" });
    const order = frames.map((f) => f.event);
    expect(order.lastIndexOf("tool")).toBeLessThan(order.indexOf("done"));
  });

  it("does nothing on a later research turn in the same chat", async () => {
    worlds.add("chat-1");
    query.mockImplementation(research);
    const frames = await post({ chatId: "chat-1", messages: [{ role: "user", content: "And Sweden?" }] });
    expect(startWorld).not.toHaveBeenCalled();
    expect(worldRows(frames)).toHaveLength(0);
  });

  it("does nothing for a turn without research, or without a chat id", async () => {
    query.mockImplementation(async function* () {
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi!" } } };
      yield success;
    });
    expect(worldRows(await post({ chatId: "chat-2", messages: [{ role: "user", content: "hi" }] }))).toHaveLength(0);
    query.mockImplementation(research);
    expect(worldRows(await post({ messages: [{ role: "user", content: "EVs in Norway?" }] }))).toHaveLength(0);
    expect(startWorld).not.toHaveBeenCalled();
  });
});
