"use client";

import { useCallback, useSyncExternalStore } from "react";

import { mergeCrossrefs, type Crossref } from "./crossref";
import { sourceKey } from "./source-key";
import { parseSubagents, type Subagent } from "./subagents";

export { sourceKey };
export type { Subagent, SubagentShape, SubagentStatus } from "./subagents";
export type { Claim, ClaimSource, Crossref, Relation, Stance } from "./crossref";

/**
 * agent-store — the shared local store behind the AI app.
 *
 * This file is a **published contract**: the sidebar (`ai-sidebar.tsx`) and the
 * pane are built against it in parallel, so the exported shape below is frozen.
 * Everything lives in one `localStorage` key and is broadcast through
 * `useSyncExternalStore`, so every mounted consumer re-renders from the same
 * snapshot — no context provider, no props threading.
 *
 * Storage key: `agent_research.agent.v1`. Optional chat metadata is
 * migrated/defaulted while older conversations remain in place. An unreadable or malformed payload falls back to an empty state
 * rather than throwing, so a stale key can never wedge the app.
 */

export const STORAGE_KEY = "agent_research.agent.v1";

/** what lands in the assistant turn when the route cannot be reached */
export const ERROR_REPLY = "Couldn't reach Agent Research.";

/** where the streamed reply comes from */
export const CHAT_ENDPOINT = "/api/chat";

/** the placeholder title an empty chat carries until its first message */
export const NEW_CHAT_TITLE = "New chat";

/** how long `sendMessage` waits before appending the stub reply */
export const REPLY_DELAY_MS = 600;

export type Role = "user" | "assistant";

export type Chat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Optional metadata added after the v1 conversations were first saved. */
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  /** Existing sidebar project label, not a fabricated session/project id. */
  project?: string;
  /** Reserved for local groups when the app grows one. */
  group?: string;
};

export type Source = { title: string; url: string };

/** one tool call inside an assistant turn, as the route's `tool` events report it */
export type ToolCall = {
  id: string;
  name: string;
  /** "read" for a page read (tavily_extract), "crossref" for a cross_reference,
   *  "vault" for a vault search/read/write, "visualize" for a figure job, "visualize-message"
   *  for a message to the agent building one, "subagents" for a deploy_subagents group,
   *  "world" for the chat's World Labs world; absent for a search, and on chats saved
   *  before reads */
  action?: "read" | "crossref" | "vault" | "visualize" | "visualize-message" | "subagents" | "world";
  /** a vault call's kind, for its row's verb */
  op?: "search" | "read" | "write";
  /** a Visualize call's background job, which the row follows after the call itself is done */
  jobId?: string;
  /** a World Labs row's chat, whose world the row follows (see src/app/api/chat/world-turn.ts) */
  chatId?: string;
  query: string;
  status: "running" | "done" | "error";
  sources?: Source[];
  /** a cross_reference's claims and source↔source relations */
  crossref?: Crossref;
  /** a "subagents" group: each subagent's state, as the route last reported it */
  subagents?: Subagent[];
  /** a call a subagent made: the group it belongs to (drawn inside it, never on its own) … */
  parentId?: string;
  /** … and the subagent that made it */
  agentId?: string;
  /** a Telem search or read: who answered and how long it took, for the row's hover title only */
  telem?: TelemCallInfo;
};

/** what a Telem call's `done`/`error` frame says about it */
export type TelemCallInfo = { providers: string[]; latencyMs?: number };

function parseTelemInfo(value: unknown): TelemCallInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { providers, latencyMs } = value as { providers?: unknown; latencyMs?: unknown };
  if (!Array.isArray(providers)) return undefined;
  const names = providers.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 12);
  return {
    providers: names,
    ...(typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0 ? { latencyMs } : {}),
  };
}

const ACTIONS: readonly NonNullable<ToolCall["action"]>[] = [
  "read",
  "crossref",
  "vault",
  "visualize",
  "visualize-message",
  "subagents",
  "world",
];

export type Message = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** assistant turns only, in call order; absent on turns saved before tools */
  tools?: ToolCall[];
};

export type AgentState = {
  chats: Chat[];
  messages: Record<string, Message[]>;
  activeChatId: string | null;
  /** Local group names. Older v1 payloads default to an empty list. */
  groups: string[];
  /**
   * Chat ids with a reply in flight. Derived state, deliberately NOT persisted:
   * a reload cannot still be streaming, and a `true` restored from
   * localStorage would shimmer a turn forever.
   */
  streaming: string[];
};

