import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AiThread } from "@/components/ai/thread";
import { applyToolEvent, type Message } from "@/lib/agent-store";

/** Vault rows: a book, "Vault", and what it did — no counts. */
const messages = (tools: Message["tools"]): Message[] => [
  { id: "u1", role: "user", content: "Minecraft sales?", createdAt: 1 },
  { id: "a1", role: "assistant", content: "From the vault.", createdAt: 2, tools },
];

describe("AiThread — Vault rows", () => {
  it("shows BookOpen + Vault + Searching / Reading / Saved", () => {
    const { container } = render(
      <AiThread
        messages={messages([
          { id: "v1", name: "Vault", action: "vault", op: "search", query: "Minecraft sales", status: "done", sources: [] },
          { id: "v2", name: "Vault", action: "vault", op: "read", query: "How many copies has Minecraft sold", status: "done",
            sources: [{ title: "A", url: "https://a.com" }, { title: "B", url: "https://b.com" }] },
          { id: "v3", name: "Vault", action: "vault", op: "write", query: "Minecraft follow-ups", status: "running" },
        ])}
      />,
    );
    const rows = [...container.querySelectorAll<HTMLElement>('[data-ai="tool"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      "VaultSearching Minecraft sales",
      "VaultReading How many copies has Minecraft sold",
      "VaultSaved Minecraft follow-ups",
    ]);
    for (const row of rows) {
      expect(row.dataset.action).toBe("vault");
      const icon = row.querySelector("svg")!;
      expect(icon.getAttribute("data-icon")).toBe("book-open");
      expect(icon.getAttribute("width")).toBe("14");
      expect(icon.getAttribute("class")).toContain("text-[var(--ai-muted)]");
    }
  });
});

describe("applyToolEvent — vault calls", () => {
  it("keeps the vault action and op from the start frame", () => {
    const started = applyToolEvent(undefined, {
      id: "v1", name: "Vault", action: "vault", op: "read", query: "Note", status: "running",
    });
    expect(started).toEqual([{ id: "v1", name: "Vault", action: "vault", op: "read", query: "Note", status: "running" }]);
    const done = applyToolEvent(started, { id: "v1", status: "done", sources: [{ title: "A", url: "https://a.com" }] });
    expect(done[0]).toMatchObject({ action: "vault", op: "read", status: "done", sources: [{ title: "A", url: "https://a.com" }] });
    // an unknown op is dropped rather than stored
    const odd = applyToolEvent(undefined, { id: "v2", name: "Vault", action: "vault", op: "nope" as never, query: "x", status: "running" });
    expect(odd[0].op).toBeUndefined();
  });
});
