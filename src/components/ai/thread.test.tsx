import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AiThread } from "@/components/ai/thread";
import type { Message } from "@/lib/agent-store";

/** The tool row inside an assistant turn: one per call, above the turn's text. */
const messages = (tools: Message["tools"], content = ""): Message[] => [
  { id: "u1", role: "user", content: "What is World Labs Marble?", createdAt: 1 },
  { id: "a1", role: "assistant", content, createdAt: 2, tools },
];

describe("AiThread — tool rows", () => {
  it("shows a running call with Tavily and the query, pulsing, above the pending bars", () => {
    const { container } = render(
      <AiThread
        streaming
        messages={messages([{ id: "t1", name: "Tavily", query: "World Labs Marble", status: "running" }])}
      />,
    );
    const turn = container.querySelector('[data-role="assistant"]')!;
    const row = turn.querySelector('[data-ai="tool"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.dataset.status).toBe("running");
    expect(row.className).toContain("animate-pulse");
    expect(row.querySelector("svg")).not.toBeNull(); // the wrench
    expect(row.textContent).toBe("TavilyWorld Labs Marble");
    // the row sits before the turn's text (here, the pending shimmer)
    const pending = turn.querySelector('[data-ai="pending"]')!;
    expect(row.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("appends the source count once done, one row per call, in order", () => {
    const { container } = render(
      <AiThread
        messages={messages(
          [
            { id: "t1", name: "Tavily", query: "marble", status: "done", sources: [
              { title: "A", url: "https://a.com" },
              { title: "B", url: "https://b.com" },
            ] },
            { id: "t2", name: "Tavily", query: "marble pricing", status: "done", sources: [{ title: "C", url: "https://c.com" }] },
          ],
          "Marble is a world model.",
        )}
      />,
    );
    const rows = [...container.querySelectorAll<HTMLElement>('[data-ai="tool"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      "Tavilymarble· 2 sources",
      "Tavilymarble pricing· 1 source",
    ]);
    expect(rows[0].className).not.toContain("animate-pulse");
    const text = container.querySelector('[data-role="assistant"] p')!;
    expect(text.textContent).toBe("Marble is a world model.");
    expect(rows[1].compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders an old assistant turn with no tools as before", () => {
    const { container } = render(<AiThread messages={messages(undefined, "hello")} />);
    expect(container.querySelector('[data-ai="tool"]')).toBeNull();
    expect(container.querySelector('[data-role="assistant"] p')!.textContent).toBe("hello");
  });
});