export type AgentStore = AgentState & {
  /** start an empty chat and make it active — the pane empties */
  newChat: () => string;
  /** make an existing chat active; unknown ids are ignored */
  openChat: (id: string) => void;
  /** rename in place; an all-whitespace title is rejected */
  renameChat: (id: string, title: string) => void;
  toggleChatPinned: (id: string) => void;
  toggleChatUnread: (id: string) => void;
  setChatProject: (id: string, project: string | null) => void;
  setChatGroup: (id: string, group: string | null) => void;
  createChatGroup: (name: string, chatId?: string) => void;
  unarchiveChat: (id: string) => void;
  archiveChat: (id: string) => void;
  /** drop the chat and its messages; if it was active, activate the next one */
  deleteChat: (id: string) => void;
  /** append the user message, then the stub assistant reply after 600ms */
  sendMessage: (chatId: string, text: string) => void;
  /** first run only: fill an empty store with the reference conversations */
  seedIfEmpty: () => void;
  /** abort the reply in flight for a chat, keeping the text so far */
  stopStreaming: (chatId: string) => void;
};

/** ------------------------------------------------------------- internals */

const EMPTY: AgentState = { chats: [], messages: {}, activeChatId: null, groups: [], streaming: [] };

let state: AgentState = EMPTY;
let hydrated = false;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isBrowser() {
  return typeof window !== "undefined";
}

/** shape-check a parsed payload — a hand-edited key must not crash the app */
function parse(raw: string | null): AgentState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<AgentState>;
    if (!Array.isArray(data.chats)) return null;
    if (!data.messages || typeof data.messages !== "object") return null;
    const chats = data.chats.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const chat = value as Partial<Chat>;
      if (
        typeof chat.id !== "string" ||
        typeof chat.title !== "string" ||
        typeof chat.createdAt !== "number" ||
        typeof chat.updatedAt !== "number"
      ) {
        return [];
      }
      return [{
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        // These defaults make old v1 payloads immediately safe to consume.
        pinned: chat.pinned === true,
        unread: chat.unread === true,
        archived: chat.archived === true,
        ...(typeof chat.project === "string" ? { project: chat.project } : {}),
        ...(typeof chat.group === "string" ? { group: chat.group } : {}),
      }];
    });
    const activeChatId =
      typeof data.activeChatId === "string" && chats.some((chat) => chat.id === data.activeChatId && !chat.archived)
        ? data.activeChatId
        : null;
    return {
      chats,
      messages: data.messages,
      activeChatId,
      groups: Array.isArray((data as Partial<AgentState>).groups)
        ? (data as Partial<AgentState>).groups!.filter((group): group is string => typeof group === "string" && Boolean(group.trim()))
        : [],
      // always empty on load: whatever was in flight died with the page
      streaming: [],
    };
  } catch {
    return null;
  }
}

function persist() {
  if (!isBrowser()) return;
  try {
    const { streaming: _inFlight, ...persisted } = state;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // quota or a privacy mode that refuses writes — the in-memory store stands
  }
}

function hydrate() {
  if (hydrated || !isBrowser()) return;
  hydrated = true;
  const stored = parse(window.localStorage.getItem(STORAGE_KEY));
  if (stored) state = stored;
}

function setState(next: AgentState) {
  state = next;
  persist();
  emit();
}

function getSnapshot(): AgentState {
  hydrate();
  return state;
}

/** the server renders the empty store; hydration fills it in on the client */
function getServerSnapshot(): AgentState {
  return EMPTY;
}

