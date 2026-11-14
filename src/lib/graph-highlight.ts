import type { ResearchGraph, ResearchLinkKind, ResearchNodeKind } from "@/lib/research-graph";

/**
 * graph-highlight — what the Force graph's chatbox can do to the graph, and the
 * pure rules behind it.
 *
 * `GraphControls` is the one hook `ForceGraph3D` exposes (through its
 * `controls` ref): fly to a node, dim everything but a set of nodes, and hand
 * back the exact data the graph is drawing — so the ids the model sees are the
 * ids the graph holds.
 *
 * Dimming: with a highlight set, a node outside it fades to a pale grey, and
 * a link fades unless BOTH its ends are in the set. Highlighted nodes and
 * links keep their own colours (a conflict stays solid red). No highlight
 * (null) means nothing is dimmed.
 */

export type GraphControls = {
  /** fly the camera to a node, as a click would; false if there is no such node */
  focusNode: (id: string) => boolean;
  /** dim every node not in `ids`; null restores the graph */
  setHighlight: (ids: readonly string[] | null) => void;
  /** the graph as drawn right now */
  getGraph: () => ResearchGraph;
  /** the node the camera last flew to (a click or the chatbox), if it is still drawn */
  getFocus?: () => string | null;
};

export type Highlight = ReadonlySet<string> | null;

/** a dimmed node: a pale grey, mostly see-through */
export const DIM_NODE_COLOR = "rgba(200, 202, 205, 0.12)";
/** a dimmed link */
export const DIM_LINK_COLOR = "rgba(214, 215, 217, 0.12)";

/** a link end: an id before the library resolves it, the node object after */
type End = string | { id?: unknown } | null | undefined;
const endId = (end: End): string | undefined =>
  typeof end === "string" ? end : typeof end?.id === "string" ? end.id : undefined;

export const isNodeDimmed = (highlight: Highlight, id: string) => highlight !== null && !highlight.has(id);

export function isLinkDimmed(highlight: Highlight, link: { source: End; target: End }): boolean {
  if (highlight === null) return false;
  const source = endId(link.source);
  const target = endId(link.target);
  return !(source !== undefined && target !== undefined && highlight.has(source) && highlight.has(target));
}

export const nodeColorFor = (highlight: Highlight, id: string, color: string) =>
  isNodeDimmed(highlight, id) ? DIM_NODE_COLOR : color;

export const linkColorFor = (highlight: Highlight, link: { source: End; target: End }, color: string) =>
  isLinkDimmed(highlight, link) ? DIM_LINK_COLOR : color;

/** which node and link ids a highlight dims — the whole rule in one call */
export function dimmedParts(graph: ResearchGraph, ids: readonly string[] | null) {
  const highlight = ids ? new Set(ids) : null;
  return {
    nodes: graph.nodes.filter((n) => isNodeDimmed(highlight, n.id)).map((n) => n.id),
    links: graph.links.filter((l) => isLinkDimmed(highlight, l)).map((l) => l.id),
  };
}

/* ------------------------------------------------ what the model is sent */

export type GraphChatNode = { id: string; kind: ResearchNodeKind; label: string; degree: number };
export type GraphChatLink = { source: string; target: string; kind: ResearchLinkKind };
export type GraphChatGraph = { nodes: GraphChatNode[]; links: GraphChatLink[] };
/** a Telem search the chatbox ran ("find more like this"): what it found, and the node they hang off */
export type GraphChatFound = {
  query: string;
  from: string | null;
  sources: { title: string; url: string; excerpt?: string; provider?: string }[];
};
export type GraphChatAnswer = { reply: string; focus: string | null; highlight: string[]; found?: GraphChatFound };

/** the drawn graph as the chat API takes it: every node with its degree */
export function graphChatPayload(graph: ResearchGraph): GraphChatGraph {
  const degree = new Map<string, number>();
  const links: GraphChatLink[] = [];
  for (const link of graph.links) {
    const source = endId(link.source as End);
    const target = endId(link.target as End);
    if (source === undefined || target === undefined) continue;
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
    links.push({ source, target, kind: link.kind });
  }
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, degree: degree.get(n.id) ?? 0 })),
    links,
  };
}
