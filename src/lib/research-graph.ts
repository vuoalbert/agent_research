import { selectChatCrossref, sourceKey, type Chat, type Claim, type Message, type ToolCall } from "@/lib/agent-store";
import { crossrefLinks } from "@/lib/crossref-links";

/**
 * research-graph — the Force graph's data, built from the chat store.
 *
 * Pure: chats and their messages in, `{ nodes, links }` out, with stable ids so
 * a rebuild after a new tool event keeps every node the graph already laid out.
 *
 * Nodes
 *   chat     a conversation (its title)
 *   subagent one research subagent a deploy_subagents call sent out (its
 *            title); its own searches and reads hang off it, not the chat
 *   search   one search call (its query)
 *   page    one source page, ONE node per `sourceKey` across every chat, so two
 *           chats that turned up the same page meet at it
 *
 * Links
 *   asked     chat → the first search of each assistant turn; chat → each
 *             subagent; subagent → its first search
 *   built-on  search → the next search in the same turn (or by the same subagent)
 *   found     search → each page it found
 *   read      the search a read followed (or the chat, if it came first) →
 *             each page the read opened
 *   cross-ref page ↔ page, for every pair of pages one read opened together
 *   agrees    page ↔ page, both support a claim a cross_reference found (every
 *             live chat's cross-references merged); wider per shared claim
 *   conflicts page ↔ page, one supports a claim the other contradicts
 *
 * At most one link per pair of nodes: the first reason wins (a page that a
 * search found and the next read opened stays a `found` link) — except that
 * agrees / conflicts replace a `cross-ref` pair, and a pair that both agrees
 * and conflicts is drawn as one `conflicts` link carrying every claim.
 */

export type ResearchNodeKind = "chat" | "subagent" | "search" | "page";
export type ResearchLinkKind = "asked" | "built-on" | "found" | "read" | "cross-ref" | "agrees" | "conflicts";

export type ResearchNode = {
  id: string;
  kind: ResearchNodeKind;
  /** the hover label: chat title, subagent title, search query, page title */
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
  /** agrees / conflicts: the claims behind the link */
  claims?: Claim[];
  /** agrees / conflicts: the hover label, each claim with ✓ / ✗ hosts (HTML) */
  label?: string;
  /** agrees: a width that grows with the shared claims */
  width?: number;
};

export type ResearchGraph = { nodes: ResearchNode[]; links: ResearchLink[] };

type ChatInput = Pick<Chat, "id" | "title" | "archived">;

export const chatNodeId = (chatId: string) => `chat:${chatId}`;
export const pageNodeId = (url: string) => `page:${sourceKey(url)}`;
const searchNodeId = (chatId: string, messageId: string, callId: string) =>
  `search:${chatId}:${messageId}:${callId}`;
export const subagentNodeId = (chatId: string, messageId: string, agentId: string) =>
  `subagent:${chatId}:${messageId}:${agentId}`;

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
      const calls = (message.tools as ToolCall[]).filter((call) => call && typeof call === "object");
      /** the turn's latest search: the next search builds on it, a read follows it */
      let previous: string | null = null;
      /** the same, per subagent (by agentId) — a subagent's trail is its own */
      const agentPrevious = new Map<string, string>();
      /** every subagent the turn's groups name, by agentId */
      const titles = new Map<string, string>();
      for (const call of calls) {
        if (call.action !== "subagents" || !Array.isArray(call.subagents)) continue;
        for (const sub of call.subagents) {
          if (sub && typeof sub.id === "string") titles.set(sub.id, String(sub.title ?? "").trim() || "Subagent");
        }
      }
      const ensureSubagent = (agentId: string) => {
        const id = subagentNodeId(chat.id, message.id, agentId);
        if (!nodes.has(id)) {
          nodes.set(id, { id, kind: "subagent", label: titles.get(agentId) ?? "Subagent" });
          link("asked", ensureChat(), id);
        }
        return id;
      };

      for (const call of calls) {
        const sources = Array.isArray(call.sources) ? call.sources : [];
        /* a group is its subagents, not a search of its own */
        if (call.action === "subagents") {
          for (const sub of Array.isArray(call.subagents) ? call.subagents : []) {
            if (sub && typeof sub.id === "string") ensureSubagent(sub.id);
          }
          continue;
        }
        const agentId = typeof call.agentId === "string" ? call.agentId : null;
        const last = agentId ? (agentPrevious.get(agentId) ?? null) : previous;
        const root = () => (agentId ? ensureSubagent(agentId) : ensureChat());

        if (call.action === "read") {
          const read = sources.map(page).filter((id): id is string => id !== null);
          if (read.length === 0) continue;
          const from = last ?? root();
          for (const id of read) link("read", from, id);
          for (let i = 0; i < read.length; i++)
            for (let j = i + 1; j < read.length; j++) link("cross-ref", read[i], read[j]);
          continue;
        }

        /* a search that failed and found nothing is noise */
        if (call.status === "error" && sources.length === 0) continue;
        const id = searchNodeId(chat.id, message.id, call.id);
        const from = last ?? root();
        nodes.set(id, { id, kind: "search", label: String(call.query ?? "").trim() || "Search" });
        link(last ? "built-on" : "asked", from, id);
        if (agentId) agentPrevious.set(agentId, id);
        else previous = id;
        for (const source of sources) {
          const found = page(source);
          if (found) link("found", id, found);
        }
      }
    }
  }

  /* ---------------------------------------- cross-reference relations */
  const live = chats.filter((chat) => !chat.archived).flatMap((chat) => messages[chat.id] ?? []);
  const byPair = new Map<string, ResearchLink>();
  for (const relation of crossrefLinks(selectChatCrossref(live), { nodeId: pageNodeId, hasNode: (id) => nodes.has(id) })) {
    const { source, target } = relation;
    const pair = source < target ? `${source}|${target}` : `${target}|${source}`;
    const existing = byPair.get(pair);
    if (existing) {
      // agree on one claim, conflict on another: one conflicts link with both
      const claims = [...existing.claims!, ...relation.claims.filter((c) => !existing.claims!.includes(c))];
      const conflicts = existing.kind === "conflicts" ? existing : relation;
      byPair.set(pair, {
        id: `conflicts:${pair}`,
        kind: "conflicts",
        source: conflicts.source,
        target: conflicts.target,
        claims,
        label: [existing.label, relation.label].join("<br><br>"),
      });
      continue;
    }
    if (pairs.has(pair) && !links.has(`cross-ref:${pair}`)) continue;
    byPair.set(pair, {
      id: `${relation.kind}:${pair}`,
      kind: relation.kind,
      source,
      target,
      claims: relation.claims,
      label: relation.label,
      ...(relation.kind === "agrees" ? { width: relation.width } : {}),
    });
  }
  for (const [pair, crossLink] of byPair) {
    links.delete(`cross-ref:${pair}`);
    pairs.add(pair);
    links.set(crossLink.id, crossLink);
  }

  return { nodes: [...nodes.values()], links: [...links.values()] };
}

/** ids and link keys in order — equal signatures mean the layout can stay as is */
export function graphSignature(graph: ResearchGraph): string {
  // a link's claim count is part of it: a new shared claim re-styles the link
  return `${graph.nodes.map((n) => n.id).join(",")}#${graph.links
    .map((l) => (l.claims ? `${l.id}/${l.claims.length}` : l.id))
    .join(",")}`;
}

export function countPages(graph: ResearchGraph): number {
  return graph.nodes.reduce((sum, node) => sum + (node.kind === "page" ? 1 : 0), 0);
}
