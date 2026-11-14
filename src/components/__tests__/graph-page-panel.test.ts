import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIT_FILL,
  MAX_PAGES,
  PAGE_FAR,
  PAGE_NEAR,
  PANEL_HEIGHT,
  PANEL_SCALE,
  PANEL_WIDTH,
  __clearEmbedAnswers,
  checkEmbeddable,
  closePage,
  createDeck,
  createPanel,
  fitDistance,
  openPages,
  pinPage,
  touchPage,
  updateNearby,
} from "@/components/graph-page-panel";

const at = (id: string, distance: number, inView = true) => ({ id, distance, inView });

describe("the deck of open pages", () => {
  it("opens the nearest unpinned pages in view within PAGE_NEAR, and keeps them to PAGE_FAR", () => {
    const deck = createDeck();
    updateNearby(deck, [at("a", PAGE_NEAR + 1), at("b", 40), at("c", 20, false)], 0);
    expect(openPages(deck)).toEqual(["b"]);
    updateNearby(deck, [at("b", (PAGE_NEAR + PAGE_FAR) / 2)], 1);
    expect(openPages(deck)).toEqual(["b"]);
    updateNearby(deck, [at("b", PAGE_FAR + 1)], 2);
    expect(openPages(deck)).toEqual([]);
    updateNearby(deck, [at("b", 50, false)], 3);
    expect(openPages(deck)).toEqual([]);
  });

  it("opens nothing new mid-flight", () => {
    const deck = createDeck();
    updateNearby(deck, [at("a", 30)], 0, false);
    expect(openPages(deck)).toEqual([]);
  });

  it("keeps pinned pages open wherever the camera goes, earlier pins included", () => {
    const deck = createDeck();
    pinPage(deck, "a");
    pinPage(deck, "b");
    pinPage(deck, "c");
    updateNearby(deck, [at("a", 5000), at("b", 40, false), at("c", 10)], 0);
    expect(openPages(deck)).toEqual(["a", "b", "c"]);
    expect(deck.pins).toEqual(["a", "b", "c"]);
  });

  it(`caps the open pages at ${MAX_PAGES}: the least-recently-used nearby page goes first`, () => {
    const deck = createDeck();
    const near = [at("n1", 30), at("n2", 35), at("n3", 40), at("n4", 45), at("p", 3000), at("q", 3000)];
    updateNearby(deck, near, 0);
    expect(openPages(deck)).toEqual(["n1", "n2", "n3", "n4"]);
    touchPage(deck, "n1", 10); // n1 is in use: n2 is now the least recent
    pinPage(deck, "p");
    expect(openPages(deck)).toEqual(["p", "n1", "n3", "n4"]);
    // evicted, it stays closed while the camera is still near it
    updateNearby(deck, near, 20);
    expect(openPages(deck)).toHaveLength(MAX_PAGES);
    expect(openPages(deck)).not.toContain("n2");
    pinPage(deck, "q");
    expect(openPages(deck)).toEqual(["p", "q", "n1", "n4"]);
  });

  it("drops the oldest pin when every slot is pinned", () => {
    const deck = createDeck();
    for (const id of ["a", "b", "c", "d", "e"]) pinPage(deck, id);
    expect(openPages(deck)).toEqual(["b", "c", "d", "e"]);
    // clicking a pinned page again makes it the newest pin
    pinPage(deck, "b");
    pinPage(deck, "f");
    expect(openPages(deck)).toEqual(["d", "e", "b", "f"]);
  });

  it("a nearer newcomer replaces the least-recently-used nearby page only when clearly nearer", () => {
    const deck = createDeck();
    for (const id of ["a", "b", "c"]) pinPage(deck, id);
    updateNearby(deck, [at("a", 9e3), at("b", 9e3), at("c", 9e3), at("far", 65)], 0);
    expect(openPages(deck)).toContain("far");
    updateNearby(deck, [at("a", 9e3), at("b", 9e3), at("c", 9e3), at("far", 65), at("close", 62)], 1);
    expect(openPages(deck)).toContain("far"); // 62 is not clearly nearer than 65
    updateNearby(deck, [at("a", 9e3), at("b", 9e3), at("c", 9e3), at("far", 65), at("close", 25)], 2);
    expect(openPages(deck)).toEqual(["a", "b", "c", "close"]);
  });

  it("closing one page leaves the rest, and it reopens by proximity only once left behind", () => {
    const deck = createDeck();
    pinPage(deck, "a");
    updateNearby(deck, [at("a", 9e3), at("b", 30), at("c", 40)], 0);
    expect(openPages(deck)).toEqual(["a", "b", "c"]);
    closePage(deck, "b");
    closePage(deck, "a");
    updateNearby(deck, [at("a", 30), at("b", 30), at("c", 40)], 1);
    expect(openPages(deck)).toEqual(["c"]);
    updateNearby(deck, [at("a", PAGE_FAR + 1), at("b", PAGE_FAR + 1), at("c", 40)], 2);
    updateNearby(deck, [at("a", 30), at("b", 30), at("c", 40)], 3);
    expect(openPages(deck).sort()).toEqual(["a", "b", "c"]);
  });

  it("drops pages that left the graph", () => {
    const deck = createDeck();
    pinPage(deck, "a");
    updateNearby(deck, [], 0);
    expect(openPages(deck)).toEqual([]);
  });
});