let counter = 0;
function makeId(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** ---------------------------------------------------------------- actions */

function newChat(): string {
  const now = Date.now();
  const chat: Chat = { id: makeId("chat"), title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now };
  setState({
    streaming: getSnapshot().streaming,
    groups: getSnapshot().groups,
    chats: [chat, ...getSnapshot().chats],
    messages: { ...getSnapshot().messages, [chat.id]: [] },
    activeChatId: chat.id,
  });
  return chat.id;
}

function openChat(id: string) {
  const current = getSnapshot();
  if (!current.chats.some((chat) => chat.id === id)) return;
  const wasUnread = current.chats.some((chat) => chat.id === id && chat.unread);
  if (current.activeChatId === id && !wasUnread) return;
  const chats = wasUnread
    ? current.chats.map((chat) => (chat.id === id ? { ...chat, unread: false } : chat))
    : current.chats;
  setState({ ...current, chats, activeChatId: id });
}

function renameChat(id: string, title: string) {
  const trimmed = title.trim();
  if (!trimmed) return;
  const current = getSnapshot();
  if (!current.chats.some((chat) => chat.id === id)) return;
  setState({
    ...current,
    chats: current.chats.map((chat) =>
      chat.id === id ? { ...chat, title: trimmed, updatedAt: Date.now() } : chat,
    ),
  });
}

function toggleChatPinned(id: string) {
  const current = getSnapshot();
  if (!current.chats.some((chat) => chat.id === id)) return;
  setState({
    ...current,
    chats: current.chats.map((chat) =>
      chat.id === id ? { ...chat, pinned: chat.pinned !== true } : chat,
    ),
  });
}

function toggleChatUnread(id: string) {
  const current = getSnapshot();
  if (!current.chats.some((chat) => chat.id === id)) return;
  setState({
    ...current,
    chats: current.chats.map((chat) =>
      chat.id === id ? { ...chat, unread: chat.unread !== true } : chat,
    ),
  });
}

function setChatProject(id: string, project: string | null) {
  const current = getSnapshot();
  if (!current.chats.some((chat) => chat.id === id)) return;
  setState({
    ...current,
    chats: current.chats.map((chat) => {
      if (chat.id !== id) return chat;
      const next = { ...chat };
      if (project) next.project = project;
      else delete next.project;
      return next;
    }),
  });
}

function setChatGroup(id: string, group: string | null) {
  const current = getSnapshot();
  if (!current.chats.some((chat) => chat.id === id)) return;
  setState({
    ...current,
    chats: current.chats.map((chat) => {
      if (chat.id !== id) return chat;
      const next = { ...chat };
      if (group) next.group = group;
      else delete next.group;
      return next;
    }),
  });
}

function createChatGroup(name: string, chatId?: string) {
  const trimmed = name.trim();
  const current = getSnapshot();
  if (!trimmed) return;
  if (current.groups.includes(trimmed) && !chatId) return;
  setState({
    ...current,
    groups: current.groups.includes(trimmed) ? current.groups : [...current.groups, trimmed],
    chats: chatId
      ? current.chats.map((chat) => (chat.id === chatId ? { ...chat, group: trimmed } : chat))
      : current.chats,
  });
}

function archiveChat(id: string) {
  const current = getSnapshot();
  const index = current.chats.findIndex((chat) => chat.id === id);
  if (index === -1) return;
  const chats = current.chats.map((chat) =>
    chat.id === id ? { ...chat, archived: true, unread: false } : chat,
  );
  const next = chats.slice(index + 1).find((chat) => !chat.archived && chat.id !== id);
  const previous = [...chats.slice(0, index)].reverse().find((chat) => !chat.archived);
  const activeChatId =
    current.activeChatId === id
      ? (next ?? previous ?? null)?.id ?? null
      : current.activeChatId;
  setState({ ...current, chats, activeChatId });
}

function unarchiveChat(id: string) {
  const current = getSnapshot();
  if (!current.chats.some((chat) => chat.id === id && chat.archived)) return;
  setState({
    ...current,
    chats: current.chats.map((chat) =>
      chat.id === id ? { ...chat, archived: false } : chat,
    ),
  });
}

function deleteChat(id: string) {
  const current = getSnapshot();
  const index = current.chats.findIndex((chat) => chat.id === id);
  if (index === -1) return;
  const chats = current.chats.filter((chat) => chat.id !== id);
  const messages = { ...current.messages };
  delete messages[id];
  // deleting the open chat falls through to the next visible neighbour.
  const next = chats.slice(index).find((chat) => !chat.archived);
  const previous = [...chats.slice(0, index)].reverse().find((chat) => !chat.archived);
  const activeChatId =
    current.activeChatId === id ? (next ?? previous ?? null)?.id ?? null : current.activeChatId;
  // stop the reply this chat was waiting on — the subprocess should not keep
  // generating into a conversation that no longer exists
  inFlight.get(id)?.abort();
  setState({ ...current, chats, messages, activeChatId, streaming: current.streaming.filter((chatId) => chatId !== id) });
}

function append(chatId: string, message: Message) {
  const current = getSnapshot();
  const touched = current.chats.findIndex((chat) => chat.id === chatId);
  if (touched === -1) return;
  setState({
    ...current,
    // Newest activity first — the order newChat's prepend already implies, and
    // the one the sidebar list and the home cards read in. Moved explicitly
    // rather than sorted on updatedAt: two chats touched inside the same
    // millisecond tie, and a stable sort then leaves them in the old order.
    chats: [
      { ...current.chats[touched], updatedAt: message.createdAt },
      ...current.chats.filter((chat) => chat.id !== chatId),
    ],
    messages: { ...current.messages, [chatId]: [...(current.messages[chatId] ?? []), message] },
  });
}

function sendMessage(chatId: string, text: string) {
  const content = text.trim();
  if (!content) return;
  const now = Date.now();

  // A chat takes its title from its first message, so the sidebar row and the
  // pane's header strip say something. Two paths reach here: `newChat()` has
  // already made an empty chat called "New chat" (the sidebar's flow), or the
  // id is not a chat yet and this send creates it. Either way the first send
  // names it. A chat the user renamed by hand is never overwritten.
  const known = state.chats.find((chat) => chat.id === chatId);
  const empty = (state.messages[chatId] ?? []).length === 0;
  if (!known) {
    setState({
      ...state,
      chats: [
        { id: chatId, title: titleFromText(content), createdAt: now, updatedAt: now },
        ...state.chats,
      ],
      activeChatId: chatId,
    });
  } else if (empty && known.title === NEW_CHAT_TITLE) {
    renameChat(chatId, titleFromText(content));
  }

  append(chatId, { id: makeId("msg"), role: "user", content, createdAt: now });

  // The assistant turn is appended immediately and empty. The pane shimmers it
  // until the first delta lands, which is why it exists before there is
  // anything to put in it.
  const replyId = makeId("msg");
  append(chatId, { id: replyId, role: "assistant", content: "", createdAt: Date.now() });
  void streamReply(chatId, replyId);
}

/** ------------------------------------------------------------- streaming */

/** in-flight requests, so `stopStreaming` can abort the right one */
const inFlight = new Map<string, AbortController>();

function setStreaming(chatId: string, on: boolean) {
  const current = getSnapshot();
  const streaming = on
    ? current.streaming.includes(chatId)
      ? current.streaming
      : [...current.streaming, chatId]
    : current.streaming.filter((id) => id !== chatId);
  if (streaming !== current.streaming) setState({ ...current, streaming });
}

/** overwrite a turn's text in place, without moving the chat or its timestamps */
function setMessageContent(chatId: string, messageId: string, content: string) {
  const current = getSnapshot();
  const turns = current.messages[chatId];
  if (!turns) return false;
  setState({
    ...current,
    messages: {
      ...current.messages,
      [chatId]: turns.map((turn) => (turn.id === messageId ? { ...turn, content } : turn)),
    },
  });
  return true;
}

/** the route's `tool` frame: a call starting, or one it started ending */
type ToolEvent =
  | {
      id: string;
      name: string;
      action?: ToolCall["action"];
      op?: ToolCall["op"];
      jobId?: string;
      chatId?: string;
      query: string;
      status: "running";
      subagents?: unknown;
      parentId?: string;
      agentId?: string;
    }
  | { id: string; status: "done"; sources?: Source[]; crossref?: Crossref; subagents?: unknown; telem?: unknown }
  | { id: string; status: "error"; telem?: unknown };

/**
 * Fold one `tool` frame into a turn's calls: a start appends, an end updates in
 * place. A "subagents" group is re-sent `running` as its subagents move on;
 * those frames update its `subagents` in place.
 */
export function applyToolEvent(tools: readonly ToolCall[] | undefined, event: ToolEvent): ToolCall[] {
  const list = tools ?? [];
  const subagents = "subagents" in event ? parseSubagents(event.subagents) : undefined;
  if (event.status === "running") {
    if (list.some((call) => call.id === event.id)) {
      if (!subagents) return [...list];
      return list.map((call) => (call.id === event.id ? { ...call, subagents } : call));
    }
    return [
      ...list,
      {
        id: event.id,
        name: event.name,
        ...(event.action && ACTIONS.includes(event.action) ? { action: event.action } : {}),
        ...(event.op === "search" || event.op === "read" || event.op === "write" ? { op: event.op } : {}),
        ...(typeof event.jobId === "string" ? { jobId: event.jobId } : {}),
        ...(typeof event.chatId === "string" ? { chatId: event.chatId } : {}),
        query: event.query,
        status: "running",
        ...(subagents ? { subagents } : {}),
        ...(typeof event.parentId === "string" ? { parentId: event.parentId } : {}),
        ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {}),
      },
    ];
  }
  const telem = parseTelemInfo(event.telem);
  return list.map((call) =>
    call.id !== event.id
      ? call
      : event.status === "done"
        ? {
            ...call,
            status: "done",
            sources: event.sources ?? [],
            ...(event.crossref ? { crossref: event.crossref } : {}),
            ...(subagents ? { subagents } : {}),
            ...(telem ? { telem } : {}),
          }
        : { ...call, status: "error", ...(telem ? { telem } : {}) },
  );
}

