/**
 * The app's own chrome on every served figure, on top of the agent's page:
 *
 *   - the figure fills the window: no page margins, no scroll, the kit's card
 *     (`.iso-plate`) white with no outline or shadow, and the drawing scaled to
 *     fit what is left beside the Parts panel, centred. The card's corner
 *     texts (title, interaction hint, live readout) stay; the legend row and
 *     any text below the card are hidden;
 *   - an "Expand" / "Collapse" pill at the top left that dispatches
 *     `window` event `ar:explode` with `detail: { exploded }`, which the
 *     figure answers by moving its parts apart (the figure contract in
 *     agent.ts);
 *   - hovering a part (`[data-part][data-part-info]`) turns it grey and shows
 *     a tooltip with its name and what it does;
 *   - a "Parts" panel at the right listing every part, its hover synced both
 *     ways with the drawing; clicking an item pins it (Escape or a second
 *     click unpins).
 *
 * The button and the panel only appear when the figure has marked parts (a
 * figure built before the contract has no names or descriptions to show, so
 * it gets the full-window frameless layout only). Everything is an inline
 * <style> and an inline classic <script> (the figure CSP allows only inline),
 * with no network and no eval; text goes in through textContent.
 */

const MARK = 'data-agent-research="chrome"';

const CSS = `
html,body{height:100%;margin:0!important;padding:0!important;overflow:hidden!important;background:#fff!important}
.iso-page{position:fixed!important;top:var(--ar-top,0px);right:var(--ar-right,0px);bottom:var(--ar-bottom,0px);left:0;width:auto!important;max-width:none!important;margin:0!important;display:flex;flex-direction:column}
.iso-page>:not(.iso-figure):not(style):not(script),.iso-figure~.iso-figure,.iso-legend{display:none!important}
.iso-figure{flex:1 1 auto;min-height:0;margin:0!important;display:flex;flex-direction:column}
.iso-plate{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;padding:44px 20px!important;background:#fff!important;box-shadow:none!important;border:0!important;outline:0!important;border-radius:0!important}
.iso-plate>*{flex:none;max-width:100%}
[data-part-info]{transition:filter .18s cubic-bezier(.32,.72,0,1)}
[data-part-info][data-ar-hot]{filter:grayscale(1) brightness(.8) contrast(.92)}
.ar-chrome{font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181a;-webkit-font-smoothing:antialiased}
.ar-bar{position:fixed;top:12px;left:16px;z-index:20;display:flex;gap:8px}
.ar-pill{height:28px;padding:0 12px;border:1px solid #E1E2E3;border-radius:999px;background:#fff;color:#18181a;font-size:12.5px;font-weight:500;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:background-color .15s ease,transform .15s cubic-bezier(.32,.72,0,1)}
.ar-pill:hover{background:#F4F4F5}
.ar-pill:active{transform:scale(.97)}
.ar-pill[hidden]{display:none}
.iso-plate{overflow:hidden!important;touch-action:none}
html[data-ar-panning],html[data-ar-panning] *{cursor:grabbing!important;user-select:none!important}
.ar-pill:focus-visible,.ar-parts button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.ar-parts{position:fixed;top:16px;right:16px;z-index:20;width:224px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;border:1px solid #E1E2E3;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 16px -4px rgba(0,0,0,.06)}
.ar-parts h2{margin:0;padding:12px 14px 6px;font-size:13px;font-weight:600;letter-spacing:0}
.ar-parts h2 span{margin-left:6px;color:#8c8c90;font-weight:400;font-variant-numeric:tabular-nums}
.ar-parts ol{list-style:none;margin:0;padding:2px 6px 8px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;--ar-ft:0px;--ar-fb:0px;-webkit-mask-image:linear-gradient(to bottom,transparent,#000 var(--ar-ft),#000 calc(100% - var(--ar-fb)),transparent);mask-image:linear-gradient(to bottom,transparent,#000 var(--ar-ft),#000 calc(100% - var(--ar-fb)),transparent)}
.ar-parts ol::-webkit-scrollbar{display:none}
.ar-parts button{display:grid;grid-template-columns:18px 1fr;column-gap:6px;width:100%;margin:0;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.ar-parts button[data-ar-hot]{background:#F1F1F2}
.ar-parts button[aria-pressed="true"]{background:#E9E9EB}
.ar-parts .ar-i{color:#8c8c90;font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums}
.ar-parts .ar-n{font-weight:500;line-height:18px}
.ar-parts .ar-d{grid-column:2;color:#8c8c90;font-size:12px;line-height:1.35;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ar-tip{position:fixed;left:0;top:0;z-index:30;max-width:240px;padding:8px 10px;background:#fff;border:1px solid #E1E2E3;border-radius:8px;box-shadow:0 4px 14px -2px rgba(0,0,0,.1);pointer-events:none;opacity:0;transition:opacity .12s ease}
.ar-tip[data-on]{opacity:1}
.ar-tip b{display:block;font-weight:600;margin-bottom:2px}
.ar-tip span{display:block;color:#57575a;font-size:12.5px}
@media (max-width:639px){.ar-parts{top:auto;left:16px;bottom:16px;width:auto;max-height:36vh}}
@media (prefers-reduced-motion:reduce){[data-part-info],.ar-pill,.ar-parts button,.ar-tip{transition:none!important}}
`.trim();

