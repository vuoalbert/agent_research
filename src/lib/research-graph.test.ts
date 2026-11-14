import { describe, expect, it } from "vitest";

import type { Chat, Message, ToolCall } from "@/lib/agent-store";
import { buildResearchGraph, chatNodeId, countPages, graphSignature, pageNodeId } from "@/lib/research-graph";

const chat = (id: string, title: string, extra: Partial<Chat> = {}): Chat => ({
  id,
  title,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const search = (id: string, query: string, urls: string[], status: ToolCall["status"] = "done"): ToolCall => ({
  id,
  name: "Tavily",
  query,
  status,
  sources: urls.map((url) => ({ title: `Title of ${url}`, url })),
});
const read = (id: string, urls: string[]): ToolCall => ({
  id,
  name: "Tavily",
  action: "read",
  query: "hosts",
  status: "done",
  sources: urls.map((url) => ({ title: "", url })),
});
const turn = (id: string, tools: ToolCall[]): Message => ({ id, role: "assistant", content: "", createdAt: 0, tools });
const ask = (id: string): Message => ({ id, role: "user", content: "q", createdAt: 0 });

const kinds = (graph: ReturnType<typeof buildResearchGraph>, kind: string) =>
  graph.links.filter((l) => l.kind === kind).map((l) => `${l.source} -> ${l.target}`);

describe("buildResearchGraph", () => {
  it("is empty without research, and leaves chats with no tool calls out", () => {
    const graph = buildResearchGraph([chat("a", "Hi")], { a: [ask("m1"), turn("m2", [])] });
    expect(graph).toEqual({ nodes: [], links: [] });
    expect(countPages(graph)).toBe(0);
  });

  it("chains a turn's searches and hangs each search's pages off it", () => {
    const graph = buildResearchGraph([chat("a", "Solar")], {
      a: [
        ask("u1"),
        turn("m1", [
          search("s1", "solar output 2025", ["https://a.com/1", "https://b.com/2"]),
          search("s2", "solar output by country", ["https://c.com/3"]),
          search("s3", "solar policy", []),
        ]),
        ask("u2"),
        turn("m2", [search("s4", "follow-up", ["https://d.com/4"])]),
      ],
    });
    const s = (msg: string, id: string) => `search:a:${msg}:${id}`;
    expect(graph.nodes.map((n) => n.kind)).toEqual(["chat", "search", "page", "page", "search", "page", "search", "search", "page"]);
    expect(kinds(graph, "asked")).toEqual([`chat:a -> ${s("m1", "s1")}`, `chat:a -> ${s("m2", "s4")}`]);
    expect(kinds(graph, "built-on")).toEqual([
      `${s("m1", "s1")} -> ${s("m1", "s2")}`,
      `${s("m1", "s2")} -> ${s("m1", "s3")}`,
    ]);
    expect(kinds(graph, "found")).toEqual([
      `${s("m1", "s1")} -> page:a.com/1`,
      `${s("m1", "s1")} -> page:b.com/2`,
      `${s("m1", "s2")} -> page:c.com/3`,
      `${s("m2", "s4")} -> page:d.com/4`,
    ]);
    expect(graph.nodes.find((n) => n.id === s("m1", "s2"))?.label).toBe("solar output by country");
    expect(graph.nodes.find((n) => n.id === "page:a.com/1")).toMatchObject({
      label: "Title of https://a.com/1",
      url: "https://a.com/1",
      host: "a.com",
    });
  });

  it("makes one page node per sourceKey across chats, linking both chats through it", () => {
    const graph = buildResearchGraph([chat("a", "A"), chat("b", "B")], {
      a: [turn("m1", [search("s1", "q1", ["https://www.example.com/page/"])])],
      b: [turn("m2", [search("s2", "q2", ["http://example.com/page", "https://other.org/x"])])],
    });
    const shared = graph.nodes.filter((n) => n.kind === "page" && n.id === pageNodeId("https://example.com/page"));
    expect(shared).toHaveLength(1);
    expect(countPages(graph)).toBe(2);
    const into = graph.links.filter((l) => l.target === shared[0].id).map((l) => l.source);
    expect(into).toEqual(["search:a:m1:s1", "search:b:m2:s2"]);
    expect(graph.links).toContainEqual(expect.objectContaining({ kind: "asked", source: chatNodeId("a"), target: "search:a:m1:s1" }));
    expect(graph.links).toContainEqual(expect.objectContaining({ kind: "asked", source: chatNodeId("b"), target: "search:b:m2:s2" }));
  });

  it("cross-references every pair a read opened, and links them to the search before it", () => {
    const graph = buildResearchGraph([chat("a", "A")], {
      a: [
        turn("m1", [
          search("s1", "q", ["https://a.com/1"]),
          read("r1", ["https://a.com/1", "https://b.com/2", "https://c.com/3"]),
        ]),
      ],
    });
    expect(kinds(graph, "cross-ref")).toEqual([
      "page:a.com/1 -> page:b.com/2",
      "page:a.com/1 -> page:c.com/3",
      "page:b.com/2 -> page:c.com/3",
    ]);
    // a.com/1 was already linked as `found`; the read adds the other two
    expect(kinds(graph, "found")).toEqual(["search:a:m1:s1 -> page:a.com/1"]);
    expect(kinds(graph, "read")).toEqual(["search:a:m1:s1 -> page:b.com/2", "search:a:m1:s1 -> page:c.com/3"]);
    // the read's empty title did not replace the search's
    expect(graph.nodes.find((n) => n.id === "page:a.com/1")?.label).toBe("Title of https://a.com/1");
    expect(graph.nodes.find((n) => n.id === "page:b.com/2")?.label).toBe("https://b.com/2");
  });

  it("links a read with no search before it to the chat", () => {
    const graph = buildResearchGraph([chat("a", "A")], { a: [turn("m1", [read("r1", ["https://a.com/1"])])] });
    expect(graph.links).toEqual([expect.objectContaining({ kind: "read", source: "chat:a", target: "page:a.com/1" })]);
  });

  it("skips archived chats, failed empty searches and junk sources", () => {
    const graph = buildResearchGraph([chat("a", "A"), chat("z", "Old", { archived: true })], {
      a: [
        turn("m1", [
          search("s1", "q1", ["https://a.com/1"]),
          search("s2", "q2", [], "error"),
          { ...search("s3", "q3", []), sources: [{ title: "x", url: "javascript:alert(1)" }, { title: "y", url: "not a url" }] },
        ]),
      ],
      z: [turn("m9", [search("s9", "old", ["https://old.com"])])],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["chat:a", "search:a:m1:s1", "page:a.com/1", "search:a:m1:s3"]);
    // the chain skips the failed search
    expect(kinds(graph, "built-on")).toEqual(["search:a:m1:s1 -> search:a:m1:s3"]);
  });

  it("keeps a running search and grows as its results arrive, with stable ids", () => {
    const running = buildResearchGraph([chat("a", "A")], { a: [turn("m1", [search("s1", "q", [], "running")])] });
    const done = buildResearchGraph([chat("a", "A")], { a: [turn("m1", [search("s1", "q", ["https://a.com"])])] });
    expect(running.nodes.map((n) => n.id)).toEqual(["chat:a", "search:a:m1:s1"]);
    expect(done.nodes.map((n) => n.id)).toEqual(["chat:a", "search:a:m1:s1", "page:a.com"]);
    expect(graphSignature(running)).not.toBe(graphSignature(done));
    expect(graphSignature(done)).toBe(
      graphSignature(buildResearchGraph([chat("a", "Renamed")], { a: [turn("m1", [search("s1", "q", ["https://a.com"])])] })),
    );
  });

  it("tolerates turns saved before tools and malformed tool lists", () => {
    const messages = {
      a: [
        { id: "m1", role: "assistant", content: "old", createdAt: 0 },
        { id: "m2", role: "assistant", content: "", createdAt: 0, tools: "nope" },
        { id: "m3", role: "assistant", content: "", createdAt: 0, tools: [null, { id: "s1", query: "q", status: "done", sources: null }] },
      ],
    } as unknown as Record<string, Message[]>;
    const graph = buildResearchGraph([chat("a", "A")], messages);
    expect(graph.nodes.map((n) => n.id)).toEqual(["chat:a", "search:a:m3:s1"]);
  });
});
