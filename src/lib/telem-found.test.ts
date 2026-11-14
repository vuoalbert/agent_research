import { beforeEach, describe, expect, it } from "vitest";

import { chatForNode } from "@/components/graph-chat";
import {
  STORAGE_KEY,
  __resetAgentStore,
  addFoundSources,
  getAgentState,
  selectChatSources,
  selectSourceOrigins,
  sourceKey,
  type Chat,
  type Message,
  type ToolCall,
} from "@/lib/agent-store";
import { buildResearchGraph, pageNodeId } from "@/lib/research-graph";

/**
 * Sources a Telem search found outside the chat — the Force graph's "find
 * more like this", the Knowledge base's Find more: kept as one done call on
 * the chat's latest turn, listed with an origin, drawn off the node they were
 * asked from.
 */

const search = (id: string, urls: string[]): ToolCall => ({
  id,
  name: "Tavily",
  query: "solar",
  status: "done",
  sources: urls.map((url) => ({ title: `T ${url}`, url })),
});

function seed(messages: Record<string, Message[]>, chats: Chat[] = [{ id: "c1", title: "Solar", createdAt: 1, updatedAt: 1 }]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chats, messages, activeChatId: chats[0].id }));
}

beforeEach(() => __resetAgentStore());

describe("addFoundSources", () => {
  it("adds only new sources, as a Telem call on the latest assistant turn", () => {
    seed({
      c1: [
        { id: "u1", role: "user", content: "solar?", createdAt: 1 },
        { id: "a1", role: "assistant", content: "Yes.", createdAt: 2, tools: [search("t1", ["https://a.org/x"])] },
      ],
    });
    const write = addFoundSources("c1", {
      query: "solar more",
      origin: "graph",
      from: pageNodeId("https://a.org/x"),
      sources: [
        { title: "A again", url: "https://www.a.org/x/" },
        { title: "B", url: "https://b.org/" },
        { title: "B twice", url: "http://b.org" },
        { title: "", url: "javascript:alert(1)" },
      ],
    });
    expect(write).toMatchObject({ added: 1, messageId: "a1" });
    const call = getAgentState().messages.c1[1].tools!.at(-1)!;
    expect(call).toMatchObject({ name: "Telem", query: "solar more", status: "done", origin: "graph", from: "page:a.org/x" });
    expect(call.sources).toEqual([{ title: "B", url: "https://b.org/" }]);
    expect(selectChatSources(getAgentState().messages.c1).map((s) => s.url)).toEqual(["https://a.org/x", "https://b.org/"]);
    expect([...selectSourceOrigins(getAgentState().messages.c1)]).toEqual([[sourceKey("https://b.org/"), "graph"]]);
    // persisted with the chat
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).messages.c1[1].tools[1].origin).toBe("graph");
    // nothing new: nothing written
    expect(addFoundSources("c1", { query: "q", origin: "kb", sources: [{ title: "B", url: "https://b.org" }] })).toBeNull();
    expect(addFoundSources("nope", { query: "q", origin: "kb", sources: [{ title: "C", url: "https://c.org" }] })).toBeNull();
  });

  it("gives a chat with no reply yet a short assistant turn of its own", () => {
    seed({ c1: [{ id: "u1", role: "user", content: "solar?", createdAt: 1 }] });
    const write = addFoundSources("c1", { query: "solar?", origin: "kb", sources: [{ title: "C", url: "https://c.org" }] });
    const turns = getAgentState().messages.c1;
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ id: write!.messageId, role: "assistant", content: "Found 1 more source with Telem from the Knowledge base." });
  });
});

describe("the graph draws what Telem found", () => {
  it("hangs a graph-made search off its node, and a Find more off the chat", () => {
    const messages: Message[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: 1,
        tools: [
          /* found first, but drawn after the research it builds on */
          { id: "g1", name: "Telem", query: "more like A", status: "done", origin: "graph", from: pageNodeId("https://a.org/x"), sources: [{ title: "B", url: "https://b.org/" }] },
          search("t1", ["https://a.org/x"]),
          search("t2", ["https://a2.org/"]),
          { id: "k1", name: "Telem", query: "solar?", status: "done", origin: "kb", sources: [{ title: "C", url: "https://c.org/" }] },
        ],
      },
    ];
    const graph = buildResearchGraph([{ id: "c1", title: "Solar" }], { c1: messages });
    const pairs = graph.links.map((l) => `${l.kind} ${l.source} -> ${l.target}`);
    expect(pairs).toEqual([
      "asked chat:c1 -> search:c1:a1:t1",
      "found search:c1:a1:t1 -> page:a.org/x",
      // the turn's own chain skips the Telem calls
      "built-on search:c1:a1:t1 -> search:c1:a1:t2",
      "found search:c1:a1:t2 -> page:a2.org",
      "built-on page:a.org/x -> search:c1:a1:g1",
      "found search:c1:a1:g1 -> page:b.org",
      "asked chat:c1 -> search:c1:a1:k1",
      "found search:c1:a1:k1 -> page:c.org",
    ]);
    expect(graph.nodes.find((n) => n.id === "search:c1:a1:g1")?.label).toBe("more like A");
  });
});

describe("chatForNode", () => {
  const chats: Chat[] = [
    { id: "c1", title: "One", createdAt: 1, updatedAt: 1 },
    { id: "c2", title: "Two", createdAt: 1, updatedAt: 1 },
    { id: "c3", title: "Gone", createdAt: 1, updatedAt: 1, archived: true },
  ];
  const messages = {
    c1: [{ id: "a", role: "assistant" as const, content: "", createdAt: 1, tools: [search("t", ["https://a.org/"])] }],
    c2: [{ id: "b", role: "assistant" as const, content: "", createdAt: 1, tools: [search("t", ["https://a.org/", "https://b.org/"])] }],
  };
  it("reads the chat from the node, preferring the active chat for a shared page", () => {
    expect(chatForNode("chat:c2", { chats, messages, activeChatId: null })).toBe("c2");
    expect(chatForNode("search:c2:b:t", { chats, messages, activeChatId: null })).toBe("c2");
    expect(chatForNode("chat:c3", { chats, messages, activeChatId: null })).toBeNull();
    expect(chatForNode("page:a.org", { chats, messages, activeChatId: "c2" })).toBe("c2");
    expect(chatForNode("page:a.org", { chats, messages, activeChatId: null })).toBe("c1");
    expect(chatForNode("page:b.org", { chats, messages, activeChatId: "c1" })).toBe("c2");
    // no node: the active chat, else the first with messages
    expect(chatForNode(null, { chats, messages, activeChatId: "c2" })).toBe("c2");
    expect(chatForNode(null, { chats, messages, activeChatId: null })).toBe("c1");
  });
});