/** runs in the figure's page; plain ES2017, no modules, no network */
function chrome() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__arChrome) return;
  w.__arChrome = true;

  type Part = { name: string; info: string; index: number; button: HTMLButtonElement };

  const init = () => {
    const marked = Array.from(document.querySelectorAll<Element>("[data-part][data-part-info]"));
    const parts: Part[] = [];
    const byName = new Map<string, Part>();
    for (const el of marked) {
      const name = (el.getAttribute("data-part") || "").trim();
      if (!name || byName.has(name)) continue;
      const part = { name, info: (el.getAttribute("data-part-info") || "").trim(), index: parts.length } as Part;
      parts.push(part);
      byName.set(name, part);
    }
    const bar = document.createElement("div");
    bar.className = "ar-chrome ar-bar";
    document.body.appendChild(bar);
    if (!parts.length) {
      layout(bar, null, () => {});
      return;
    }

    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const elsOf = (part: Part) =>
      Array.from(document.querySelectorAll<Element>("[data-part][data-part-info]")).filter(
        (el) => (el.getAttribute("data-part") || "").trim() === part.name,
      );

    // the Expand pill
    const expand = make("button", "ar-pill ar-expand", "Expand");
    expand.type = "button";
    expand.setAttribute("aria-pressed", "false");
    expand.setAttribute("data-ar-expand", "");
    let exploded = false;
    expand.addEventListener("click", () => {
      exploded = !exploded;
      expand.textContent = exploded ? "Collapse" : "Expand";
      expand.setAttribute("aria-pressed", String(exploded));
      document.documentElement.toggleAttribute("data-ar-exploded", exploded);
      window.dispatchEvent(new CustomEvent("ar:explode", { detail: { exploded } }));
      follow(1400);
    });

    // the Parts panel
    const panel = make("aside", "ar-chrome ar-parts");
    panel.setAttribute("aria-label", "Parts");
    const title = make("h2", undefined, "Parts");
    title.appendChild(make("span", undefined, String(parts.length)));
    const list = make("ol");
    for (const part of parts) {
      const li = make("li");
      const button = make("button");
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("data-ar-part", part.name);
      button.appendChild(make("span", "ar-i", String(part.index + 1)));
      button.appendChild(make("span", "ar-n", part.name));
      if (part.info) {
        const d = make("span", "ar-d", part.info);
        d.title = part.info;
        button.appendChild(d);
      }
      button.addEventListener("pointerenter", () => setHover(part, null));
      button.addEventListener("pointerleave", () => setHover(null, null));
      button.addEventListener("focus", () => setHover(part, null));
      button.addEventListener("blur", () => setHover(null, null));
      button.addEventListener("click", () => setPinned(pinned === part ? null : part));
      part.button = button;
      li.appendChild(button);
      list.appendChild(li);
    }
    panel.appendChild(title);
    panel.appendChild(list);

    const fade = () => {
      const top = list.scrollTop > 1;
      const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
      list.style.setProperty("--ar-ft", top ? "20px" : "0px");
      list.style.setProperty("--ar-fb", bottom ? "20px" : "0px");
    };
    list.addEventListener("scroll", fade, { passive: true });
    window.addEventListener("resize", fade);

    // the tooltip
    const tip = make("div", "ar-chrome ar-tip");
    tip.setAttribute("role", "tooltip");
    const tipName = make("b");
    const tipInfo = make("span");
    tip.appendChild(tipName);
    tip.appendChild(tipInfo);

    bar.appendChild(expand);
    document.body.appendChild(panel);
    document.body.appendChild(tip);
    document.body.classList.add("ar-has-parts");
    fade();
    layout(bar, panel, () => {
      if (shown && !(pointer && shown === hover)) place();
    });

    let hover: Part | null = null;
    let pinned: Part | null = null;
    let pointer: [number, number] | null = null;
    let shown: Part | null = null;

    const mark = (part: Part, on: boolean) => {
      for (const el of elsOf(part)) el.toggleAttribute("data-ar-hot", on);
      part.button.toggleAttribute("data-ar-hot", on);
    };

    const place = () => {
      if (!shown) return;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x: number;
      let y: number;
      if (pointer && shown === hover) {
        x = pointer[0] + 14;
        y = pointer[1] + 16;
        if (x + tw > vw - 8) x = pointer[0] - tw - 14;
        if (y + th > vh - 8) y = pointer[1] - th - 12;
      } else {
        // anchored to the part itself: above its box, or below when there is no room
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const el of elsOf(shown)) {
          const box = el.getBoundingClientRect();
          if (!box.width && !box.height) continue;
          l = Math.min(l, box.left); t = Math.min(t, box.top); r = Math.max(r, box.right); b = Math.max(b, box.bottom);
        }
        if (l === Infinity) { l = r = vw / 2; t = b = vh / 2; }
        x = (l + r) / 2 - tw / 2;
        y = t - th - 10;
        if (y < 8) y = b + 10;
      }
      x = Math.max(8, Math.min(x, vw - tw - 8));
      y = Math.max(8, Math.min(y, vh - th - 8));
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };

    const show = () => {
      const next = hover || pinned;
      if (next !== shown) {
        if (shown) mark(shown, false);
        shown = next;
        if (shown) mark(shown, true);
      }
      for (const part of parts) part.button.setAttribute("aria-pressed", String(part === pinned));
      if (!shown) {
        tip.removeAttribute("data-on");
        return;
      }
      tipName.textContent = shown.name;
      tipInfo.textContent = shown.info;
      tipInfo.hidden = !shown.info;
      tip.setAttribute("data-on", "");
      place();
    };

    // keep a hovered list item in view without scrolling the page itself
    const reveal = (part: Part) => {
      const item = part.button;
      const top = item.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top - 8;
      else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + item.offsetHeight - list.clientHeight + 8;
    };

    function setHover(part: Part | null, at: [number, number] | null) {
      hover = part;
      pointer = at;
      show();
    }
    function setPinned(part: Part | null) {
      pinned = part;
      show();
    }

    // while parts glide apart or back, a tooltip anchored to a part follows it
    let until = 0;
    let frame = 0;
    const step = () => {
      frame = 0;
      if (shown && !(pointer && shown === hover)) place();
      if (performance.now() < until) frame = requestAnimationFrame(step);
    };
    function follow(ms: number) {
      until = performance.now() + ms;
      if (!frame) frame = requestAnimationFrame(step);
    }

    const partAt = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest("[data-part][data-part-info]") : null;
      if (!el || panel.contains(el)) return null;
      return byName.get((el.getAttribute("data-part") || "").trim()) || null;
    };
    document.addEventListener("pointerover", (event) => {
      const part = partAt(event.target);
      if (part) {
        setHover(part, [event.clientX, event.clientY]);
        reveal(part);
      }
    });
    document.addEventListener("pointermove", (event) => {
      if (hover && pointer) {
        pointer = [event.clientX, event.clientY];
        place();
      }
    }, { passive: true });
    document.addEventListener("pointerout", (event) => {
      if (!hover || !pointer) return;
      if (partAt(event.relatedTarget) !== hover) setHover(null, null);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && pinned) setPinned(null);
    });
    window.addEventListener("scroll", () => place(), { passive: true });
    window.addEventListener("resize", () => place());
  };

  /**
   * The figure fills the window: the page sits between the Expand pill, the
   * Parts panel and the window's edges, and the drawing (the card's child
   * that holds its SVG) is sized to the largest width at which it still fits
   * the card's height. Only its width changes, as when the window narrows,
   * so the figure's own layers and pointer maths keep working.
   */
  function layout(bar: HTMLElement, panel: HTMLElement | null, moved: () => void) {
    const root = document.documentElement;
    const plate = document.querySelector<HTMLElement>(".iso-plate");
    const drawing = plate
      ? (Array.from(plate.children).find(
          (child) => !child.classList.contains("iso-plate-corners") && (child.tagName.toLowerCase() === "svg" || child.querySelector("svg")),
        ) as HTMLElement | undefined)
      : undefined;
    const fit = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let right = 0;
      let bottom = 0;
      if (panel) {
        const box = panel.getBoundingClientRect();
        if (vw >= 640) right = Math.max(0, vw - box.left + 8);
        else bottom = Math.max(0, vh - box.top + 8);
      }
      root.style.setProperty("--ar-top", "48px");
      root.style.setProperty("--ar-right", `${Math.round(right)}px`);
      root.style.setProperty("--ar-bottom", `${Math.round(bottom)}px`);
      if (!plate || !drawing) return;
      const style = getComputedStyle(plate);
      const across = plate.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const down = plate.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (across <= 0 || down <= 0) return;
      drawing.style.width = `${Math.floor(across)}px`;
      const tall = drawing.offsetHeight || drawing.getBoundingClientRect().height;
      const width = tall > down ? (across * down) / tall : across;
      drawing.style.width = `${Math.floor(width)}px`;
      drawing.style.margin = "0";
    };
    fit();
    let pending = 0;
    window.addEventListener("resize", () => {
      if (!pending) pending = requestAnimationFrame(() => {
        pending = 0;
        fit();
      });
    });
    // once more after the first paint, when fonts and the panel have settled
    requestAnimationFrame(() => fit());
    if (plate && drawing) panZoom(plate, drawing, bar, moved);
  }

  /**
   * Move around the drawing: the wheel (or a trackpad pinch) zooms toward the
   * pointer, 0.5x to 6x; a drag on empty space (anywhere once zoomed in) pans
   * after the pointer has moved 4px, so a click still reaches the figure;
   * double-click on empty space or "Reset view" goes back. It is one CSS
   * transform on the drawing's own box, so hit-testing, getBoundingClientRect
   * and the figure's pointer maths all see the moved drawing. Eased; instant
   * under reduced motion.
   */
  function panZoom(plate: HTMLElement, drawing: HTMLElement, bar: HTMLElement, moved: () => void) {
    const MIN = 0.5;
    const MAX = 6;
    const SLOP = 4;
    const still = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const now = { s: 1, x: 0, y: 0 };
    const goal = { s: 1, x: 0, y: 0 };
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "ar-pill ar-reset";
    reset.textContent = "Reset view";
    reset.hidden = true;
    reset.setAttribute("data-ar-reset", "");
    bar.appendChild(reset);
    drawing.style.transformOrigin = "0 0";
    drawing.setAttribute("data-ar-view", "");

    const apply = () => {
      drawing.style.transform = now.s === 1 && now.x === 0 && now.y === 0 ? "" : `translate(${now.x.toFixed(2)}px, ${now.y.toFixed(2)}px) scale(${now.s.toFixed(4)})`;
      drawing.setAttribute("data-ar-scale", now.s.toFixed(3));
      reset.hidden = Math.abs(goal.s - 1) < 1e-3 && Math.abs(goal.x) < 0.5 && Math.abs(goal.y) < 0.5;
      moved();
    };
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      const dt = last ? Math.min(0.05, (time - last) / 1000) : 1 / 60;
      last = time;
      const k = 1 - Math.exp(-dt / 0.09);
      now.s += (goal.s - now.s) * k;
      now.x += (goal.x - now.x) * k;
      now.y += (goal.y - now.y) * k;
      const done = Math.abs(goal.s - now.s) < 1e-4 && Math.abs(goal.x - now.x) < 0.05 && Math.abs(goal.y - now.y) < 0.05;
      if (done) {
        now.s = goal.s;
        now.x = goal.x;
        now.y = goal.y;
      }
      apply();
      frame = done ? 0 : requestAnimationFrame(tick);
    };
    const go = (immediate: boolean) => {
      if (immediate || (still && still.matches)) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        now.s = goal.s;
        now.x = goal.x;
        now.y = goal.y;
        apply();
        return;
      }
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    // where the drawing's untransformed top-left sits on screen
    const origin = () => {
      const box = drawing.getBoundingClientRect();
      return [box.left - now.x, box.top - now.y];
    };
    const zoomAt = (factor: number, cx: number, cy: number, immediate = false) => {
      const [ox, oy] = origin();
      const next = Math.min(MAX, Math.max(MIN, goal.s * factor));
      const px = cx - ox;
      const py = cy - oy;
      goal.x = px - ((px - goal.x) * next) / goal.s;
      goal.y = py - ((py - goal.y) * next) / goal.s;
      goal.s = next;
      go(immediate);
    };
    const home = () => {
      goal.s = 1;
      goal.x = 0;
      goal.y = 0;
      go(false);
    };
    reset.addEventListener("click", home);

    plate.addEventListener("wheel", (event) => {
      event.preventDefault();
      // a pinch arrives as ctrl+wheel with small deltas; a mouse wheel notch is ~100
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const speed = event.ctrlKey ? 0.01 : 0.0018;
      zoomAt(Math.exp(-event.deltaY * unit * speed), event.clientX, event.clientY);
    }, { passive: false });

    const blank = (target: EventTarget | null) =>
      !(target instanceof Element) || !target.closest("[data-part], button, a, input, select, textarea, label, [draggable=\"true\"]");
    let drag: { id: number; x: number; y: number; gx: number; gy: number; on: boolean } | null = null;
    let swallow = false;
    plate.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      if (!blank(event.target) && goal.s <= 1.001) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, gx: goal.x, gy: goal.y, on: false };
    });
    window.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.on) {
        if (Math.hypot(dx, dy) < SLOP) return;
        drag.on = true;
        document.documentElement.setAttribute("data-ar-panning", "");
        try {
          plate.setPointerCapture(event.pointerId);
        } catch {
          /* the pointer may already be gone */
        }
      }
      goal.x = drag.gx + dx;
      goal.y = drag.gy + dy;
      go(true);
    });
    const end = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.on) {
        swallow = true;
        setTimeout(() => (swallow = false), 0);
        document.documentElement.removeAttribute("data-ar-panning");
      }
      drag = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    // a pan is not a click on whatever was under the pointer
    window.addEventListener("click", (event) => {
      if (swallow) {
        swallow = false;
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);
    plate.addEventListener("dblclick", (event) => {
      if (blank(event.target)) home();
    });
    (window as unknown as Record<string, unknown>).__arView = {
      get: () => ({ scale: goal.s, x: goal.x, y: goal.y }),
      zoom: (factor: number, x: number, y: number) => zoomAt(factor, x, y, true),
      reset: () => {
        goal.s = 1;
        goal.x = 0;
        goal.y = 0;
        go(true);
      },
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
}

export const FIGURE_CHROME_STYLE = `<style ${MARK}>${CSS}</style>`;
export const FIGURE_CHROME_SCRIPT = `<script ${MARK}>(${chrome.toString()})();</script>`;

/** the frameless style before </head> and the chrome script before </body>; once */
export function figureChrome(html: string): string {
  if (html.includes(MARK)) return html;
  let out = html;
  const head = out.search(/<\/head\s*>/i);
  out = head !== -1 ? out.slice(0, head) + FIGURE_CHROME_STYLE + out.slice(head) : FIGURE_CHROME_STYLE + out;
  const body = out.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  out = body !== -1 ? out.slice(0, body) + FIGURE_CHROME_SCRIPT + out.slice(body) : out + FIGURE_CHROME_SCRIPT;
  return out;
}
