/**
 * The app's own chrome on every served figure, on top of the agent's page:
 *
 *   - no frame: the kit's card (`.iso-plate`) loses its 1px outline and
 *     shadow; the corner texts and caption stay;
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
 * The button and the panel only appear when the figure has marked parts, so
 * a figure built before the contract simply loses its frame. Everything is an
 * inline <style> and an inline classic <script> (the figure CSP allows only
 * inline), with no network and no eval; text goes in through textContent.
 */

const MARK = 'data-agent-research="chrome"';

const CSS = `
.iso-plate{box-shadow:none!important;border:0!important;outline:0!important;border-radius:0!important}
[data-part-info]{transition:filter .18s cubic-bezier(.32,.72,0,1)}
[data-part-info][data-ar-hot]{filter:grayscale(1) brightness(.8) contrast(.92)}
.ar-chrome{font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181a;-webkit-font-smoothing:antialiased}
.ar-expand{position:fixed;top:16px;left:16px;z-index:20;height:28px;padding:0 12px;border:1px solid #E1E2E3;border-radius:999px;background:#fff;color:#18181a;font-size:12.5px;font-weight:500;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:background-color .15s ease,transform .15s cubic-bezier(.32,.72,0,1)}
.ar-expand:hover{background:#F4F4F5}
.ar-expand:active{transform:scale(.97)}
.ar-expand:focus-visible,.ar-parts button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
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
@media (min-width:640px){body.ar-has-parts{padding-right:256px}}
@media (max-width:639px){.ar-parts{position:static;width:auto;max-height:300px;margin:0 16px 24px}}
@media (prefers-reduced-motion:reduce){[data-part-info],.ar-expand,.ar-parts button,.ar-tip{transition:none!important}}
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
    if (!parts.length) return;

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
    const expand = make("button", "ar-chrome ar-expand", "Expand");
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

    document.body.appendChild(expand);
    document.body.appendChild(panel);
    document.body.appendChild(tip);
    document.body.classList.add("ar-has-parts");
    fade();

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