describe("fitDistance", () => {
  it("parks the camera where the panel fills FIT_FILL of the limiting side", () => {
    const fov = 50;
    const visible = (d: number) => 2 * d * Math.tan((fov * Math.PI) / 360);
    const tall = fitDistance(fov, 2); // a wide view: height limits
    expect((PANEL_HEIGHT * PANEL_SCALE) / visible(tall)).toBeCloseTo(FIT_FILL);
    const narrow = fitDistance(fov, 0.6); // a narrow view: width limits
    expect((PANEL_WIDTH * PANEL_SCALE) / (visible(narrow) * 0.6)).toBeCloseTo(FIT_FILL);
    // close enough to open the page
    expect(tall).toBeLessThan(PAGE_NEAR);
  });
});

describe("createPanel", () => {
  const page = { id: "p", url: "https://example.com/a", title: "<b>Example</b>", host: "example.com" };

  it("puts page text in as text, and keeps the graph's pointer handling out", () => {
    const panel = createPanel(page, { onClose: () => {} });
    expect(panel.element.querySelector("b")).toBeNull();
    expect(panel.element.textContent).toContain("<b>Example</b>");
    const outer = vi.fn();
    const wrap = document.createElement("div");
    wrap.addEventListener("pointerdown", outer);
    wrap.append(panel.element);
    panel.element.querySelector("span")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(outer).not.toHaveBeenCalled();
  });

  it("swaps checking → live page, or → card", () => {
    const live = createPanel(page, { onClose: () => {} });
    expect(live.element.dataset.state).toBe("checking");
    expect(live.element.querySelector("iframe")).toBeNull();
    live.setState("page");
    expect(live.element.querySelector("iframe")?.getAttribute("src")).toBe(page.url);

    const card = createPanel(page, { onClose: () => {} });
    card.setState("card", "The site's X-Frame-Options (DENY) forbids embedding");
    expect(card.element.querySelector("iframe")).toBeNull();
    expect(card.element.querySelector("[data-panel-card]")?.textContent).toContain("forbids embedding.");
  });

  it("forwards wheel over its own chrome to the graph, and closes from its button", () => {
    const forwardWheel = vi.fn();
    const onClose = vi.fn();
    const panel = createPanel(page, { onClose, forwardWheel });
    panel.element.querySelector("[data-panel-card]")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 }));
    expect(forwardWheel).toHaveBeenCalledTimes(1);
    panel.element.querySelector<HTMLButtonElement>("[data-panel-close]")!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is a 640×420 page under a 32px header in a 4px frame, and reports the pointer entering and leaving", () => {
    expect([PANEL_WIDTH, PANEL_HEIGHT]).toEqual([648, 456]);
    const onHover = vi.fn();
    const panel = createPanel(page, { onClose: () => {}, onHover });
    expect(panel.element.style.width).toBe("648px");
    expect(panel.element.querySelector<HTMLElement>("[data-panel-card]")!.parentElement!.style.width).toBe("640px");
    expect(panel.element.style.pointerEvents).toBe("auto");
    panel.element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(onHover).toHaveBeenLastCalledWith(true);
    panel.setLive(true);
    expect(panel.element.dataset.live).toBe("");
    panel.element.dispatchEvent(new PointerEvent("pointerleave"));
    expect(onHover).toHaveBeenLastCalledWith(false);
    panel.setLive(false);
    expect(panel.element.dataset.live).toBeUndefined();
    panel.setState("page");
    expect(panel.element.querySelector("iframe")!.style.pointerEvents).toBe("auto");
  });
});

describe("checkEmbeddable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __clearEmbedAnswers();
  });

  it("asks the route once per page, and treats a failed check as not embeddable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ embeddable: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkEmbeddable("https://a.com")).toEqual({ embeddable: true });
    expect(await checkEmbeddable("https://a.com")).toEqual({ embeddable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect((await checkEmbeddable("https://b.com")).embeddable).toBe(false);
    // not remembered: the next look asks again
    fetchMock.mockResolvedValueOnce(Response.json({ embeddable: true }));
    expect(await checkEmbeddable("https://b.com")).toEqual({ embeddable: true });
  });
});
