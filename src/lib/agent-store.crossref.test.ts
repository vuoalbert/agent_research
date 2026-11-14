import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  STORAGE_KEY,
  __resetAgentStore,
  applyToolEvent,
  getAgentState,
  newChat,
  selectChatCrossref,
  sendMessage,
  type Crossref,
  type Message,
} from "@/lib/agent-store";

/** The store's side of cross_reference: the result lands on the call, persists, merges per chat. */

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = (frames: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
        controller.close();
      },
    }),
    { status: 200 },
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const A = "https://minecraft.net/sales";
const B = "https://en.wikipedia.org/wiki/Minecraft";
const C = "https://news.example.com/a";

const crossref: Crossref = {
  claims: [
    {
      id: "C1",
      text: "Minecraft sold 300 million copies.",
      sources: [
        { url: A, stance: "supports", quote: "300 million" },
        { url: C, stance: "contradicts", quote: "238 million" },
      ],
    },
  ],
  relations: [{ a: A, b: C, kind: "conflicts", claims: ["C1"] }],
};

describe("agent store — cross-reference", () => {
  beforeEach(() => {
    __resetAgentStore();
    vi.restoreAllMocks();
  });

  it("keeps the crossref action and result on the call, persisted, and sends the chat's sources", async () => {
    const fetch = vi.fn().mockResolvedValue(
      sse([
        frame("tool", { id: "x1", name: "Cross-reference", action: "crossref", query: "minecraft", status: "running" }),
        frame("tool", { id: "x1", status: "done", crossref }),
        frame("delta", { text: "They disagree." }),
        frame("done", {}),
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    const id = newChat();
    sendMessage(id, "first");
    await settle();

    const call = getAgentState().messages[id][1].tools![0];
    expect(call).toMatchObject({ name: "Cross-reference", action: "crossref", status: "done", crossref });
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved.messages[id][1].tools[0].crossref).toEqual(crossref);

    // a first message carries no sources yet
    expect(JSON.parse(fetch.mock.calls[0][1].body).sources).toEqual([]);

    fetch.mockResolvedValue(
      sse([
        frame("tool", { id: "t1", name: "Tavily", query: "q", status: "running" }),
        frame("tool", { id: "t1", status: "done", sources: [{ title: "A", url: A }, { title: "bad", url: "ftp://x" }] }),
        frame("done", {}),
      ]),
    );
    sendMessage(id, "second");
    await settle();
    sendMessage(id, "third");
    await settle();
    // the chat's de-duplicated http(s) sources go with the request
    expect(JSON.parse(fetch.mock.calls[2][1].body).sources).toEqual([{ title: "A", url: A }]);
  });

  it("caps the sources sent at the 60 most recent", async () => {
    const fetch = vi.fn().mockResolvedValue(
      sse([
        frame("tool", { id: "t1", name: "Tavily", query: "q", status: "running" }),
        frame("tool", {
          id: "t1",
          status: "done",
          sources: Array.from({ length: 70 }, (_, i) => ({ title: `${i}`, url: `https://s${i}.com` })),
        }),
        frame("done", {}),
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    const id = newChat();
    sendMessage(id, "one");
    await settle();
    sendMessage(id, "two");
    await settle();
    const sent = JSON.parse(fetch.mock.calls[1][1].body).sources;
    expect(sent).toHaveLength(60);
    expect(sent[0].url).toBe("https://s10.com");
  });

  it("merges every cross-reference of a chat, de-duplicating claims by normalised text", () => {
    const later: Crossref = {
      claims: [
        {
          id: "C1",
          text: "minecraft sold 300 million copies",
          sources: [{ url: `${B}/`, stance: "supports", quote: "over 300 million" }],
        },
      ],
      relations: [],
    };
    const tools = (id: string, result: Crossref | undefined) =>
      applyToolEvent(
        applyToolEvent(undefined, { id, name: "Cross-reference", action: "crossref", query: "q", status: "running" }),
        { id, status: "done", crossref: result },
      );
    const messages: Message[] = [
      { id: "a1", role: "assistant", content: "", createdAt: 1, tools: tools("x1", crossref) },
      { id: "a0", role: "assistant", content: "old turn, no tools", createdAt: 2 },
      { id: "a2", role: "assistant", content: "", createdAt: 3, tools: tools("x2", later) },
    ];
    const merged = selectChatCrossref(messages);
    expect(merged.claims).toHaveLength(1);
    expect(merged.claims[0].sources.map((s) => s.url)).toEqual([A, C, `${B}/`]);
    expect(merged.relations.map((r) => r.kind).sort()).toEqual(["agrees", "conflicts", "conflicts"]);
    expect(selectChatCrossref(undefined)).toEqual({ claims: [], relations: [] });
  });
});
