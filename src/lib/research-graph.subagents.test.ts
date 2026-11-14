import { describe, expect, it } from "vitest";

import { parseRequest } from "@/app/api/graph-chat/navigate";
import type { Chat, Message, ToolCall } from "@/lib/agent-store";
import { graphChatPayload } from "@/lib/graph-highlight";
import { buildResearchGraph, chatNodeId, pageNodeId, subagentNodeId } from "@/lib/research-graph";

/** The Force graph with subagents: chat → subagent → its searches → their pages. */

const chat: Chat = { id: "c1", title: "Solid-state batteries", createdAt: 0, updatedAt: 0 };
const ask: Message = { id: "u", role: "user", content: "q", createdAt: 0 };
const turn = (tools: ToolCall[]): Message => ({ id: "m1", role: "assistant", content: "", createdAt: 0, tools });
const src = (url: string) => ({ title: `Title of ${url}`, url });

const group: ToolCall = {
  id: "g1",
  name: "Subagents",
  action: "subagents",
  query: "Makers · Startups",
  status: "done",
  subagents: [
    { id: "a", title: "Makers", shape: "square", status: "done", line: "Toyota aims for 2027" },
    { id: "b", title: "Startups", shape: "circle", status: "done", line: "QuantumScape B-samples" },
  ],
};
const own = (id: string, agentId: string, extra: Partial<ToolCall>): ToolCall => ({
  id,
  name: "Tavily",
  query: `${agentId} query`,
  status: "done",
  parentId: "g1",
  agentId,
  ...extra,
});

describe("buildResearchGraph — subagents", () => {
  it("hangs each subagent off the chat, and its own searches and reads off it", () => {
    const graph = buildResearchGraph([chat], {
      c1: [
        ask,
        turn([
          { id: "v", name: "Vault", action: "vault", op: "search", query: "ssb", status: "done", sources: [] },
          group,
          own("a1", "a", { sources: [src("https://toyota.com/a"), src("https://samsung.com/b")] }),
          own("a2", "a", { query: "toyota timeline", sources: [src("https://toyota.com/c")] }),
          own("b1", "b", { sources: [src("https://quantumscape.com/q")] }),
          own("b2", "b", { action: "read", query: "quantumscape.com", sources: [src("https://quantumscape.com/q"), src("https://qs.com/r")] }),
          // the chat Claude's own gap-filling search continues its own trail, not a subagent's
          { id: "own", name: "Tavily", query: "ssb 2026 overview", status: "done", sources: [src("https://iea.org/x")] },
        ]),
      ],
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const subA = subagentNodeId("c1", "m1", "a");
    const subB = subagentNodeId("c1", "m1", "b");
    expect(byId.get(subA)).toEqual({ id: subA, kind: "subagent", label: "Makers" });
    expect(byId.get(subB)).toMatchObject({ kind: "subagent", label: "Startups" });
    // the group is not a search of its own
    expect(graph.nodes.some((n) => n.id.includes(":g1"))).toBe(false);

    const has = (kind: string, a: string, b: string) =>
      graph.links.some((l) => l.kind === kind && ((l.source === a && l.target === b) || (l.source === b && l.target === a)));
    const search = (callId: string) => `search:c1:m1:${callId}`;
    expect(has("asked", chatNodeId("c1"), subA)).toBe(true);
    expect(has("asked", chatNodeId("c1"), subB)).toBe(true);
    expect(has("asked", subA, search("a1"))).toBe(true);
    expect(has("built-on", search("a1"), search("a2"))).toBe(true);
    expect(has("found", search("a2"), pageNodeId("https://toyota.com/c"))).toBe(true);
    expect(has("asked", subB, search("b1"))).toBe(true);
    // the read follows that subagent's latest search
    expect(has("read", search("b1"), pageNodeId("https://qs.com/r"))).toBe(true);
    // and the chat's own trail is untouched by the subagents'
    expect(has("built-on", search("v"), search("own"))).toBe(true);
    expect(has("built-on", search("a2"), search("own"))).toBe(false);
  });

  it("still places a subagent's call whose group is missing", () => {
    const graph = buildResearchGraph([chat], { c1: [ask, turn([own("x1", "z", { sources: [src("https://a.com")] })])] });
    expect(graph.nodes.find((n) => n.kind === "subagent")).toMatchObject({ label: "Subagent" });
  });

  it("is a graph the graph chat accepts", () => {
    const graph = buildResearchGraph([chat], { c1: [ask, turn([group, own("a1", "a", { sources: [src("https://a.com")] })])] });
    const parsed = parseRequest({ question: "which subagent found a.com?", graph: graphChatPayload(graph) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.graph.nodes.filter((n) => n.kind === "subagent")).toHaveLength(2);
  });
});
