import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route with the Agent SDK mocked. What is asserted here is the contract
 * either side depends on: the SSE frames the store parses, the history cap, and
 * that a failure is reported rather than swallowed.
 *
 * The live model is exercised separately, opt-in, in
 * `src/__tests__/sonnet.live.test.ts`.
 */
const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => query(args) }));

/** the SDK's frame for one Messages API streaming event */
const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

async function* stream(...messages: unknown[]) {
  for (const message of messages) yield message;
}

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/chat/route");
  return POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) }));
};

const readAll = async (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
};

describe("POST /api/chat", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("streams text deltas as SSE, then done", async () => {
    query.mockReturnValue(stream(delta("Pack "), delta("wool.")));
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));

    expect(body).toContain('event: delta\ndata: {"text":"Pack "}');
    expect(body).toContain('event: delta\ndata: {"text":"wool."}');
    expect(body.trimEnd().endsWith("event: done\ndata: {}")).toBe(true);
  });

  it("is a Node-runtime event stream", async () => {
    query.mockReturnValue(stream(delta("x")));
    const route = await import("@/app/api/chat/route");
    expect(route.runtime).toBe("nodejs");
    const response = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await readAll(response);
  });

  it("asks Opus 5.5 at high effort for one turn, with no tools and no repo settings", async () => {
    query.mockReturnValue(stream(delta("x")));
    await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));

    const { options, prompt } = query.mock.calls[0][0];
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.effort).toBe("high");
    expect(options.thinking).toEqual({ type: "adaptive" });
    expect(options.systemPrompt).toBe(
      "You are Agent Research, an AI assistant. Be concise.",
    );
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.maxTurns).toBe(1);
    expect(options.includePartialMessages).toBe(true);
    // a single-turn ask goes over as itself, with no transcript preamble
    expect(prompt).toBe("hi");
  });

  it("caps the history at the last 30 turns and labels the speakers", async () => {
    query.mockReturnValue(stream(delta("x")));
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    await readAll(await post({ messages }));

    const { prompt } = query.mock.calls[0][0];
    expect(prompt).not.toContain("turn 9"); // dropped: outside the last 30
    expect(prompt).toContain("turn 10"); // kept: the oldest of the 30
    expect(prompt).toContain("User: turn 10");
    expect(prompt).toContain("Agent Research: turn 11");
    // the newest turn is the question, not part of the transcript
    expect(prompt.trimEnd().endsWith("User: turn 39")).toBe(true);
  });

  it("reports a failure as an error event rather than a dead stream", async () => {
    query.mockImplementation(() => {
      throw new Error("Claude Code is not logged in");
    });
    const body = await readAll(await post({ messages: [{ role: "user", content: "hi" }] }));
    expect(body).toContain("event: error");
    expect(body).toContain("Claude Code is not logged in");
  });

  it("rejects a body with no turns in it", async () => {
    const response = await post({ messages: [] });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
