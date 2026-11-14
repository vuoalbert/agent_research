import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { References } from "@/components/references";
import { SideTabs } from "@/components/side-tabs";
import { __clearReads } from "@/components/telem-reader-data";
import { __resetAgentStore } from "@/lib/agent-store";
import type { VaultNoteView, VaultTree } from "@/lib/vault-browse";

vi.mock("@/lib/motion-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/motion-tokens")>()),
  useReduced: () => true,
}));

/* the store's streaming list, steerable from a test */
let streaming: string[] = [];
vi.mock("@/lib/agent-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-store")>();
  return { ...actual, useAgentStore: () => ({ ...actual.useAgentStore(), streaming }) };
});

const TREE: VaultTree = {
  count: 3,
  titles: {
    "how many copies": "Research/How many copies.md",
    "sold 425m": "Claims/Sold 425M.md",
    guinness: "Sources/Guinness.md",
  },
  children: [
    { kind: "folder", name: "Claims", path: "Claims", children: [{ kind: "note", title: "Sold 425M", path: "Claims/Sold 425M.md", type: "claim" }] },
    { kind: "folder", name: "Research", path: "Research", children: [{ kind: "note", title: "How many copies", path: "Research/How many copies.md", type: "research" }] },
    { kind: "folder", name: "Sources", path: "Sources", children: [{ kind: "note", title: "Guinness", path: "Sources/Guinness.md", type: "source" }] },
  ],
};

const NOTES: Record<string, VaultNoteView> = {
  "Research/How many copies.md": {
    path: "Research/How many copies.md",
    title: "How many copies",
    frontmatter: { type: "research", updated: "2026-11-14" },
    body: "# How many copies\n\n## Answer\nMore than **425 million**.\n\n## Claims\n- [[Sold 425M]]\n- [[Ghost claim]]",
  },
  "Claims/Sold 425M.md": {
    path: "Claims/Sold 425M.md",
    title: "Sold 425M",
    frontmatter: { type: "claim", updated: "2026-11-14" },
    body: "# Minecraft has sold more than 425 million copies.\n\n## Supported by\n- [[How many copies]] — \"425M+\"\n\n## Contradicted by\n- [[Old figure]] — \"300 million\"\n\n## Mentioned by\n- [[Guinness]] — \"over 350 million\"",
  },
  "Sources/Guinness.md": {
    path: "Sources/Guinness.md",
    title: "Guinness",
    frontmatter: { type: "source", updated: "2026-11-14", url: "https://www.guinnessworldrecords.com/x" },
    body: "# Best-selling videogame | Guinness World Records\n\nThe best-selling videogame.",
  },
};

let tree: VaultTree = TREE;
let saved: unknown[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  if (url.pathname === "/api/vault/tree") return Response.json(tree);
  if (url.pathname === "/api/telem/read") {
    return Response.json({
      url: url.searchParams.get("url"),
      title: "Best-selling videogame",
      host: "guinnessworldrecords.com",
      text: "# Best-selling videogame\n\nMinecraft has sold **more than 300 million** copies.",
      provider: "tavily",
      chars: 70,
    });
  }
  if (url.pathname === "/api/vault/full-page") {
    saved.push(JSON.parse(String(init?.body)));
    return Response.json({ path: "Sources/Guinness.md" });
  }
  const note = NOTES[url.searchParams.get("path") ?? ""];
  return note ? Response.json(note) : Response.json({ error: "no such note" }, { status: 404 });
});