/** a call cut off by Stop or a failure, settled: it, and any subagent still running in it, failed */
export function settleCall(call: ToolCall): ToolCall {
  const subagents = call.subagents?.some((sub) => sub.status === "running")
    ? call.subagents.map((sub) => (sub.status === "running" ? { ...sub, status: "error" as const } : sub))
    : call.subagents;
  if (call.status !== "running" && subagents === call.subagents) return call;
  return { ...call, status: call.status === "running" ? "error" : call.status, ...(subagents ? { subagents } : {}) };
}

/** rewrite a turn's tool calls in place */
function updateTools(chatId: string, messageId: string, update: (tools: ToolCall[] | undefined) => ToolCall[]) {
  const current = getSnapshot();
  const turns = current.messages[chatId];
  if (!turns) return false;
  setState({
    ...current,
    messages: {
      ...current.messages,
      [chatId]: turns.map((turn) => (turn.id === messageId ? { ...turn, tools: update(turn.tools) } : turn)),
    },
  });
  return true;
}

/**
 * Every source a chat's searches and reads turned up, de-duplicated by page
 * (see `sourceKey`) in the order they were first seen. Tolerates turns saved
 * before tools existed.
 */
export function selectChatSources(messages: readonly Message[] | undefined): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const message of messages ?? []) {
    for (const call of Array.isArray(message.tools) ? message.tools : []) {
      for (const source of call.sources ?? []) {
        if (!source || typeof source.url !== "string") continue;
        const key = sourceKey(source.url);
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({ title: source.title || source.url, url: source.url });
      }
    }
  }
  return sources;
}

