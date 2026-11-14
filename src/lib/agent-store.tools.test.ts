import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STORAGE_KEY,
  __resetAgentStore,
  applyToolEvent,
  getAgentState,
  newChat,
  selectChatSources,
  sendMessage,
  sourceKey,
  stopStreaming,
  type Message,
} from "@/lib/agent-store";

/**
 * The store's side of the `tool` SSE events: calls land on the assistant turn
 * in order, their sources persist with the chat, chats saved before tools
 * existed still load, and the sources selector de-duplicates by URL.
 */

/** an SSE body; `signal` keeps it open until aborted, then errors it as fetch does */
function sse(frames: string[], signal?: AbortSignal | null) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (!signal) return controller.close();
      signal.addEventListener("abort", () =>
        controller.error(new DOMException("The operation was aborted.", "AbortError")),
      );
    },
  });
  return new Response(body, { status: 200 });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const A = { title: "Marble", url: "https://worldlabs.ai/marble" };
const B = { title: "Docs", url: "https://docs.worldlabs.ai" };
const C = { title: "News", url: "https://news.example.com/a" };

describe("agent store — tool calls", () => {
  beforeEach(() => {
    __resetAgentStore();
    vi.restoreAllMocks();
  });

  it("applies running → done to the assistant turn, in call order, and persists the sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sse([
          frame("tool", { id: "t1", name: "Tavily", query: "world labs marble", status: "running" }),
          frame("tool", { id: "t2", name: "Tavily", query: "marble pricing", status: "running" }),
          frame("tool", { id: "t2", status: "done", sources: [C] }),
          frame("tool", { id: "t1", status: "done", sources: [A, B] }),
          frame("delta", { text: "Marble is a world model." }),
          frame("done", {}),
        ]),
      ),
    );
    const id = newChat();
    sendMessage(id, "what is marble?");
    await settle();

    const reply = getAgentState().messages[id][1];
    expect(reply.content).toBe("Marble is a world model.");
    expect(reply.tools).toEqual([
      { id: "t1", name: "Tavily", query: "world labs marble", status: "done", sources: [A, B] },
      { id: "t2", name: "Tavily", query: "marble pricing", status: "done", sources: [C] },
    ]);

    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved.messages[id][1].tools[0].sources).toEqual([A, B]);
    // tool calls are display state: the history sent back to the route is text only
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: "user", content: "what is marble?" });
  });

  it("marks a call error on a tool error, and settles a running call when stopped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
          sse(
            [
              frame("tool", { id: "bad", name: "Tavily", query: "a", status: "running" }),
              frame("tool", { id: "bad", status: "error", message: "nope" }),
              frame("tool", { id: "cut", name: "Tavily", query: "b", status: "running" }),
            ],
            init.signal,
          ),
        ),
      ),
    );
    const id = newChat();
    sendMessage(id, "q");
    await settle();
    expect(getAgentState().messages[id][1].tools?.map((c) => c.status)).toEqual(["error", "running"]);

    stopStreaming(id);
    await settle();
    expect(getAgentState().messages[id][1].tools?.map((c) => c.status)).toEqual(["error", "error"]);
    expect(getAgentState().streaming).not.toContain(id);
  });

  it("loads a chat saved before tools existed", async () => {
    __resetAgentStore();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        chats: [{ id: "c1", title: "Old", createdAt: 1, updatedAt: 2 }],
        messages: {
          c1: [
            { id: "m1", role: "user", content: "hi", createdAt: 1 },
            { id: "m2", role: "assistant", content: "hello", createdAt: 2 },
          ],
        },
        activeChatId: "c1",
      }),
    );
    const state = getAgentState();
    expect(state.activeChatId).toBe("c1");
    expect(state.messages.c1[1].tools).toBeUndefined();
    expect(selectChatSources(state.messages.c1)).toEqual([]);
  });

  it("de-duplicates a chat's sources by URL, first-seen order", () => {
    const turn = (id: string, tools: Message["tools"]): Message => ({
      id,
      role: "assistant",
      content: "",
      createdAt: 0,
      tools,
    });
    const messages: Message[] = [
      { id: "u", role: "user", content: "q", createdAt: 0 },
      turn("a1", [
        { id: "1", name: "Tavily", query: "x", status: "done", sources: [A, B] },
        { id: "2", name: "Tavily", query: "y", status: "running" },
      ]),
      turn("a2", [{ id: "3", name: "Tavily", query: "z", status: "done", sources: [{ ...B, title: "Docs again" }, C, A] }]),
    ];
    expect(selectChatSources(messages)).toEqual([A, B, C]);
    expect(selectChatSources(undefined)).toEqual([]);
  });

  it("treats www., a trailing slash and http vs https as the same source", () => {
    expect(sourceKey("https://www.Minecraft.net/en-us/")).toBe(sourceKey("http://minecraft.net/en-us"));
    expect(sourceKey("https://x.com/a?b=1")).not.toBe(sourceKey("https://x.com/a?b=2"));
    const messages: Message[] = [
      {
        id: "a",
        role: "assistant",
        content: "",
        createdAt: 0,
        tools: [
          { id: "1", name: "Tavily", query: "q", status: "done", sources: [{ title: "Sales", url: "https://www.minecraft.net/sales/" }] },
          {
            id: "2",
            name: "Tavily",
            action: "read",
            query: "minecraft.net",
            status: "done",
            sources: [
              { title: "Sales page", url: "http://minecraft.net/sales" },
              { title: "Wiki", url: "https://en.wikipedia.org/wiki/Minecraft" },
            ],
          },
        ],
      },
    ];
    expect(selectChatSources(messages)).toEqual([
      { title: "Sales", url: "https://www.minecraft.net/sales/" },
      { title: "Wiki", url: "https://en.wikipedia.org/wiki/Minecraft" },
    ]);
  });

  it("keeps a read's action on the call; a search has none", () => {
    const read = applyToolEvent(undefined, { id: "r", name: "Tavily", action: "read", query: "a.com", status: "running" });
    expect(read).toEqual([{ id: "r", name: "Tavily", action: "read", query: "a.com", status: "running" }]);
    const search = applyToolEvent(undefined, { id: "s", name: "Tavily", query: "q", status: "running" });
    expect(search[0]).not.toHaveProperty("action");
  });

  it("keeps a message to the Visualize agent as a visualize-message call on its job", () => {
    const asked = applyToolEvent(undefined, {
      id: "m",
      name: "Visualize",
      action: "visualize-message",
      jobId: "20261114-1300-a-bicycle-bell-ab12",
      query: "make the dome blue",
      status: "running",
    });
    expect(applyToolEvent(asked, { id: "m", status: "done" })).toEqual([
      {
        id: "m",
        name: "Visualize",
        action: "visualize-message",
        jobId: "20261114-1300-a-bicycle-bell-ab12",
        query: "make the dome blue",
        status: "done",
        sources: [],
      },
    ]);
  });

  it("applyToolEvent ignores a repeated start and an end for an unknown call", () => {
    const started = applyToolEvent(undefined, { id: "1", name: "Tavily", query: "q", status: "running" });
    expect(applyToolEvent(started, { id: "1", name: "Tavily", query: "q", status: "running" })).toHaveLength(1);
    expect(applyToolEvent(started, { id: "zzz", status: "done", sources: [A] })).toEqual(started);
  });
});
