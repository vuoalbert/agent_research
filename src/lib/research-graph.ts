import { sourceKey, type Chat, type Message, type ToolCall } from "@/lib/agent-store";

/**
 * research-graph — the Force graph's data, built from the chat store.
 *
 * Pure: chats and their messages in, `{ nodes, links }` out, with stable ids so
 * a rebuild after a new tool event keeps every node the graph already laid out.
 *
 * Nodes
 *   chat    a conversation (its title)
 *   search  one search call (its query)
 *   page    one source page, ONE node per `sourceKey` across every chat, so two
 *           chats that turned up the same page meet at it
 *
 * Links
 *   asked     chat → the first search of each assistant turn
 *   built-on  search → the next search in the same turn
 *   found     search → each page it found
 *   read      the search a read followed (or the chat, if it came first) →
 *             each page the read opened
 *   cross-ref page ↔ page, for every pair of pages one read opened together
 *
 * At most one link per pair of nodes: the first reason wins (a page that a
 * search found and the next read opened stays a `found` link).
 */

export type ResearchNodeKind = "chat" | "search" | "page";
export type ResearchLinkKind = "asked" | "built-on" | "found" | "read" | "cross-ref";

export type ResearchNode = {
  id: string;
  kind: ResearchNodeKind;
  /** the hover label: chat title, search query, page title */
  label: string;
  /** pages only */
  url?: string;
  host?: string;
};

export type ResearchLink = {
  id: string;
  kind: ResearchLinkKind;
  source: string;
  target: string;
};

export type ResearchGraph = { nodes: ResearchNode[]; links: ResearchLink[] };

type ChatInput = Pick<Chat, "id" | "title" | "archived">;

export const chatNodeId = (chatId: string) => `chat:${chatId}`;
export const pageNodeId = (url: string) => `page:${sourceKey(url)}`;
const searchNodeId = (chatId: string, messageId: string, callId: string) =>
  `search:${chatId}:${messageId}:${callId}`;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** a usable http(s) source, or null — tool results are outside data */
function validUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function buildResearchGraph(
  chats: readonly ChatInput[],
  messages: Readonly<Record<string, readonly Message[] | undefined>>,
): ResearchGraph {
  const nodes = new Map<string, ResearchNode>();
  const links = new Map<string, ResearchLink>();
  /** unordered pairs already linked */
  const pairs = new Set<string>();

  const link = (kind: ResearchLinkKind, source: string, target: string) => {
    if (source === target) return;
    const pair = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (pairs.has(pair)) return;
    pairs.add(pair);
    links.set(`${kind}:${pair}`, { id: `${kind}:${pair}`, kind, source, target });
  };

  /** the page node for a source, created on first sight; null for junk */
  const page = (source: { title?: unknown; url?: unknown } | null | undefined) => {
    const url = validUrl(source?.url);
    if (!url) return null;
    const id = pageNodeId(url);
    const title = typeof source?.title === "string" ? source.title.trim() : "";
    const existing = nodes.get(id);
    if (existing) {
      /* a read often has no title where the search had one */
      if (existing.label === existing.url && title) existing.label = title;
      return id;
    }
    nodes.set(id, { id, kind: "page", label: title || url, url, host: hostOf(url) });
    return id;
  };

  for (const chat of chats) {
    if (chat.archived) continue;
    const chatId = chatNodeId(chat.id);
    /* added lazily, so a chat with no research stays out of the graph */
    const ensureChat = () => {
      if (!nodes.has(chatId)) nodes.set(chatId, { id: chatId, kind: "chat", label: chat.title });
      return chatId;
    };

    for (const message of messages[chat.id] ?? []) {
      if (message?.role !== "assistant" || !Array.isArray(message.tools)) continue;
      /** the turn's latest search: the next search builds on it, a read follows it */
      let previous: string | null = null;

      for (const call of message.tools as ToolCall[]) {
        if (!call || typeof call !== "object") continue;
        const sources = Array.isArray(call.sources) ? call.sources : [];

        if (call.action === "read") {
          const read = sources.map(page).filter((id): id is string => id !== null);
          if (read.length === 0) continue;
          const from = previous ?? ensureChat();
          for (const id of read) link("read", from, id);
          for (let i = 0; i < read.length; i++)
            for (let j = i + 1; j < read.length; j++) link("cross-ref", read[i], read[j]);
          continue;
        }

        /* a search that failed and found nothing is noise */
        if (call.status === "error" && sources.length === 0) continue;
        const id = searchNodeId(chat.id, message.id, call.id);
        const from = previous ?? ensureChat();
        nodes.set(id, { id, kind: "search", label: String(call.query ?? "").trim() || "Search" });
        link(previous ? "built-on" : "asked", from, id);
        previous = id;
        for (const source of sources) {
          const found = page(source);
          if (found) link("found", id, found);
        }
      }
    }
  }

  return { nodes: [...nodes.values()], links: [...links.values()] };
}

/** ids and link keys in order — equal signatures mean the layout can stay as is */
export function graphSignature(graph: ResearchGraph): string {
  return `${graph.nodes.map((n) => n.id).join(",")}#${graph.links.map((l) => l.id).join(",")}`;
}

export function countPages(graph: ResearchGraph): number {
  return graph.nodes.reduce((sum, node) => sum + (node.kind === "page" ? 1 : 0), 0);
}
