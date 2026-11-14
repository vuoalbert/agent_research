import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SideTabs } from "@/components/side-tabs";
import { STORAGE_KEY, __resetAgentStore } from "@/lib/agent-store";

vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => true,
}));

/** a saved store with one chat whose reply searched twice, with an overlap */
function saveChatWithSources(active: string | null = "c1") {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      chats: [
        { id: "c1", title: "Marble", createdAt: 1, updatedAt: 2 },
        { id: "c2", title: "Other", createdAt: 1, updatedAt: 1 },
      ],
      messages: {
        c1: [
          { id: "m1", role: "user", content: "marble?", createdAt: 1 },
          {
            id: "m2",
            role: "assistant",
            content: "A world model.",
            createdAt: 2,
            tools: [
              { id: "t1", name: "Tavily", query: "marble", status: "done", sources: [
                { title: "Marble — World Labs", url: "https://www.worldlabs.ai/blog/marble" },
                { title: "Marble on Wikipedia", url: "https://en.wikipedia.org/wiki/Marble_(app)" },
              ] },
              { id: "t2", name: "Tavily", query: "marble again", status: "done", sources: [
                { title: "Marble — World Labs", url: "https://www.worldlabs.ai/blog/marble" },
              ] },
            ],
          },
        ],
        c2: [],
      },
      activeChatId: active,
    }),
  );
}

const openKnowledgeBase = () => {
  render(<SideTabs />);
  fireEvent.click(screen.getByRole("button", { name: "Knowledge base" }));
  return document.querySelector('[data-side-tab-panel="Knowledge base"]') as HTMLElement;
};

describe("Knowledge base panel", () => {
  beforeEach(() => {
    __resetAgentStore();
  });

  it("lists the active chat's de-duplicated sources as links out", () => {
    saveChatWithSources();
    const panel = openKnowledgeBase();

    expect(within(panel).getByRole("heading", { name: "Knowledge base" })).toBeTruthy();
    expect(panel.querySelector('[data-kb="count"]')!.textContent).toBe("2 sources");

    const links = within(panel).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Marble — World Labs", "Marble on Wikipedia"]);
    expect(links[0].getAttribute("href")).toBe("https://www.worldlabs.ai/blog/marble");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0].getAttribute("title")).toBe("Marble — World Labs\nworldlabs.ai");

    const icon = links[0].querySelector("img")!;
    expect(icon.getAttribute("src")).toBe("https://www.google.com/s2/favicons?domain=worldlabs.ai&sz=64");
  });

  it("falls back to the site's initial when the favicon fails", () => {
    saveChatWithSources();
    const panel = openKnowledgeBase();
    const link = within(panel).getAllByRole("link")[1];
    fireEvent.error(link.querySelector("img")!);
    const fallback = link.querySelector('[data-favicon="fallback"]')!;
    expect(fallback.textContent).toBe("e"); // en.wikipedia.org
    expect(link.querySelector("img")).toBeNull();
  });

  it("shows the empty state for a chat with no sources", () => {
    saveChatWithSources("c2");
    const panel = openKnowledgeBase();
    expect(panel.querySelector('[data-kb="count"]')!.textContent).toBe("0 sources");
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
    expect(within(panel).getByText("Sources Claude finds will appear here")).toBeTruthy();
  });

  it("lists only sources — no claims, even when the chat has a cross-reference", () => {
    saveChatWithSources();
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    saved.messages.c1[1].tools.push({
      id: "x1",
      name: "Cross-reference",
      action: "crossref",
      query: "marble",
      status: "done",
      crossref: {
        claims: [
          {
            id: "C1",
            text: "Marble launched in 2025.",
            sources: [
              { url: "https://www.worldlabs.ai/blog/marble", stance: "supports", quote: "launched in 2025" },
              { url: "https://en.wikipedia.org/wiki/Marble_(app)", stance: "contradicts", quote: "released in 2026" },
            ],
          },
        ],
        relations: [],
      },
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    const panel = openKnowledgeBase();

    expect(panel.querySelector('[data-kb="claims"]')).toBeNull();
    expect(panel.querySelector("[data-claim]")).toBeNull();
    expect(within(panel).queryByText("Marble launched in 2025.")).toBeNull();
    const list = within(panel).getByRole("list", { name: "Sources" });
    expect(within(list).getAllByRole("link")).toHaveLength(2);
  });

  it("leaves the other panels as just their names", () => {
    saveChatWithSources();
    render(<SideTabs />);
    fireEvent.click(screen.getByRole("button", { name: "References" }));
    const panel = document.querySelector('[data-side-tab-panel="References"]') as HTMLElement;
    expect(panel.textContent).toBe("References");
  });
});
