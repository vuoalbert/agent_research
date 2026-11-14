import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SideTabs } from "@/components/side-tabs";
import { __clearReads } from "@/components/telem-reader-data";
import { STORAGE_KEY, __resetAgentStore, getAgentState } from "@/lib/agent-store";

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
    __clearReads();
  });

  it("lists the active chat's de-duplicated sources, each with a small link out", () => {
    saveChatWithSources();
    const panel = openKnowledgeBase();

    expect(within(panel).getByRole("heading", { name: "Knowledge base" })).toBeTruthy();
    expect(panel.querySelector('[data-kb="count"]')!.textContent).toBe("2 sources");

    const rows = [...panel.querySelectorAll<HTMLButtonElement>("[data-source-row]")];
    expect(rows.map((row) => row.textContent)).toEqual(["Marble — World Labs", "Marble on Wikipedia"]);
    expect(rows[0].getAttribute("title")).toBe("Marble — World Labs\nworldlabs.ai");

    const links = within(panel).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Open Marble — World Labs in a new tab",
      "Open Marble on Wikipedia in a new tab",
    ]);
    expect(links[0].getAttribute("href")).toBe("https://www.worldlabs.ai/blog/marble");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");

    const icon = rows[0].querySelector("img")!;
    expect(icon.getAttribute("src")).toBe("https://www.google.com/s2/favicons?domain=worldlabs.ai&sz=64");
  });

  it("falls back to the site's initial when the favicon fails", () => {
    saveChatWithSources();
    const panel = openKnowledgeBase();
    const row = panel.querySelectorAll<HTMLElement>("[data-source-row]")[1];
    fireEvent.error(row.querySelector("img")!);
    const fallback = row.querySelector('[data-favicon="fallback"]')!;
    expect(fallback.textContent).toBe("e"); // en.wikipedia.org
    expect(row.querySelector("img")).toBeNull();
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
    expect(list.querySelectorAll("[data-source-row]")).toHaveLength(2);
  });

  it("opens a source inline, read through Telem, with a back arrow to the list", async () => {
    saveChatWithSources();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/telem/read");
      expect(url.searchParams.get("url")).toBe("https://www.worldlabs.ai/blog/marble");
      expect(url.searchParams.get("chat")).toBe("c1");
      return Response.json({
        url: "https://www.worldlabs.ai/blog/marble",
        title: "Marble: a world model",
        host: "worldlabs.ai",
        text: "## What it is\n\nMarble turns a [prompt](/docs) into a 3D world.\n\n![hero](https://x/y.png)",
        provider: "firecrawl",
        chars: 70,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const panel = openKnowledgeBase();
      fireEvent.click(panel.querySelector("[data-source-row]")!);
      expect(panel.querySelector('[data-kb="root"]')!.getAttribute("data-kb-view")).toBe("reader");
      await waitFor(() => expect(panel.querySelector('[data-telem-reader="root"]')!.getAttribute("data-status")).toBe("ready"));
      const reader = panel.querySelector('[data-kb="reader"]')!;
      expect(reader.className).toContain("scroll-fade-y");
      expect(within(reader as HTMLElement).getByRole("heading", { name: "Marble: a world model" })).toBeTruthy();
      expect(reader.querySelector('[data-telem-reader="meta"]')!.textContent).toBe("worldlabs.ai · Read by Telem · firecrawl");
      expect(reader.textContent).toContain("Marble turns a prompt into a 3D world.");
      // relative links resolve against the page; images never load
      expect(within(reader as HTMLElement).getByRole("link", { name: "prompt" }).getAttribute("href")).toBe("https://www.worldlabs.ai/docs");
      expect(reader.querySelector("img")).toBeNull();
      expect(panel.querySelector('[data-kb="reader-open"]')!.getAttribute("href")).toBe("https://www.worldlabs.ai/blog/marble");

      fireEvent.click(within(panel).getByRole("button", { name: "Back to all sources" }));
      expect(panel.querySelectorAll("[data-source-row]")).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Find more searches Telem from the chat's topic and appends what is new, tagged", async () => {
    saveChatWithSources();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/telem/find");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        query: "marble?",
        known: ["https://www.worldlabs.ai/blog/marble", "https://en.wikipedia.org/wiki/Marble_(app)"],
        chatId: "c1",
      });
      return Response.json({
        query: "marble?",
        sources: [
          { title: "Marble review", url: "https://example.com/marble-review", excerpt: "…", provider: "exa" },
          { title: "Marble again", url: "https://worldlabs.ai/blog/marble/", excerpt: "…", provider: "brave" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const panel = openKnowledgeBase();
      fireEvent.click(within(panel).getByRole("button", { name: "Find more" }));
      await waitFor(() => expect(panel.querySelector('[data-kb="find-status"]')?.textContent).toBe("Added 1 source from Telem"));
      const rows = [...panel.querySelectorAll("[data-source-row]")];
      expect(rows.map((row) => row.getAttribute("data-source-url"))).toEqual([
        "https://www.worldlabs.ai/blog/marble",
        "https://en.wikipedia.org/wiki/Marble_(app)",
        "https://example.com/marble-review",
      ]);
      expect(rows[2].querySelector("[data-source-origin]")!.textContent).toBe("Telem");
      expect(panel.querySelector('[data-kb="count"]')!.textContent).toBe("3 sources");
      // kept in the chat: one done Telem call on its latest turn
      const call = getAgentState().messages.c1[1].tools!.at(-1)!;
      expect(call).toMatchObject({ name: "Telem", query: "marble?", status: "done", origin: "kb" });
      expect(call.sources).toEqual([{ title: "Marble review", url: "https://example.com/marble-review" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tags sources the Force graph found", () => {
    saveChatWithSources();
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    saved.messages.c1[1].tools.push({
      id: "g1",
      name: "Telem",
      query: "marble world model",
      status: "done",
      origin: "graph",
      from: "page:worldlabs.ai/blog/marble",
      sources: [{ title: "Graph find", url: "https://example.org/found" }],
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    const panel = openKnowledgeBase();
    const tags = [...panel.querySelectorAll("[data-source-origin]")];
    expect(tags.map((tag) => [tag.closest("[data-source-row]")!.textContent, tag.getAttribute("data-source-origin")])).toEqual([
      ["Graph findGraph", "graph"],
    ]);
  });

  it("leaves the other panels as just their names", () => {
    saveChatWithSources();
    render(<SideTabs />);
    fireEvent.click(screen.getByRole("button", { name: "References" }));
    const panel = document.querySelector('[data-side-tab-panel="References"]') as HTMLElement;
    expect(panel.textContent).toBe("References");
  });
});
