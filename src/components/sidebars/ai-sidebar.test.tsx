import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/sidebar";
import { NEW_GLYPH } from "@/data/nav";
import { __resetAgentStore, getAgentState, setChatProject, STORAGE_KEY } from "@/lib/agent-store";
import { viewForApp } from "@/lib/navigation";

/**
 * The AI app's sidebar, driven through the real `Sidebar` so the card chrome
 * above it — the header and the outlined "New" button this column adopts as
 * its New row — is in the tree exactly as it ships.
 *
 * Geometry is asserted as classes, not pixels: jsdom cannot lay out, so these
 * pin what the classes encode and `npm run diff` scores the paint.
 */

function renderApp(app = "ai") {
  return render(<Sidebar view={viewForApp(app)!} />);
}

/** the chat rows, in order */
function chatTitles() {
  return screen
    .getAllByRole("button")
    .filter((el) => el.hasAttribute("data-agent-chat"))
    .map((el) => el.textContent);
}

afterEach(() => {
  cleanup();
  __resetAgentStore();
});

describe("AiSidebar", () => {
  it("seeds the reference conversations on first mount and opens none", () => {
    renderApp();

    expect(chatTitles()).toEqual([
      "Hey",
      "Trip packing list",
      "Event sign-up form",
      "Mentor contact list",
      "Quarterly review deck",
      "Volunteer shift schedule",
      "Weekly meeting reminder",
    ]);
    // seeding opens nothing, so no row carries the wash: /ai lands on the AI
    // home — composer and cards — and the column waits to be picked from
    const active = screen.getAllByRole("button").filter((el) => el.getAttribute("aria-current") === "page");
    expect(active).toHaveLength(0);
    // and it persisted, so a reload shows the same column
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain("Trip packing list");
  });

  it("seeds only once — a second mount reuses the stored chats", () => {
    renderApp();
    const first = chatTitles();
    cleanup();
    renderApp();
    expect(chatTitles()).toEqual(first);
  });

  it("moves the wash to a chat row when it is clicked", () => {
    renderApp();
    const row = screen.getByText("Quarterly review deck").closest("button")!;
    expect(row.getAttribute("aria-current")).toBeNull();
    expect(row.className).not.toContain("bg-plane-active"); // the `nav` variant is unwashed

    fireEvent.click(row);

    const washed = screen.getByText("Quarterly review deck").closest("button")!;
    expect(washed.getAttribute("aria-current")).toBe("page");
    expect(washed.className).toContain("bg-plane-active");
    // and the wash is exclusive
    expect(screen.getAllByRole("button").filter((el) => el.getAttribute("aria-current") === "page")).toHaveLength(1);
  });

  it("empties the pane on New — the card's own button is the New row", () => {
    renderApp();
    // exactly one "New" control in the card: the outlined chrome button
    expect(screen.getAllByText("New")).toHaveLength(1);
    const button = document.querySelector("[data-sidebar-new]") as HTMLElement;

    fireEvent.click(button);

    // a fresh, empty chat at the head of the list, and it is the active one
    expect(chatTitles()[0]).toBe("New chat");
    expect(chatTitles()).toHaveLength(8);
    const active = screen.getAllByRole("button").filter((el) => el.getAttribute("aria-current") === "page");
    expect(active[0].textContent).toBe("New chat");
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.messages[stored.activeChatId]).toEqual([]);
  });

  it("renames a chat inline from the row menu", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Volunteer shift schedule" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const field = await screen.findByLabelText("Rename Volunteer shift schedule");
    fireEvent.change(field, { target: { value: "Volunteer shifts" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(chatTitles()).toContain("Volunteer shifts"));
    expect(chatTitles()).not.toContain("Volunteer shift schedule");
    // the field is gone; the row is a row again
    expect(screen.queryByLabelText("Rename Volunteer shift schedule")).toBeNull();
  });

  it("abandons a rename on Escape", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Quarterly review deck" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const field = await screen.findByLabelText("Rename Quarterly review deck");
    fireEvent.change(field, { target: { value: "thrown away" } });
    fireEvent.keyDown(field, { key: "Escape" });

    await waitFor(() => expect(chatTitles()).toContain("Quarterly review deck"));
    expect(chatTitles()).not.toContain("thrown away");
  });

  it("deletes a chat from the row menu", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Mentor contact list" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(chatTitles()).not.toContain("Mentor contact list"));
    expect(chatTitles()).toHaveLength(6);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain("Mentor contact list");
  });

  it("opens the row menu on right-click too", async () => {
    renderApp();
    const row = screen.getByText("Hey").closest("button")!;
    fireEvent.contextMenu(row.parentElement!);
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
  });

  it("shows the complete session menu with real projects and an honest empty groups state", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));

    for (const label of [
      "Open as quick task",
      "Copy session ID",
      "Pin",
      "Mark as unread",
      "Rename",
      "Add to project",
      "Move to group",
      "Archive",
      "Delete",
    ]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Add to project" }), { key: "ArrowRight" });
    expect(await screen.findByRole("menuitem", { name: "How Agent Research works" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to group" }), { key: "ArrowRight" });
    expect(await screen.findByText("No groups yet")).toBeTruthy();
    expect(await screen.findByRole("menuitem", { name: "Create group…" })).toBeTruthy();
  });

  it("persists pin and unread state from the menu", async () => {
    renderApp();
    const actions = () => screen.getByRole("button", { name: "Actions for Hey" });

    fireEvent.click(actions());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(screen.getByText("Hey").closest("button")?.getAttribute("data-pinned")).toBe("true"));

    fireEvent.click(actions());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as unread" }));
    await waitFor(() => expect(screen.getByText("Hey").closest("button")?.getAttribute("data-unread")).toBe("true"));

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    const saved = stored.chats.find((chat: { title: string }) => chat.title === "Hey");
    expect(saved).toMatchObject({ pinned: true, unread: true });
  });

  it("copies the actual chat id and opens a compact quick-task dialog", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderApp();
    const chat = getAgentState().chats[0];

    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy session ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(chat.id));

    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open as quick task" }));
    expect(await screen.findByRole("dialog", { name: "Quick task" })).toBeTruthy();
    expect(within(screen.getByRole("dialog", { name: "Quick task" })).getByText("Hey")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Quick task" })).toBeNull());
    expect(screen.getByText("Hey").closest("button")?.getAttribute("aria-current")).toBe("page");
  });

  it("creates and assigns a real local group from the group submenu", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to group" }), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Create group…" }));

    const dialog = await screen.findByRole("dialog", { name: "Create group" });
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Camp planning" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(getAgentState().groups).toEqual(["Camp planning"]));
    expect(getAgentState().chats.find((chat) => chat.title === "Hey")?.group).toBe("Camp planning");
    expect(document.querySelector('[data-agent-chat-group="Camp planning"]')).toBeTruthy();

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Actions for Hey" })).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to group" }), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "None" }));
    await waitFor(() => expect(getAgentState().chats.find((chat) => chat.title === "Hey")?.group).toBeUndefined());
  });

  it("uses menu letters only for focused top-level actions and closes after acting", async () => {
    renderApp();
    const hey = () => screen.getByText("Hey").closest("button")!;

    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Open as quick task" }), { key: "p" });
    await waitFor(() => expect(hey().getAttribute("data-pinned")).toBe("true"));
    expect(screen.queryByRole("menu")).toBeNull();

    // A letter on a submenu trigger remains available to submenu/typeahead
    // behavior and cannot accidentally pin the chat.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Add to project" }), { key: "p" });
    expect(hey().getAttribute("data-pinned")).toBe("true");
    fireEvent.keyDown(document.body, { key: "u" });
    expect(hey().getAttribute("data-unread")).toBeNull();
  });

  it("leaves menu navigation keys to the menu primitive", async () => {
    renderApp();
    const hey = () => screen.getByText("Hey").closest("button")!;

    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    const pin = await screen.findByRole("menuitem", { name: "Pin" });
    fireEvent.keyDown(pin, { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(hey().getAttribute("data-pinned")).toBeNull();

    fireEvent.keyDown(pin, { key: "Enter" });
    await waitFor(() => expect(hey().getAttribute("data-pinned")).toBe("true"));
  });

  it("archives without dropping data and restores from the sidebar", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Hey" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    await waitFor(() => expect(screen.queryByText("Hey")).toBeNull());
    expect(getAgentState().chats.find((chat) => chat.title === "Hey")).toMatchObject({ archived: true });
    expect(screen.getByRole("button", { name: /Archived/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore Hey" }));
    await waitFor(() => expect(screen.getByText("Hey")).toBeTruthy());
    expect(getAgentState().chats.find((chat) => chat.title === "Hey")).toMatchObject({ archived: false });
  });

  it("keeps non-project tool rows inert", () => {
    renderApp();
    for (const label of ["projects", "artifacts", "scheduled", "customize"]) {
      const row = document.querySelector(`[data-agent-nav="${label}"]`) as HTMLElement;
      expect(row.textContent?.toLowerCase(), label).toBe(label);
      // these are still shape-only rows; only the two real project destinations filter.
      if (label === "projects") continue;
      const before = chatTitles();
      fireEvent.click(row);
      expect(chatTitles(), label).toEqual(before);
      expect(row.getAttribute("aria-current"), label).toBeNull();
      expect(row.className, label).toContain("h-[32px]"); // the 32px pitch
      expect(row.className, label).toContain("text-[13.15px]");
    }
  });

  it("heads each group with 11px caps and an inert trailing glyph", () => {
    renderApp();
    const projects = document.querySelector('[data-agent-group="Projects"]') as HTMLElement;
    const chats = document.querySelector('[data-agent-group="Chats and tasks"]') as HTMLElement;

    for (const [group, action] of [
      [projects, "New project"],
      [chats, "Filter chats"],
    ] as const) {
      const label = group.firstElementChild as HTMLElement;
      expect(label.className).toContain("text-[11px]");
      expect(label.className).toContain("uppercase");
      expect(label.className).toContain("tracking-[0.07em]");
      expect(label.className).toContain("text-plane-faint");
      expect(within(group).getByRole("button", { name: action })).toBeTruthy();
    }
    expect((projects.firstElementChild as HTMLElement).textContent).toBe("Projects");
    expect((chats.firstElementChild as HTMLElement).textContent).toBe("Chats and tasks");
  });

  it("uses the two existing project rows as chat filters", async () => {
    renderApp();
    for (const name of ["How Agent Research works"]) {
      const row = screen.getByText(name).closest("button")!;
      expect(row.getAttribute("data-agent-nav")).toBe(name);
      expect(row.firstElementChild?.tagName).toBe("svg");
      expect(row.firstElementChild?.getAttribute("width")).toBe("16");
    }

    const chat = getAgentState().chats[0];
    act(() => setChatProject(chat.id, "How Agent Research works"));
    fireEvent.click(screen.getByText("How Agent Research works").closest("button")!);
    expect(screen.getByRole("button", { name: "Clear project filter" })).toBeTruthy();
    await waitFor(() => expect(chatTitles()).toEqual([chat.title]));
    fireEvent.click(screen.getByRole("button", { name: "Clear project filter" }));
    expect(chatTitles()).toHaveLength(7);
  });

  it("marks chat rows with a 6px hollow bullet in the 16px glyph slot", () => {
    renderApp();
    const row = screen.getByText("Hey").closest("button")!;
    const slot = row.firstElementChild as HTMLElement;
    expect(slot.className).toContain("w-[16px]"); // labels stay on the measured x=104
    const bullet = slot.firstElementChild as HTMLElement;
    expect(bullet.className).toContain("size-[6px]");
    expect(bullet.className).toContain("rounded-full");
    expect(bullet.className).toContain("ring-1"); // hollow: a ring, no fill
  });
});

describe("the New button's glyph", () => {
  afterEach(() => {
    cleanup();
    __resetAgentStore();
  });

  it("marks the AI app's New button with CirclePlus", () => {
    render(<Sidebar view={viewForApp("ai")!} />);
    const button = document.querySelector("[data-sidebar-new]") as HTMLElement;
    const glyph = button.querySelector("[data-new-glyph]") as SVGElement;
    expect(glyph.getAttribute("data-new-glyph")).toBe(NEW_GLYPH.AI);
    expect(NEW_GLYPH.AI).toBe("CirclePlus");
  });
});

describe("the store's streamed reply", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    __resetAgentStore();
  });

  it("opens an empty assistant turn for the reply to stream into", async () => {
    // the 600ms stub became a real request to /api/chat; stubbed here so the
    // sidebar's own tests stay about the sidebar
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new TextEncoder().encode("event: done\ndata: {}\n\n"), { status: 200 }),
      ),
    );
    const { useAgentStore } = await import("@/lib/agent-store");
    let store!: ReturnType<typeof useAgentStore>;
    function Probe() {
      store = useAgentStore();
      return null;
    }
    render(<Probe />);
    act(() => store.seedIfEmpty());
    const id = store.chats[0].id;
    const before = store.messages[id].length;

    act(() => store.sendMessage(id, "  what's the packing list?  "));
    expect(store.messages[id]).toHaveLength(before + 2);
    expect(store.messages[id].at(-2)).toMatchObject({ role: "user", content: "what's the packing list?" });
    expect(store.messages[id].at(-1)).toMatchObject({ role: "assistant", content: "" });
    expect(store.streaming).toContain(id);
  });
});
