import { beforeEach, describe, expect, it } from "vitest";

import { FIGURE_CHROME_SCRIPT, FIGURE_CHROME_STYLE, figureChrome } from "@/server/visualize/figure-chrome";
import { whiteFigure } from "@/server/visualize/white-figure";

const PAGE = `<!doctype html><html><head><title>Bell</title></head><body class="iso" data-theme="light"><main class="iso-page"><figure class="iso-figure"><div class="iso-plate"><svg viewBox="0 0 100 100">
<g data-part="Dome" data-part-info="Rings when the clappers strike its rim."><circle cx="30" cy="30" r="20"/></g>
<g data-part="Lever" data-part-info="Your thumb pushes it to spin the gears."><rect x="60" y="60" width="20" height="10"/></g>
<g data-part="hook"><rect x="0" y="0" width="1" height="1"/></g>
</svg></div></figure></main></body></html>`;

const CODE = FIGURE_CHROME_SCRIPT.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");

/** the page's body in this test document, then the chrome script run in it (the document is already loaded) */
function load(html: string, runs = 1) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.replaceWith(document.importNode(parsed.body, true));
  for (let i = 0; i < runs; i++) window.eval(CODE);
  return { win: window, doc: document };
}

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__arChrome;
  document.querySelectorAll(".ar-chrome").forEach((el) => el.remove());
});

