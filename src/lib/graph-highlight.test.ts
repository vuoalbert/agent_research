import { describe, expect, it } from "vitest";

import {
  DIM_LINK_COLOR,
  DIM_NODE_COLOR,
  dimmedParts,
  graphChatPayload,
  isLinkDimmed,
  linkColorFor,
  nodeColorFor,
} from "@/lib/graph-highlight";
import type { ResearchGraph } from "@/lib/research-graph";

const graph: ResearchGraph = {
  nodes: [
    { id: "chat:a", kind: "chat", label: "Chat A" },
    { id: "search:a", kind: "search", label: "q" },
    { id: "page:x", kind: "page", label: "X", url: "https://x.org/", host: "x.org" },
    { id: "page:y", kind: "page", label: "Y", url: "https://y.org/", host: "y.org" },
    { id: "page:z", kind: "page", label: "Z", url: "https://z.org/", host: "z.org" },
  ],
  links: [
    { id: "asked:a", kind: "asked", source: "chat:a", target: "search:a" },
    { id: "found:x", kind: "found", source: "search:a", target: "page:x" },
    { id: "found:y", kind: "found", source: "search:a", target: "page:y" },
    { id: "conflicts:xy", kind: "conflicts", source: "page:x", target: "page:y" },
    { id: "agrees:yz", kind: "agrees", source: "page:y", target: "page:z" },
  ],
};

describe("graph highlight", () => {
  it("dims nothing without a highlight", () => {
    expect(dimmedParts(graph, null)).toEqual({ nodes: [], links: [] });
    expect(nodeColorFor(null, "page:x", "#A3A6AB")).toBe("#A3A6AB");
  });

  it("dims nodes outside the set, and links unless both ends are in it", () => {
    const dimmed = dimmedParts(graph, ["page:x", "page:y"]);
    expect(dimmed.nodes).toEqual(["chat:a", "search:a", "page:z"]);
    // only the conflict between x and y stays bright
    expect(dimmed.links).toEqual(["asked:a", "found:x", "found:y", "agrees:yz"]);
  });

  it("keeps a highlighted link's own colour — a conflict stays red", () => {
    const set = new Set(["page:x", "page:y"]);
    expect(linkColorFor(set, graph.links[3], "#DC2626")).toBe("#DC2626");
    expect(linkColorFor(set, graph.links[4], "#A3A6AB")).toBe(DIM_LINK_COLOR);
    expect(nodeColorFor(set, "page:z", "#A3A6AB")).toBe(DIM_NODE_COLOR);
    expect(nodeColorFor(set, "page:x", "#A3A6AB")).toBe("#A3A6AB");
  });

  it("reads link ends the library has resolved to node objects", () => {
    const set = new Set(["page:x", "page:y"]);
    expect(isLinkDimmed(set, { source: { id: "page:x" }, target: { id: "page:y" } })).toBe(false);
    expect(isLinkDimmed(set, { source: { id: "page:x" }, target: { id: "page:z" } })).toBe(true);
  });

  it("sends every node with its degree, and links by id", () => {
    const payload = graphChatPayload(graph);
    expect(payload.nodes.map((n) => [n.id, n.degree])).toEqual([
      ["chat:a", 1],
      ["search:a", 3],
      ["page:x", 2],
      ["page:y", 3],
      ["page:z", 1],
    ]);
    expect(payload.links[3]).toEqual({ source: "page:x", target: "page:y", kind: "conflicts" });
  });
});
