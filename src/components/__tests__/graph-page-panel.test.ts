import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIT_FILL,
  PAGE_FAR,
  PAGE_NEAR,
  PANEL_HEIGHT,
  PANEL_SCALE,
  PANEL_WIDTH,
  __clearEmbedAnswers,
  checkEmbeddable,
  createPanel,
  fitDistance,
  pickPage,
} from "@/components/graph-page-panel";

const at = (id: string, distance: number, inView = true) => ({ id, distance, inView });

describe("pickPage", () => {
  it("opens the nearest page in view within PAGE_NEAR", () => {
    expect(pickPage([at("a", PAGE_NEAR + 1)], null)).toBeNull();
    expect(pickPage([at("a", 120), at("b", 90), at("c", 40, false)], null)).toBe("b");
  });

  it("keeps the open page until it passes PAGE_FAR or leaves the view", () => {
    expect(pickPage([at("a", (PAGE_NEAR + PAGE_FAR) / 2)], "a")).toBe("a");
    expect(pickPage([at("a", PAGE_FAR + 1)], "a")).toBeNull();
    expect(pickPage([at("a", 50, false)], "a")).toBeNull();
  });

  it("gives a clicked (pinned) page the panel over a nearer neighbour", () => {
    const near = [at("clicked", 80), at("between", 40)];
    expect(pickPage(near, null)).toBe("between");
    expect(pickPage(near, null, "clicked")).toBe("clicked");
    expect(pickPage(near, "between", "clicked")).toBe("clicked");
    // still flying in: nothing opens on the way
    expect(pickPage([at("clicked", 600), at("between", 40)], null, "clicked")).toBeNull();
    // open, it holds to PAGE_FAR, then lets go
    expect(pickPage([at("clicked", PAGE_FAR - 1)], "clicked", "clicked")).toBe("clicked");
    expect(pickPage([at("clicked", PAGE_FAR + 1)], "clicked", "clicked")).toBeNull();
  });

  it("switches only to a page clearly nearer than the open one", () => {
    expect(pickPage([at("a", 100), at("b", 95)], "a")).toBe("a");
    expect(pickPage([at("a", 100), at("b", 80)], "a")).toBe("b");
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
