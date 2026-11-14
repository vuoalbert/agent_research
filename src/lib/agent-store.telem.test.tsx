import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { telemTitle } from "@/components/ai/thread";
import { applyToolEvent } from "@/lib/agent-store";

describe("a Telem call's providers and latency", () => {
  const started = applyToolEvent(undefined, { id: "a", name: "Telem", query: "solid state batteries", status: "running" });

  it("ride the done frame onto the call", () => {
    const [call] = applyToolEvent(started, { id: "a", status: "done", sources: [], telem: { providers: ["exa", "brave"], latencyMs: 1234 } });
    expect(call.telem).toEqual({ providers: ["exa", "brave"], latencyMs: 1234 });
    expect(telemTitle(call)).toBe("exa, brave · 1.2 s");
  });

  it("ride an error frame too, and junk is dropped", () => {
    const [failed] = applyToolEvent(started, { id: "a", status: "error", telem: { providers: [], latencyMs: 300 } });
    expect(telemTitle(failed)).toBe("no provider answered · 300 ms");
    const [junk] = applyToolEvent(started, { id: "a", status: "done", telem: { providers: "exa" } });
    expect(junk.telem).toBeUndefined();
    expect(telemTitle(junk)).toBeUndefined();
  });
});

describe("the chat's tool row", () => {
  it("carries them in its hover title only — no numbers in the visible row", async () => {
    const { AiThread } = await import("@/components/ai/thread");
    const [call] = applyToolEvent(
      applyToolEvent(undefined, { id: "a", name: "Telem", query: "solid state batteries", status: "running" }),
      { id: "a", status: "done", sources: [], telem: { providers: ["exa"], latencyMs: 800 } },
    );
    const { container } = render(
      <AiThread messages={[{ id: "m", role: "assistant", content: "Done.", createdAt: 0, tools: [call] }]} />,
    );
    const row = container.querySelector<HTMLElement>("[data-ai='tool']")!;
    expect(row.title).toBe("exa · 800 ms");
    expect(row.textContent).not.toMatch(/\d/);
  });
});