/** the element `selector` matches, once it is there */
const find = (root: HTMLElement, selector: string) =>
  waitFor(() => {
    const found = root.querySelector(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found as HTMLElement;
  });

const treeCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/vault/tree")).length;

beforeEach(() => {
  __resetAgentStore();
  tree = TREE;
  saved = [];
  streaming = [];
  __clearReads();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const openReferences = () => {
  render(<SideTabs />);
  fireEvent.click(screen.getByRole("button", { name: "References" }));
  return document.querySelector('[data-side-tab-panel="References"]') as HTMLElement;
};

describe("References panel", () => {
  it("lists the vault's folders, open, with their notes", async () => {
    const panel = openReferences();
    expect(within(panel).getByRole("heading", { name: "References" })).toBeTruthy();
    await within(panel).findByText("How many copies");
    const folders = [...panel.querySelectorAll("[data-ref-folder]")];
    expect(folders.map((f) => f.textContent)).toEqual(["Claims", "Research", "Sources"]);
    expect(folders.every((f) => f.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(panel.querySelector('[data-ref-note="Sources/Guinness.md"]')!.getAttribute("title")).toBe("Guinness");
    expect(panel.querySelector('[data-ref="header"]')!.textContent).toBe("References");

    fireEvent.click(folders[0]);
    expect(folders[0].getAttribute("aria-expanded")).toBe("false");
    expect(panel.querySelector('[data-ref-note="Claims/Sold 425M.md"]')).toBeNull();
  });

  it("opens a note, follows its [[links]], and walks back to the tree", async () => {
    const panel = openReferences();
    fireEvent.click(await within(panel).findByText("How many copies"));

    const research = await find(panel, '[data-ref="note"][data-ref-path="Research/How many copies.md"]');
    await within(research).findByText("425 million");
    expect(research.querySelector('[data-ref="meta"]')!.textContent).toContain("2026-11-14");
    expect(within(research).getByRole("heading", { name: "How many copies" })).toBeTruthy();
    // the unknown [[link]] is shown but goes nowhere
    const ghost = within(research).getByText("Ghost claim").closest("a")!;
    expect(ghost.getAttribute("href")).toBe("#vault-missing");
    fireEvent.click(ghost);
    expect(panel.querySelector('[data-ref-path="Research/How many copies.md"]')).toBeTruthy();

    fireEvent.click(within(research).getByText("Sold 425M"));
    const claim = await find(panel, '[data-ref-path="Claims/Sold 425M.md"]');
    expect(within(claim).getByRole("heading", { name: "Minecraft has sold more than 425 million copies." })).toBeTruthy();
    expect(within(claim).getByRole("heading", { name: "Supported by" })).toBeTruthy();
    // the contradicting entry is set apart (red); the others are not
    await within(claim).findByText("Old figure");
    expect(within(claim).getByText("Old figure").closest("ins")!.textContent).toBe('Old figure — "300 million"');
    expect(within(claim).getByText("Guinness").closest("ins")).toBeNull();
    expect(within(claim).getByText("How many copies").closest("ins")).toBeNull();

    fireEvent.click(await within(claim).findByText("Guinness"));
    const source = await find(panel, '[data-ref-path="Sources/Guinness.md"]');
    const link = source.querySelector('[data-ref="source-link"]')!;
    expect(link.textContent).toBe("guinnessworldrecords.com");
    expect(link.getAttribute("href")).toBe("https://www.guinnessworldrecords.com/x");
    expect(link.getAttribute("target")).toBe("_blank");

    const back = () => fireEvent.click(panel.querySelector('[data-ref="back"]')!);
    back();
    await waitFor(() => expect(panel.querySelector('[data-ref-path="Claims/Sold 425M.md"]')).toBeTruthy());
    back();
    await waitFor(() => expect(panel.querySelector('[data-ref-path="Research/How many copies.md"]')).toBeTruthy());
    back();
    expect(panel.querySelector('[data-ref="note"]')).toBeNull();
    expect(panel.querySelector('[data-ref="back"]')).toBeNull();
    expect(panel.querySelector('[data-ref="scroll"]')!.closest(".hidden")).toBeNull();
  });

  it("reads a source note's full page through Telem, and saves it to the vault only on request", async () => {
    const panel = openReferences();
    fireEvent.click(await within(panel).findByText("Guinness"));
    await find(panel, '[data-ref="note"][data-ref-path="Sources/Guinness.md"]');
    // a note with no page has no button
    expect(panel.querySelectorAll('[data-ref="read-full-page"]')).toHaveLength(1);

    fireEvent.click(panel.querySelector('[data-ref="read-full-page"]')!);
    const section = await find(panel, '[data-ref="full-page"][data-state="ready"]');
    expect(section.textContent).toContain("Full page · Read by Telem · tavily");
    expect(section.textContent).toContain("Minecraft has sold more than 300 million copies.");
    expect(section.closest('[data-ref="note-scroll"]')).toBeTruthy();
    expect(saved).toEqual([]);

    fireEvent.click(within(section).getByRole("button", { name: "Save to vault" }));
    await find(panel, '[data-ref="saved"]');
    expect(saved).toEqual([{ path: "Sources/Guinness.md", url: "https://www.guinnessworldrecords.com/x" }]);
    // the note is read again, so the saved section shows in it
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("Sources%2FGuinness.md")).length).toBe(2),
    );
  });

  it("shows the empty state for an empty or missing vault", async () => {
    tree = { children: [], titles: {}, count: 0 };
    const panel = openReferences();
    const empty = await find(panel, '[data-ref="empty"]');
    expect(empty.textContent).toBe("Research notes will appear here");
  });

  it("re-reads the tree when the panel opens and when a turn finishes, not otherwise", async () => {
    const { rerender } = render(<References titleId="t" open={false} />);
    expect(treeCalls()).toBe(0);
    rerender(<References titleId="t" open />);
    await waitFor(() => expect(treeCalls()).toBe(1));

    streaming = ["c1"];
    rerender(<References titleId="t" open />);
    expect(treeCalls()).toBe(1);
    tree = { ...TREE, count: 4, children: [...TREE.children, { kind: "note", title: "Inbox", path: "Inbox.md" }] };
    streaming = [];
    await act(async () => rerender(<References titleId="t" open />));
    await waitFor(() => expect(treeCalls()).toBe(2));
    await screen.findByText("Inbox");
  });
});
