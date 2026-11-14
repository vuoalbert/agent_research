// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * The only test that actually spends a turn on Sonnet 5. Skipped by default —
 * it needs the dev server up *and* a working Claude Code login on this machine,
 * and it is the one place the whole path (route -> Agent SDK -> local Claude
 * credentials -> SSE) is exercised for real.
 *
 *   npm run dev
 *   PLAYWRIGHT_URL=http://localhost:3500 LIVE_SONNET=1 npx vitest run sonnet.live
 *
 * There is no API-key fallback anywhere in this path: if the SDK cannot find
 * the local login, this fails with that error rather than quietly using a key.
 */
const URL = process.env.PLAYWRIGHT_URL;
const suite = URL && process.env.LIVE_SONNET ? describe : describe.skip;

suite("Sonnet 5, live", () => {
  it("streams a real answer about packing for a cold camping trip", async () => {
    const started = Date.now();
    const response = await fetch(`${URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "What should I pack for a cold camping trip?" },
        ],
      }),
    });
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let text = "";
    let firstTokenMs = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      for (const match of raw.matchAll(/^event: delta\ndata: (.*)$/gm)) {
        if (!firstTokenMs) firstTokenMs = Date.now() - started;
        text = text; // deltas are re-parsed below; this loop only times the first
        void match;
      }
    }

    for (const match of raw.matchAll(/^data: (\{"text".*)$/gm)) {
      text += (JSON.parse(match[1]) as { text: string }).text;
    }

    expect(raw).toContain("event: done");
    expect(raw).not.toContain("event: error");
    // a real answer, not the stub that used to live here
    expect(text.length).toBeGreaterThan(80);
    expect(text).not.toContain("isn't connected yet");
    // it should actually be about the question
    expect(text.toLowerCase()).toMatch(/layer|wool|bag|sleep|warm|insulat/);

    console.log(`time to first token: ${firstTokenMs}ms; ${text.length} chars`);
  }, 120_000);
});
