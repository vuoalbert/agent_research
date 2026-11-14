import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiPane } from "@/components/ai/pane";
import {
  COLUMN,
  DOCK_COLUMN,
  DOCK_SWAP,
  MARK_HEIGHT,
  MARK_RISE,
  MARK_SIZE,
} from "@/components/ai/tokens";
import { getAgentState, newChat, __resetAgentStore } from "@/lib/agent-store";
import { DURATION, POP_SCALE, SHIFT, bodyVariants, popVariants, timing } from "@/lib/motion-tokens";

/**
 * Calibrated against the source screen at :3210 and against the measured
 * content card — inner edges x 311..1431 / y 41..891, a 44px strip, so 1120x806
 * of pane below it.
 *
 * jsdom cannot lay out, so what is asserted here is the geometry the classes
 * encode (the strip's box, the 760/840 columns, the 35% spacer, the 16px docked
 * corner, the 16/25 message type) plus the behaviour, which jsdom *can* run.
 * The live numbers were read back out of the browser and are recorded in
 * `pane.tsx`.
 *
 * `fireEvent` and not `user-event`: the latter is not a dependency of this repo
 * and `package.json` belongs to the scaffold agent (CONTRACT.md §5).
 */
/** the sidebar's store — the one that survived the merge — seeds seven */
const SEEDED = 7;

