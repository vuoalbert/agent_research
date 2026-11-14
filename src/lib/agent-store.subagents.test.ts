import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAgentStore,
  applyToolEvent,
  getAgentState,
  newChat,
  selectChatSources,
  sendMessage,
  settleCall,
  stopStreaming,
  type Message,
  type ToolCall,
} from "@/lib/agent-store";

/**
 * The store's side of deploy_subagents: the group row updates in place as its
 * subagents move on, their own calls are kept (tagged) beside it so their
 * sources count like any other, and a cut-off group settles.
 */

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
function sse(frames: string[], signal?: AbortSignal | null) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      if (!signal) return controller.close();
      signal.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted.", "AbortError")));
    },
  });
  return new Response(body, { status: 200 });
}

const sub = (id: string, shape: string, status: string, line: string) => ({ id, title: `Angle ${id}`, shape, status, line, startedAt: 1 });
const group = (status: string, subagents: unknown[]) => ({
  id: "g1",
  name: "Subagents",
  action: "subagents",
  query: "Angle a · Angle b",
  status,
  subagents,
});
const TOYOTA = { title: "Toyota", url: "https://global.toyota/ssb" };
const QS = { title: "QuantumScape", url: "https://ir.quantumscape.com/q3" };

describe("agent store — subagents", () => {
  beforeEach(() => {
    __resetAgentStore();
    vi.restoreAllMocks();
  });

  it("updates the group in place, keeps tagged subagent calls, and counts their sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse([
          frame("tool", group("running", [sub("a", "square", "running", "Waiting to start"), sub("b", "circle", "running", "Waiting to start")])),
          frame("tool", { id: "s1", name: "Tavily", query: "toyota ssb", status: "running", parentId: "g1", agentId: "a" }),
          frame("tool", group("running", [sub("a", "square", "running", "Searching “toyota ssb”"), sub("b", "circle", "running", "Starting")])),
          frame("tool", { id: "s1", status: "done", sources: [TOYOTA], parentId: "g1", agentId: "a" }),
          frame("tool", { id: "s2", name: "Tavily", action: "read", query: "ir.quantumscape.com", status: "running", parentId: "g1", agentId: "b" }),
          frame("tool", { id: "s2", status: "done", sources: [QS] }),
          frame("tool", { ...group("done", [sub("a", "square", "done", "Toyota aims for 2027"), sub("b", "circle", "error", "Timed out after 3 min")]) }),
          frame("delta", { text: "Around 2027." }),
          frame("done", {}),
        ]),
      ),
    );
    const id = newChat();
    sendMessage(id, "solid-state?");
    await settle();

    const tools = getAgentState().messages[id][1].tools!;
    expect(tools.map((t) => t.id)).toEqual(["g1", "s1", "s2"]);
    const [g, s1, s2] = tools;
    expect(g).toMatchObject({ name: "Subagents", action: "subagents", status: "done" });
    expect(g.subagents!.map((s) => [s.shape, s.status, s.line])).toEqual([
      ["square", "done", "Toyota aims for 2027"],
      ["circle", "error", "Timed out after 3 min"],
    ]);
    expect(s1).toMatchObject({ parentId: "g1", agentId: "a", status: "done", sources: [TOYOTA] });
    expect(s2).toMatchObject({ parentId: "g1", agentId: "b", action: "read", sources: [QS] });
    // the subagents' sources are the chat's sources (Knowledge base, cross_reference, graph)
    expect(selectChatSources(getAgentState().messages[id])).toEqual([TOYOTA, QS]);
    // and go back to the route with the next request
    sendMessage(id, "more?");
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(body.sources).toEqual([TOYOTA, QS]);
  });

  it("drops a malformed subagents list's junk, and leaves calls without one alone", () => {
    const tools = applyToolEvent(undefined, {
      ...group("running", [{ id: "a", title: "A", shape: "blob" }, null, { title: "no id" }]),
    } as never);
    expect(tools[0].subagents).toEqual([{ id: "a", title: "A", shape: "square", status: "running", line: "" }]);
    const plain = applyToolEvent(undefined, { id: "t", name: "Tavily", query: "q", status: "running" });
    expect(plain[0]).toEqual({ id: "t", name: "Tavily", query: "q", status: "running" });
    // a repeated plain start is still a no-op
    expect(applyToolEvent(plain, { id: "t", name: "Tavily", query: "other", status: "running" })).toEqual(plain);
  });

  it("settles a group cut off by Stop: it and its running subagents fail, finished ones stay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
          sse(
            [
              frame("tool", group("running", [sub("a", "square", "done", "Found it"), sub("b", "circle", "running", "Searching")])),
              frame("tool", { id: "s1", name: "Tavily", query: "x", status: "running", parentId: "g1", agentId: "b" }),
            ],
            init.signal,
          ),
        ),
      ),
    );
    const id = newChat();
    sendMessage(id, "q");
    await settle();
    stopStreaming(id);
    await settle();
    const [g, s1] = getAgentState().messages[id][1].tools!;
    expect(g.status).toBe("error");
    expect(g.subagents!.map((s) => s.status)).toEqual(["done", "error"]);
    expect(s1.status).toBe("error");
  });

  it("settleCall leaves a finished call as it is", () => {
    const done: ToolCall = { id: "t", name: "Tavily", query: "q", status: "done", sources: [] };
    expect(settleCall(done)).toBe(done);
  });

  it("loads chats saved before subagents", () => {
    const old: Message[] = [{ id: "m", role: "assistant", content: "x", createdAt: 1, tools: [{ id: "t", name: "Tavily", query: "q", status: "done" }] }];
    expect(selectChatSources(old)).toEqual([]);
  });
});