describe("figureChrome", () => {
  it("puts the style just before </head> and the script just before the last </body>", () => {
    const out = figureChrome("<html><head><title>x</title></head><body>hi</body></html>");
    expect(out).toBe(`<html><head><title>x</title>${FIGURE_CHROME_STYLE}</head><body>hi${FIGURE_CHROME_SCRIPT}</body></html>`);
    // the kit inlines its own source, which contains a literal </body>, inside the page's script
    const tricky = '<html><head></head><body><script>const t = "</body>";</script></body></html>';
    expect(figureChrome(tricky).endsWith(`${FIGURE_CHROME_SCRIPT}</body></html>`)).toBe(true);
  });

  it("works on a page with no head or body", () => {
    expect(figureChrome("<svg></svg>")).toBe(`${FIGURE_CHROME_STYLE}<svg></svg>${FIGURE_CHROME_SCRIPT}`);
  });

  it("is idempotent, and composes with whiteFigure", () => {
    const once = figureChrome(whiteFigure(PAGE));
    expect(figureChrome(once)).toBe(once);
    expect(once.match(/data-agent-research="chrome"/g)).toHaveLength(2);
    expect(once).toContain('data-agent-research="white"');
  });

  it("is inline only and CSP-safe: no external sources, no eval, no network", () => {
    for (const piece of [FIGURE_CHROME_STYLE, FIGURE_CHROME_SCRIPT]) {
      expect(piece).not.toMatch(/\bsrc=|\bhref=|@import|url\(/);
      expect(piece).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|eval|Function|import|require|innerHTML)\b\s*\(?/);
    }
    // nothing in the script can close its own tag early
    expect(FIGURE_CHROME_SCRIPT.slice(0, -"</script>".length)).not.toMatch(/<\/script/i);
  });

  it("removes the card's frame, fills the window and hides the text below the card", () => {
    const plate = FIGURE_CHROME_STYLE.match(/\.iso-plate\{[^}]*\}/)![0];
    expect(plate).toContain("box-shadow:none!important");
    expect(plate).toContain("border:0!important");
    expect(plate).toContain("background:#fff!important");
    expect(FIGURE_CHROME_STYLE).toMatch(/html,body\{height:100%;margin:0!important;padding:0!important;overflow:hidden!important/);
    expect(FIGURE_CHROME_STYLE).toMatch(/\.iso-page\{position:fixed!important/);
    // the legend row and anything after the card go; the card's own corner texts (hint, readout) stay
    expect(FIGURE_CHROME_STYLE).toContain(".iso-page>:not(.iso-figure):not(style):not(script),.iso-figure~.iso-figure,.iso-legend{display:none!important}");
    expect(FIGURE_CHROME_STYLE).not.toMatch(/iso-plate-corner[^{]*\{[^}]*display:none/);
  });
});

describe("the figure chrome in the page", () => {
  it("lists every marked part, syncs hover both ways, pins on click and dispatches ar:explode", () => {
    const { win, doc } = load(PAGE);
    const dome = doc.querySelector('[data-part="Dome"]')!;
    const lever = doc.querySelector('[data-part="Lever"]')!;

    // the parts list: both marked parts, not the bare data-part hook
    const items = [...doc.querySelectorAll<HTMLButtonElement>(".ar-parts button")];
    expect(items.map((b) => b.querySelector(".ar-n")!.textContent)).toEqual(["Dome", "Lever"]);
    expect(items[0].querySelector(".ar-d")!.textContent).toBe("Rings when the clappers strike its rim.");
    expect(doc.querySelector(".ar-parts h2")!.textContent).toBe("Parts2");
    expect(doc.body.classList.contains("ar-has-parts")).toBe(true);

    // hovering the drawing greys the part, lights its list item and shows the tooltip
    dome.querySelector("circle")!.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true, clientX: 30, clientY: 30 }));
    expect(dome.hasAttribute("data-ar-hot")).toBe(true);
    expect(items[0].hasAttribute("data-ar-hot")).toBe(true);
    const tip = doc.querySelector(".ar-tip")!;
    expect(tip.hasAttribute("data-on")).toBe(true);
    expect(tip.querySelector("b")!.textContent).toBe("Dome");
    expect(tip.querySelector("span")!.textContent).toBe("Rings when the clappers strike its rim.");
    dome.querySelector("circle")!.dispatchEvent(new win.MouseEvent("pointerout", { bubbles: true, relatedTarget: doc.body }));
    expect(dome.hasAttribute("data-ar-hot")).toBe(false);
    expect(tip.hasAttribute("data-on")).toBe(false);

    // hovering a list item greys the part in the drawing
    items[1].dispatchEvent(new win.Event("pointerenter"));
    expect(lever.hasAttribute("data-ar-hot")).toBe(true);
    expect(items[1].hasAttribute("data-ar-hot")).toBe(true);
    expect(dome.hasAttribute("data-ar-hot")).toBe(false);
    expect(tip.querySelector("b")!.textContent).toBe("Lever");
    items[1].dispatchEvent(new win.Event("pointerleave"));
    expect(lever.hasAttribute("data-ar-hot")).toBe(false);

    // a click pins it past the pointer leaving; Escape lets go
    items[1].click();
    items[1].dispatchEvent(new win.Event("pointerleave"));
    expect(items[1].getAttribute("aria-pressed")).toBe("true");
    expect(lever.hasAttribute("data-ar-hot")).toBe(true);
    expect(tip.hasAttribute("data-on")).toBe(true);
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(lever.hasAttribute("data-ar-hot")).toBe(false);
    expect(items[1].getAttribute("aria-pressed")).toBe("false");

    // Expand / Collapse dispatch ar:explode
    const seen: boolean[] = [];
    win.addEventListener("ar:explode", (event: Event) => seen.push((event as CustomEvent<{ exploded: boolean }>).detail.exploded));
    const expand = doc.querySelector<HTMLButtonElement>(".ar-expand")!;
    expect(expand.textContent).toBe("Expand");
    expand.click();
    expect(expand.textContent).toBe("Collapse");
    expect(expand.getAttribute("aria-pressed")).toBe("true");
    expand.click();
    expect(expand.textContent).toBe("Expand");
    expect(seen).toEqual([true, false]);
  });

  it("pans and zooms the drawing, and resets on Reset view or a double-click on empty space", () => {
    const { win, doc } = load(PAGE);
    const view = (win as unknown as { __arView: { get(): { scale: number; x: number; y: number }; zoom(f: number, x: number, y: number): void } }).__arView;
    const drawing = doc.querySelector<SVGSVGElement>(".iso-plate > svg")!;
    const reset = doc.querySelector<HTMLButtonElement>(".ar-bar .ar-reset")!;
    expect(drawing.hasAttribute("data-ar-view")).toBe(true);
    expect(reset.hidden).toBe(true);

    view.zoom(2, 0, 0);
    expect(view.get().scale).toBe(2);
    expect(drawing.style.transform).toBe("translate(0.00px, 0.00px) scale(2.0000)");
    expect(reset.hidden).toBe(false);
    view.zoom(100, 0, 0);
    expect(view.get().scale).toBe(6);
    view.zoom(0.001, 0, 0);
    expect(view.get().scale).toBe(0.5);

    // zooming keeps the point under the pointer still
    reset.click();
    view.zoom(2, 50, 40);
    expect(view.get()).toEqual({ scale: 2, x: -50, y: -40 });

    // a wheel turn zooms in (reduced motion would jump; here it eases toward the goal)
    const plate = doc.querySelector(".iso-plate")!;
    const wheel = new win.WheelEvent("wheel", { deltaY: -100, clientX: 0, clientY: 0, bubbles: true, cancelable: true });
    plate.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(view.get().scale).toBeGreaterThan(2);

    // a double-click on a part does nothing; on empty space it resets
    doc.querySelector('[data-part="Dome"] circle')!.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    expect(view.get().scale).toBeGreaterThan(2);
    plate.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
    expect(view.get()).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("adds no Expand button or panel when the figure has no marked parts, and runs once", () => {
    const bare = PAGE.replace(/ data-part-info="[^"]*"/g, "");
    const { doc } = load(bare);
    expect(doc.querySelector(".ar-expand")).toBeNull();
    // pan and zoom still work on every figure
    expect(doc.querySelector(".ar-bar .ar-reset")).not.toBeNull();
    expect(doc.querySelector(".ar-parts")).toBeNull();
    expect(doc.body.classList.contains("ar-has-parts")).toBe(false);

    // the script twice in one page still makes one set of chrome
    delete (window as unknown as Record<string, unknown>).__arChrome;
    const again = load(PAGE, 2).doc;
    expect(again.querySelectorAll(".ar-parts")).toHaveLength(1);
    expect(again.querySelectorAll(".ar-bar")).toHaveLength(1);
  });
});
