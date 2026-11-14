import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STORAGE_KEY,
  NEW_CHAT_TITLE,
  deleteChat,
  getAgentState,
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
  __resetAgentStore,
  seedIfEmpty,
  sendMessage,
  titleFromText,
} from "@/lib/agent-store";

/**
 * Written against the store's contract rather than its internals. The pane and
 * the sidebar were built in parallel against two copies of this file; the
 * sidebar's is the one that survived, so these were re-pointed at its contract
 * at merge time. Where the two disagreed the differences were real, and are
 * called out on the tests below.
 */
const SEEDED = 7;
describe("agent store", () => {
  beforeEach(() => {
    __resetAgentStore();
    // sendMessage now streams from /api/chat. These tests are about the store's
    // bookkeeping, so the route is stubbed to close immediately; the streaming
    // itself is covered in src/lib/agent-store.streaming.test.ts.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new TextEncoder().encode("event: done\ndata: {}\n\n"), { status: 200 }),
      ),
    );
  });

  it("seeds the reference conversations, once", () => {
    seedIfEmpty();
    const seeded = getAgentState().chats;
    expect(seeded).toHaveLength(SEEDED);

    seedIfEmpty();
    expect(getAgentState().chats).toEqual(seeded);
  });

  it("persists under the contract's localStorage key", () => {
    seedIfEmpty();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).chats).toHaveLength(SEEDED);
  });

  it("migrates older v1 chats without changing the storage key", () => {
    const id = "chat-existing-v1";
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        chats: [{ id, title: "Saved chat", createdAt: 1, updatedAt: 2 }],
        messages: { [id]: [] },
        activeChatId: id,
      }),
    );

    const state = getAgentState();
    expect(state.chats[0]).toMatchObject({
      id,
      pinned: false,
      unread: false,
      archived: false,
    });
    expect(state.groups).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain("Saved chat");
  });

  it("opens an empty chat at the top of the list", () => {
    // The pane's store kept a new chat out of the list until its first send;
    // this one lists it straight away as "New chat", which is what the sidebar
    // shows and asserts. Either way New gives the composer back empty.
    const id = newChat();
    expect(getAgentState().activeChatId).toBe(id);
    expect(getAgentState().messages[id]).toEqual([]);
    expect(getAgentState().chats).toHaveLength(1);
    expect(getAgentState().chats[0]).toMatchObject({ id, title: NEW_CHAT_TITLE });
  });

  it("titles the chat from its first message", () => {
    const id = newChat();
    sendMessage(id, "  What do we still need for the trip?  ");

    const { chats, messages } = getAgentState();
    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe("What do we still need for the trip?");
    // the user's turn, plus the empty assistant turn the reply streams into
    expect(messages[id]).toHaveLength(2);
    expect(messages[id][0]).toMatchObject({ role: "user" });
    expect(messages[id][0].content).toBe("What do we still need for the trip?");
    expect(messages[id][1]).toMatchObject({ role: "assistant", content: "" });
  });

  it("opens the assistant turn empty and flags the chat as streaming", () => {
    // the 600ms stub is gone: the reply is streamed from /api/chat, and the
    // turn is created before its first token so the pane can shimmer it
    const id = newChat();
    sendMessage(id, "hello");

    const turns = getAgentState().messages[id];
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: "assistant", content: "" });
    expect(getAgentState().streaming).toContain(id);
  });

  it("does not answer into a chat that was deleted while it was thinking", async () => {
    const id = newChat();
    sendMessage(id, "hello");
    deleteChat(id);
    // let the in-flight reply settle: it must not resurrect the chat
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getAgentState().messages[id]).toBeUndefined();
    expect(getAgentState().chats).toHaveLength(0);
    expect(getAgentState().streaming).not.toContain(id);
  });

  it("keeps an empty send out of the thread", () => {
    const id = newChat();
    sendMessage(id, "   ");
    expect(getAgentState().messages[id]).toEqual([]);
    // the chat is still there and still unnamed — an empty send names nothing
    expect(getAgentState().chats).toHaveLength(1);
    expect(getAgentState().chats[0].title).toBe(NEW_CHAT_TITLE);
  });

  it("opens an existing chat with its full history", () => {
    seedIfEmpty();
    const [first] = getAgentState().chats;
    openChat(first.id);
    expect(getAgentState().activeChatId).toBe(first.id);
    expect(getAgentState().messages[first.id].length).toBeGreaterThan(1);
  });

  it("renames and deletes", () => {
    seedIfEmpty();
    const [first, second] = getAgentState().chats;

    renameChat(first.id, "  Trip kit  ");
    expect(getAgentState().chats.find((c) => c.id === first.id)?.title).toBe("Trip kit");

    // an empty rename is a no-op, not a chat with no name
    renameChat(first.id, "   ");
    expect(getAgentState().chats.find((c) => c.id === first.id)?.title).toBe("Trip kit");

    openChat(second.id);
    deleteChat(second.id);
    expect(getAgentState().chats).toHaveLength(SEEDED - 1);
    expect(getAgentState().chats.some((c) => c.id === second.id)).toBe(false);
    expect(getAgentState().messages[second.id]).toBeUndefined();
    // deleting the open chat falls through to a neighbour rather than to
    // nothing — the pane's store nulled it instead
    expect(getAgentState().activeChatId).not.toBe(second.id);
    expect(getAgentState().activeChatId).not.toBeNull();
  });

  it("stores menu metadata and keeps archived chats recoverable", () => {
    seedIfEmpty();
    const [first, second] = getAgentState().chats;

    toggleChatPinned(first.id);
    toggleChatUnread(first.id);
    setChatProject(first.id, "How Starline works");
    createChatGroup("Camp planning");
    setChatGroup(first.id, "Camp planning");
    expect(getAgentState().chats[0]).toMatchObject({
      pinned: true,
      unread: true,
      project: "How Starline works",
      group: "Camp planning",
    });
    expect(getAgentState().groups).toEqual(["Camp planning"]);

    setChatGroup(first.id, null);
    expect(getAgentState().chats.find((chat) => chat.id === first.id)?.group).toBeUndefined();
    setChatGroup(first.id, "Camp planning");

    openChat(second.id);
    archiveChat(second.id);
    expect(getAgentState().chats.find((chat) => chat.id === second.id)).toMatchObject({ archived: true });
    expect(getAgentState().activeChatId).not.toBe(second.id);
    unarchiveChat(second.id);
    expect(getAgentState().chats.find((chat) => chat.id === second.id)).toMatchObject({ archived: false });
  });

  it("moves a chat that was just answered to the top of the list", () => {
    seedIfEmpty();
    const [, older] = getAgentState().chats;
    sendMessage(older.id, "one more thing");
    expect(getAgentState().chats[0].id).toBe(older.id);
  });

  it("cuts a long title at a word boundary", () => {
    expect(titleFromText("short one")).toBe("short one");
    const long = titleFromText(
      "Research this topic and summarise the main findings with sources:",
    );
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(49);
    expect(long).not.toMatch(/ …$/);
  });
});
