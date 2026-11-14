import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AiThread } from "@/components/ai/thread";
import { applyToolEvent, type Message } from "@/lib/agent-store";

/** Telem rows: a radar mark, "Telem", what it did — no counts; providers only in the hover title. */
const messages = (tools: Message["tools"]): Message[] => [
  { id: "u1", role: "user", content: "World Labs?", createdAt: 1 },
  { id: "a1", role: "assistant", content: "Marble.", createdAt: 2, tools },
];

describe("AiThread — Telem rows", () => {
  it("shows Radar + Telem for a search and Telem · Reading <hosts> for a read", () => {
    let tools = applyToolEvent(undefined, { id: "s", name: "Telem", query: "World Labs Marble", status: "running" });
    tools = applyToolEvent(tools, {
      id: "s",
      status: "done",
      sources: [{ title: "A", url: "https://a.com" }, { title: "B", url: "https://b.com" }],
      providers: ["exa", "brave"],
    });
    tools = applyToolEvent(tools, { id: "r", name: "Telem", action: "read", query: "worldlabs.ai, techcrunch.com", status: "running" });
    const { container } = render(<AiThread messages={messages(tools)} />);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-ai="tool"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      "TelemWorld Labs Marble",
      "Telem·Reading worldlabs.ai, techcrunch.com",
    ]);
    expect(rows[0].title).toBe("Telem · exa, brave");
    expect(rows[1].title).toBe("");
    for (const row of rows) {
      const icon = row.querySelector("svg")!;
      expect(icon.getAttribute("data-icon")).toBe("radar");
      expect(icon.getAttribute("width")).toBe("14");
      expect(icon.getAttribute("class")).toContain("text-[var(--ai-muted)]");
      // no counts anywhere on the row
      expect(row.textContent).not.toMatch(/\d+ (sources|results)/);
    }
  });

  it("renders a saved chat's Tavily rows as before", () => {
    const { container } = render(
      <AiThread messages={messages([{ id: "t", name: "Tavily", query: "marble", status: "done", sources: [] }])} />,
    );
    const row = container.querySelector<HTMLElement>('[data-ai="tool"]')!;
    expect(row.textContent).toBe("Tavilymarble");
    expect(row.querySelector("svg")!.getAttribute("data-icon")).not.toBe("radar");
    expect(row.title).toBe("");
  });
});