/**
 * Every cross-reference a chat ran, as one: claims de-duplicated by their
 * normalised text, relations derived afresh over the merged claims. Empty for
 * chats without one, and for turns saved before cross-referencing.
 */
export function selectChatCrossref(messages: readonly Message[] | undefined): Crossref {
  const results: Crossref[] = [];
  for (const message of messages ?? []) {
    for (const call of Array.isArray(message?.tools) ? message.tools : []) {
      if (call?.crossref && Array.isArray(call.crossref.claims)) results.push(call.crossref);
    }
  }
  return mergeCrossrefs(results);
}

/** the most chat sources one request carries (the route's cap) */
export const MAX_REQUEST_SOURCES = 60;

/** Stop the reply in flight for a chat, keeping whatever text already arrived. */
function stopStreaming(chatId: string) {
  inFlight.get(chatId)?.abort();
}

async function streamReply(chatId: string, replyId: string) {
  const turns = getSnapshot().messages[chatId] ?? [];
  // the chat's sources so far, most recent 60, for cross_reference to check
  const sources = selectChatSources(turns)
    .filter((source) => /^https?:\/\//i.test(source.url))
    .slice(-MAX_REQUEST_SOURCES);
  const history = turns
    .filter((turn) => turn.content !== "" || turn.id !== replyId)
    .map(({ role, content }) => ({ role, content }));

  const controller = new AbortController();
  inFlight.set(chatId, controller);
  setStreaming(chatId, true);

  let text = "";
  try {
    const response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history, sources, chatId }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`chat route returned ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a partial frame stays in the
      // buffer until the rest of it arrives.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const raw = /^data: (.*)$/m.exec(frame)?.[1];
        if (!event || raw === undefined) continue;
        if (event === "delta") {
          text += (JSON.parse(raw) as { text: string }).text;
          // the chat may have been deleted mid-answer
          if (!setMessageContent(chatId, replyId, text)) return;
        } else if (event === "tool") {
          const tool = JSON.parse(raw) as ToolEvent;
          if (!updateTools(chatId, replyId, (tools) => applyToolEvent(tools, tool))) return;
        } else if (event === "error") {
          throw new Error((JSON.parse(raw) as { message: string }).message);
        }
      }
    }
    setMessageContent(chatId, replyId, text);
    persist();
  } catch (error) {
    // An abort is the Stop button, not a failure: keep the partial answer.
    const aborted = error instanceof DOMException && error.name === "AbortError";
    if (!aborted) setMessageContent(chatId, replyId, text || ERROR_REPLY);
    persist();
  } finally {
    // a call cut off by Stop or a failure never reports its end: settle it, so
    // a reload does not pulse it forever
    const reply = getSnapshot().messages[chatId]?.find((turn) => turn.id === replyId);
    if (reply?.tools?.some((call) => settleCall(call) !== call)) {
      updateTools(chatId, replyId, (tools) => (tools ?? []).map(settleCall));
    }
    inFlight.delete(chatId);
    setStreaming(chatId, false);
  }
}

/**
 * A chat's title, derived from its first user message: collapsed whitespace,
 * cut to 48 chars on a word boundary where there is one past the halfway mark.
 * Ported from the pane branch's store — without it a chat created by sending
 * into it stays "New chat" forever and the pane's header strip says nothing.
 */
export function titleFromText(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= 48) return clean;
  const cut = clean.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** ------------------------------------------------------------------ seed */

export type SeedChat = { title: string; messages: [Role, string][] };

/** Conversations an empty store starts with — none in the app. */
let seed: SeedChat[] = [];

/** test-only: sample conversations for `seedIfEmpty` to lay out against */
export function __setSeedForTests(chats: SeedChat[]) {
  seed = chats;
}

/**
 * Fill an empty store with the reference conversations and open the first one.
 * A no-op once anything exists, so it is safe to call on every mount.
 */
function seedIfEmpty() {
  if (getSnapshot().chats.length > 0) return;

  const now = Date.now();
  const chats: Chat[] = [];
  const messages: Record<string, Message[]> = {};

  seed.forEach((entry, chatIndex) => {
    const id = makeId("chat");
    // newest first: chat 0 is the most recent, each earlier one an hour back
    const createdAt = now - chatIndex * 60 * 60 * 1000;
    chats.push({
      id,
      title: entry.title,
      createdAt,
      updatedAt: createdAt + entry.messages.length * 1000,
    });
    messages[id] = entry.messages.map(([role, content], i) => ({
      id: makeId("msg"),
      role,
      content,
      createdAt: createdAt + i * 1000,
    }));
  });

  // Seeded, but nothing opened: /ai lands on the AI home — composer, cards and
  // an empty header strip — and the sidebar shows the chats with no row washed
  // until one is picked. (The sidebar's own copy of this store opened the
  // newest chat here, which docked the pane on first visit.)
  setState({ chats, messages, activeChatId: null, groups: [], streaming: [] });
}

/** ------------------------------------------------------------------ hook */

/**
 * The whole store, state and actions together. The actions are module-level
 * singletons wrapped in `useCallback` so consumers can list them in dependency
 * arrays without re-running effects.
 */
/**
 * The store's imperative face. The hook below is the same behaviour wrapped for
 * React; these are the identical module-level functions, exported so tests and
 * non-React callers do not have to mount a component to drive the store.
 */
export {
  newChat,
  openChat,
  renameChat,
  toggleChatPinned,
  toggleChatUnread,
  setChatProject,
  setChatGroup,
  createChatGroup,
  archiveChat,
  unarchiveChat,
  deleteChat,
  sendMessage,
  seedIfEmpty,
  stopStreaming,
};

/** the current snapshot, outside React */
export function getAgentState(): AgentState {
  return getSnapshot();
}

export function useAgentStore(): AgentStore {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return {
    ...snapshot,
    newChat: useCallback(newChat, []),
    openChat: useCallback(openChat, []),
    renameChat: useCallback(renameChat, []),
    toggleChatPinned: useCallback(toggleChatPinned, []),
    toggleChatUnread: useCallback(toggleChatUnread, []),
    setChatProject: useCallback(setChatProject, []),
    setChatGroup: useCallback(setChatGroup, []),
    createChatGroup: useCallback(createChatGroup, []),
    archiveChat: useCallback(archiveChat, []),
    unarchiveChat: useCallback(unarchiveChat, []),
    deleteChat: useCallback(deleteChat, []),
    sendMessage: useCallback(sendMessage, []),
    seedIfEmpty: useCallback(seedIfEmpty, []),
    stopStreaming: useCallback(stopStreaming, []),
  };
}

/** test-only: drop everything, including the persisted key */
export { __resetAgentStore as resetAgentStore };

export function __resetAgentStore() {
  state = EMPTY;
  hydrated = false;
  if (isBrowser()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore — nothing was persisted
    }
  }
  emit();
}
