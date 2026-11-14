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

  it("removes the card's frame", () => {
    expect(FIGURE_CHROME_STYLE).toMatch(/\.iso-plate\{box-shadow:none!important;border:0!important/);
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

  it("adds no button or panel when the figure has no marked parts, and runs once", () => {
    const bare = PAGE.replace(/ data-part-info="[^"]*"/g, "");
    const { doc } = load(bare);
    expect(doc.querySelector(".ar-expand")).toBeNull();
    expect(doc.querySelector(".ar-parts")).toBeNull();
    expect(doc.body.classList.contains("ar-has-parts")).toBe(false);

    // the script twice in one page still makes one set of chrome
    delete (window as unknown as Record<string, unknown>).__arChrome;
    expect(load(PAGE, 2).doc.querySelectorAll(".ar-parts")).toHaveLength(1);
  });
});
