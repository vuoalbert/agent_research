import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_ENDPOINT,
  ERROR_REPLY,
  getAgentState,
  newChat,
  __resetAgentStore,
  sendMessage,
  stopStreaming,
} from "@/lib/agent-store";

/**
 * The store against a mocked `/api/chat`. The route's own contract is tested in
 * `src/app/api/chat/route.test.ts`; what matters here is that the store turns
 * that SSE into a turn, keeps a partial answer when stopped, and says something
 * honest when the route is unreachable.
 */

/** an SSE body that yields the given frames, one chunk each */
function sse(frames: string[], { hang = false } = {}) {
  const encoder = new TextEncoder();
  let released: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (hang) await new Promise<void>((resolve) => (released = resolve));
      controller.close();
    },
  });
  return { response: new Response(body, { status: 200 }), release: () => released?.() };
}

const deltaFrame = (text: string) => `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;
const DONE = "event: done\ndata: {}\n\n";

/** wait for the in-flight reply to settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("agent store — streamed replies", () => {
  beforeEach(() => {
    __resetAgentStore();
    vi.restoreAllMocks();
  });

  it("appends an empty assistant turn, then fills it from the deltas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([deltaFrame("Ten "), deltaFrame("essentials."), DONE]).response);
    vi.stubGlobal("fetch", fetchMock);

    const id = newChat();
    sendMessage(id, "what should they pack?");

    // the turn exists before any text does — that is what the pane shimmers
    const turns = getAgentState().messages[id];
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: "assistant", content: "" });
    expect(getAgentState().streaming).toContain(id);

    await settle();
    expect(getAgentState().messages[id][1].content).toBe("Ten essentials.");
    expect(getAgentState().streaming).not.toContain(id);
    expect(fetchMock.mock.calls[0][0]).toBe(CHAT_ENDPOINT);
  });

  it("sends the history, without the empty turn it is about to fill", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([DONE]).response);
    vi.stubGlobal("fetch", fetchMock);

    const id = newChat();
    sendMessage(id, "first");
    await settle();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toEqual([{ role: "user", content: "first" }]);
  });

  it("splits SSE frames that arrive mid-frame", async () => {
    // one delta cut across two chunks, which is the normal case over a socket
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      sse([`event: delta\ndata: {"text":"par`, `tial"}\n\n`, DONE]).response,
    ));

    const id = newChat();
    sendMessage(id, "hi");
    await settle();
    expect(getAgentState().messages[id][1].content).toBe("partial");
  });

  it("keeps the text so far when the reply is stopped", async () => {
    const { response, release } = sse([deltaFrame("Overnight lows"), DONE], { hang: true });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) => {
      // a real fetch rejects with AbortError when the signal fires
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        resolve(response);
      });
    }));

    const id = newChat();
    sendMessage(id, "hi");
    await settle();
    expect(getAgentState().messages[id][1].content).toBe("Overnight lows");

    stopStreaming(id);
    release();
    await settle();

    // the partial answer survives — stopping is not discarding
    expect(getAgentState().messages[id][1].content).toBe("Overnight lows");
    expect(getAgentState().streaming).not.toContain(id);
  });

  it("says so when the route cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const id = newChat();
    sendMessage(id, "hi");
    await settle();

    expect(getAgentState().messages[id][1].content).toBe(ERROR_REPLY);
    expect(getAgentState().streaming).not.toContain(id);
  });

  it("puts the same message up when the route reports an error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      sse([`event: error\ndata: {"message":"not logged in"}\n\n`]).response,
    ));

    const id = newChat();
    sendMessage(id, "hi");
    await settle();
    expect(getAgentState().messages[id][1].content).toBe(ERROR_REPLY);
  });

  it("never persists the streaming flag", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([deltaFrame("hi"), DONE]).response));
    const id = newChat();
    sendMessage(id, "hi");
    await settle();

    const stored = JSON.parse(window.localStorage.getItem("agent_research.agent.v1") as string);
    expect(stored.streaming).toBeUndefined();
    // and the answer itself did survive the write
    expect(stored.messages[id][1].content).toBe("hi");
  });
});