describe("AiPane", () => {
  beforeEach(() => {
    __resetAgentStore();
    vi.restoreAllMocks();
    // the reply is streamed from /api/chat now; these tests are about the pane,
    // so the route closes immediately unless a test overrides it
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new TextEncoder().encode("event: done\ndata: {}\n\n"), { status: 200 }),
      ),
    );
  });

  const pane = () => {
    const { container } = render(<AiPane />);
    return container.querySelector('[data-region="ai-pane"]') as HTMLElement;
  };

  /** Type into the composer the way a controlled field hears it. */
  const type = (text: string) => {
    const field = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: text } });
    return field;
  };

  const send = (text: string) => {
    const field = type(text);
    fireEvent.keyDown(field, { key: "Enter" });
    return field;
  };

  it("is the content card: right-rounded, one hairline, white ground", () => {
    const el = pane();
    // right corners only — the left edge abuts the sidebar card, and a radius
    // there let the page grey through as a wedge at the join
    expect(el.className).toContain("rounded-r-[8px]");
    expect(el.className).not.toMatch(/\brounded-\[8px\]/);
    expect(el.className).toContain("border-plane-border");
    expect(el.className).toContain("bg-plane-pane");
  });

  it("seeds the home screen with the session's conversations", async () => {
    pane();
    await waitFor(() => expect(getAgentState().chats).toHaveLength(SEEDED));

    // three slots to a row, filled from the newest chats. Asserted against the
    // store rather than against fixture strings, so re-seeding cannot silently
    // rot this — the pane's own store seeded two chats and left one hole.
    const newest = getAgentState().chats.slice(0, 3);
    const cards = [...document.querySelectorAll("[data-chat-card]")];
    expect(cards.map((card) => card.getAttribute("data-chat-card"))).toEqual(
      newest.map((chat) => chat.id),
    );
    for (const chat of newest) {
      expect(await screen.findByText(chat.title), chat.title).toBeTruthy();
    }
    // seven chats fill all three slots, so there is no dashed hole
    expect(document.querySelectorAll('[data-slot="empty"]')).toHaveLength(0);
  });

  it("stands the composer on the 35% line, 760 wide, with the mark behind it", () => {
    pane();
    const composer = document.querySelector('[data-composer="home"]') as HTMLElement;
    expect(composer.className).toContain(COLUMN.split(" ")[0]);
    expect(document.querySelector(String.raw`.min-h-\[35\%\]`)).toBeTruthy();
    // the mark is drawn twice, once sharp and once blurred, each masked with the
    // other's gradient — remove either and the dissolve is a hard line
    const crisp = document.querySelector('[data-mark="crisp"]') as HTMLElement;
    const blurred = document.querySelector('[data-mark="blurred"]') as HTMLElement;
    expect(crisp).toBeTruthy();
    expect(blurred).toBeTruthy();
    // ...and only the blurred copy carries the blur, so the crown stays sharp
    expect(blurred.style.filter).toContain("blur(");
    expect(crisp.style.filter).toBe("");
    for (const layer of [crisp, blurred]) {
      // it is the ribbon now, not the outlined diamond that drew here before
      const svg = layer.querySelector("svg") as SVGSVGElement;
      expect(svg.getAttribute("width")).toBe(String(MARK_SIZE));
      // flat: one grey, so no contour is painted at a facet tint
      expect(svg.querySelector("[fill-opacity]:not([fill-opacity='1'])")).toBeNull();
      expect(layer.className).toContain("text-plane-border");
    }
  });

  it("tucks the mark's lower third behind the composer, fading only near it", () => {
    pane();
    const layer = document.querySelector('[data-mark="crisp"]')!.parentElement as HTMLElement;
    // the layer's top is MARK_RISE above the composer, and the mark hangs from
    // it, so exactly height - rise of the mark is behind the box
    expect(layer.style.top).toBe(`-${MARK_RISE}px`);
    expect((MARK_HEIGHT - MARK_RISE) / MARK_HEIGHT).toBeCloseTo(1 / 3, 2);
    // both ramps end on the composer's top edge, as a percentage of the mark's
    // own box — the layer's height moves with the field, the mark's does not
    const edge = `${((100 * MARK_RISE) / MARK_HEIGHT).toFixed(2)}%`;
    for (const key of ["crisp", "blurred"]) {
      const el = document.querySelector(`[data-mark="${key}"]`) as HTMLElement;
      expect(el.style.maskImage).toContain(edge);
    }
  });

  it("asks with Agent Research's own placeholder, over an empty header strip", () => {
    pane();
    expect(screen.getByPlaceholderText("Ask Agent Research…")).toBeTruthy();
    const header = document.querySelector('[data-region="ai-header"]') as HTMLElement;
    expect(header.dataset.state).toBe("home");
    expect(header.textContent).toBe("");
    // the strip keeps its 44px box, so nothing below it moves
    expect(header.className).toContain("h-[44px]");
  });

  it("docks on the first send: 840 bar, 16px corner, title in the strip", async () => {
    pane();
    send("What do we still need for the trip?");

    const bar = await waitFor(
      () => document.querySelector('[data-composer="docked"]') as HTMLElement,
    );
    expect(bar).toBeTruthy();
    expect(bar.className).toContain(DOCK_COLUMN.split(" ")[0]);
    expect((bar.querySelector("form") as HTMLElement).style.borderRadius).toBe("16px");
    expect(screen.getByPlaceholderText("Write a message…")).toBeTruthy();
    expect(screen.getByLabelText("Voice input")).toBeTruthy();
    expect(screen.getByText("Agent Research is AI and can make mistakes.")).toBeTruthy();

    const header = document.querySelector('[data-region="ai-header"]') as HTMLElement;
    expect(header.dataset.state).toBe("chat");
    expect(within(header).getByText("What do we still need for the trip?")).toBeTruthy();
  });

  it("moves the composer rather than swapping it — one field, one curve", async () => {
    pane();
    const before = send("hello");

    const after = await screen.findByPlaceholderText("Write a message…");
    // the same <textarea>, not a remount: a second instance would take the
    // caret, the selection and the focus with it
    expect(after).toBe(before);
    // ~450ms, which is what the dock is asked to take
    expect(DOCK_SWAP.duration).toBe(0.45);
  });

  it("empties the field on send", async () => {
    pane();
    const field = send("hello");
    await screen.findByPlaceholderText("Write a message…");
    expect(field.value).toBe("");
  });

  it("sets both halves of a turn at 16/25, the reader's in a grey bubble right", async () => {
    // this one needs the reply to actually arrive, so the route sends a delta
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        new TextEncoder().encode(
          'event: delta\ndata: {"text":"Overnight lows run cold."}\n\nevent: done\ndata: {}\n\n',
        ),
        { status: 200 },
      ),
    ));
    pane();
    send("hello");

    const said = await waitFor(() => document.querySelector('[data-role="user"] p') as HTMLElement);
    expect(said.className).toContain("text-[16px]");
    expect(said.className).toContain("leading-[25px]");
    expect(said.className).toContain("bg-[var(--ai-chip)]");
    expect((said.parentElement as HTMLElement).className).toContain("self-end");

    const answered = await waitFor(
      () => {
        const el = document.querySelector('[data-role="assistant"] p');
        if (!el) throw new Error("no reply yet");
        return el as HTMLElement;
      },
      { timeout: 2000 },
    );
    expect(answered.className).toContain("text-[16px]");
    expect(answered.className).toContain("leading-[25px]");
    // plain text, no bubble
    expect(answered.className).not.toContain("bg-[var(--ai-chip)]");
    expect((answered.parentElement as HTMLElement).className).toContain("self-start");
  });

  it("shimmers the empty assistant turn, and swaps the chevron for a Stop", async () => {
    // hold the route open so the turn stays empty and in flight
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      new Promise((resolve) => {
        release = () =>
          resolve(new Response(new TextEncoder().encode("event: done\ndata: {}\n\n"), { status: 200 }));
      }),
    ));

    pane();
    send("hello");

    const pending = await waitFor(() => {
      const el = document.querySelector('[data-ai="pending"]');
      if (!el) throw new Error("no shimmer yet");
      return el as HTMLElement;
    });
    // it sits in the assistant turn, and it is a placeholder not a spinner
    expect(pending.closest("[data-role]")?.getAttribute("data-role")).toBe("assistant");
    expect(pending.querySelectorAll("span")).toHaveLength(3);
    // and the send control is a Stop while the reply is arriving
    expect(screen.getByLabelText("Stop generating")).toBeTruthy();

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByLabelText("Stop generating")).toBeNull();
  });

  it("anchors each sent message so it settles near the top, and follows the reply", async () => {
    pane();
    send("hello");
    const scroller = await waitFor(() => document.querySelector('[data-ai="thread"]') as HTMLElement);
    const user = await waitFor(() => document.querySelector('[data-role="user"]') as HTMLElement);
    const reply = await waitFor(() => document.querySelector('[data-role="assistant"]') as HTMLElement);

    // the user's turn is the scroll anchor; the reply streams in under it
    expect(user.getAttribute("data-scroll-anchor")).toBe("true");
    expect(reply.getAttribute("data-scroll-anchor")).toBe("false");
    // the scroller reserves blank room below the newest turn
    expect(scroller.querySelector("[data-message-scroller-spacer]")).not.toBeNull();
    // and the first turn starts 24px under the strip, from the list's padding
    const list = scroller.querySelector('[data-ai="thread-list"]') as HTMLElement;
    expect(list.className).toContain("py-6");
  });

  it("opens an existing chat with its whole history", async () => {
    pane();
    await waitFor(() => expect(getAgentState().chats).toHaveLength(SEEDED));

    const [, second] = getAgentState().chats;
    const turns = getAgentState().messages[second.id].length;
    fireEvent.click(document.querySelector(`[data-chat-card="${second.id}"]`) as HTMLElement);

    // the whole history, however long the seed made it
    await waitFor(() => expect(document.querySelectorAll("[data-role]").length).toBe(turns));
    // scoped to the thread, and matched against what the store actually holds
    // for this chat rather than a phrase from a particular seed
    const thread = document.querySelector('[data-ai="thread"]') as HTMLElement;
    for (const turn of getAgentState().messages[second.id]) {
      expect(within(thread).getByText(turn.content), turn.content).toBeTruthy();
    }
    // and the header strip names the chat that is open (scoped: the title is
    // also still on its home card behind the thread)
    const strip = document.querySelector('[data-region="ai-header"]') as HTMLElement;
    expect(strip.getAttribute("data-state")).toBe("chat");
    expect(strip.querySelector('[data-ai="chat-title"]')?.textContent).toBe(second.title);
  });

  it("gives the composer back, empty, when a new chat is opened", async () => {
    pane();
    send("hello");
    await screen.findByPlaceholderText("Write a message…");

    // what the sidebar's New does, from outside this subtree
    act(() => {
      newChat();
    });

    const field = (await screen.findByPlaceholderText("Ask Agent Research…")) as HTMLTextAreaElement;
    expect(field.value).toBe("");
    // the strip empties, but the title animates out rather than vanishing, so
    // it is still mounted for the length of the exit
    await waitFor(() =>
      expect(
        (document.querySelector('[data-region="ai-header"]') as HTMLElement).textContent,
      ).toBe(""),
    );
  });

  it("fills the composer from a suggested prompt without sending it", () => {
    pane();

    const [use] = screen.getAllByRole("button", { name: /Use this prompt/i });
    fireEvent.click(use);

    const field = screen.getByPlaceholderText("Ask Agent Research…") as HTMLTextAreaElement;
    expect(field.value).toContain("Research this topic");
    // filled, not sent
    expect(document.querySelector('[data-composer="docked"]')).toBeNull();
  });

  it("leaves Shift+Enter in the field", () => {
    pane();
    const field = type("one");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });

    expect(field.value).toBe("one");
    expect(document.querySelector('[data-composer="docked"]')).toBeNull();
  });

  it("will not send an empty field", async () => {
    pane();
    await waitFor(() => expect(getAgentState().chats).toHaveLength(SEEDED));

    const field = type("   ");
    fireEvent.keyDown(field, { key: "Enter" });

    expect(document.querySelector('[data-composer="docked"]')).toBeNull();
    // the two seeded conversations, and no third one made of whitespace
    expect(getAgentState().chats).toHaveLength(SEEDED);
  });

  it("opens the same eight rows the source composer's + opens", async () => {
    pane();

    fireEvent.click(screen.getByRole("button", { name: "Add to the conversation" }));

    for (const label of [
      "Add files or photos",
      "Take a screenshot",
      "Add to project",
      "Skills",
      "Add connector",
      "Add plugins",
      "Research",
      "Web search",
    ]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    expect(screen.getByText("⌘U")).toBeTruthy();
    // the one tick, on by default and never a colour
    expect(screen.getByLabelText("Web search on")).toBeTruthy();
  });

  it("swaps the tab row to Routines", async () => {
    pane();

    // exact: "All Routines" is the link beside it, not a third tab
    fireEvent.click(screen.getByRole("button", { name: "Routines" }));

    expect(await screen.findByText("Weekly research digest")).toBeTruthy();
    expect(screen.getByText("Every Monday 9AM")).toBeTruthy();
    // one routine, two holes
    expect(document.querySelectorAll('[data-slot="empty"]')).toHaveLength(2);
  });

  it("hides every native scrollbar it makes", () => {
    pane();
    const field = document.querySelector("textarea") as HTMLElement;
    const cards = document.querySelector('[data-ai="home-cards"]')?.parentElement as HTMLElement;
    expect(field.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(cards.className).toContain("[&::-webkit-scrollbar]:hidden");
  });
});

describe("AiPane motion", () => {
  const pane = () => {
    const { container } = render(<AiPane />);
    return container.querySelector('[data-region="ai-pane"]') as HTMLElement;
  };
  const send = (text: string) => {
    const field = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key: "Enter" });
    return field;
  };

  beforeEach(() => {
    __resetAgentStore();
    vi.restoreAllMocks();
  });

  it("brings the thread in as a body and pops each bubble", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(new TextEncoder().encode('event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n'), { status: 200 }),
    ));
    pane();
    send("hello");

    const list = await waitFor(() => {
      const el = document.querySelector('[data-ai="thread-list"]');
      if (!el) throw new Error("no thread yet");
      return el as HTMLElement;
    });
    // the thread arrives as one body, on the same numbers as the panes
    expect(bodyVariants.initial).toEqual({ opacity: 0, y: SHIFT.body });
    expect(timing(DURATION.move, false).duration).toBe(DURATION.move);
    // and each turn pops rather than sliding
    expect(popVariants.initial).toEqual({ opacity: 0, scale: POP_SCALE });
    expect(timing(DURATION.section, false).duration).toBe(DURATION.section);
    expect(list.querySelectorAll("[data-role]").length).toBeGreaterThan(0);
  });

  it("keeps the shimmer on a turn that has no text yet", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      new Promise((resolve) => {
        release = () => resolve(new Response(new TextEncoder().encode("event: done\ndata: {}\n\n"), { status: 200 }));
      }),
    ));
    pane();
    send("hello");
    const pending = await waitFor(() => {
      const el = document.querySelector('[data-ai="pending"]');
      if (!el) throw new Error("no shimmer");
      return el as HTMLElement;
    });
    expect(pending.querySelectorAll("span")).toHaveLength(3);
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
  });
});
