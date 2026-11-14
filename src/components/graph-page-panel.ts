/**
 * graph-page-panel — the live pages the Force graph shows at page nodes: the
 * ones the user clicked (pinned) and the ones the camera is close to, up to
 * MAX_PAGES at once.
 *
 * The panel is plain DOM (built here, never React-rendered, so it can live in
 * a CSS3DRenderer layer): a header strip with the page's favicon, title, host,
 * "Open in new tab" and a close button, over either the live page in an
 * <iframe> or — for sites that forbid embedding — the page read through Telem
 * (`/api/telem/read`): its title, host and text as a clean, scrollable reading
 * view. Only if Telem can't read it either is it a card that opens the page in
 * a new tab. Platform links (YouTube, X, TikTok, LinkedIn…) are read by their
 * platform's Telem providers, so a video shows its transcript. Whether a site
 * may be embedded comes from `/api/embed-check`, remembered in memory for the
 * session, as are the reads. Nothing is stored.
 *
 * All page-supplied text (titles, page text) goes in through `textContent`.
 */

import { readThroughTelem, type ReadView } from "./telem-reader-data";
import { renderReader } from "./telem-reader-dom";

/**
 * The panel's CSS size: an iframe of 640×420 under a 32px header, in a 4px
 * frame of the panel's own chrome — so the pointer always crosses the panel
 * (and fires its pointerenter) on its way into the page, which, being another
 * site's document, keeps its own pointer events from this one.
 */
export const PAGE_WIDTH = 640;
export const PAGE_HEIGHT = 420;
export const HEADER_HEIGHT = 32;
export const FRAME = 4;
export const PANEL_WIDTH = PAGE_WIDTH + 2 * FRAME;
export const PANEL_HEIGHT = HEADER_HEIGHT + PAGE_HEIGHT + FRAME;
/** world units per CSS pixel: the panel is ~32×23 units, small enough that
    the nodes around it stay in sight */
export const PANEL_SCALE = 0.05;

/**
 * Camera distance (world units) at which a page opens by proximity, and the
 * farther one at which it closes again — the gap keeps a camera resting on the
 * boundary from flickering the iframe in and out. At PAGE_NEAR the panel takes
 * roughly a third of the view's height; clicking a page flies to `fitDistance`.
 */
export const PAGE_NEAR = 72;
export const PAGE_FAR = 86;
/** the share of the view a page fills after a click flies to it */
export const FIT_FILL = 0.45;
/** at most this many live pages at once, pinned and nearby together */
export const MAX_PAGES = 4;

export const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-forms";

export type PanelPage = { id: string; url: string; title: string; host: string };
export type EmbedAnswer = { embeddable: boolean; reason?: string };
export type PanelState = "checking" | "page" | "card" | "reader";

/**
 * How far from a page the camera must sit for the panel to fill FIT_FILL of
 * the view, given a perspective camera's vertical fov (degrees) and aspect.
 */
export function fitDistance(fovDegrees: number, aspect: number): number {
  const visible = 2 * Math.tan((fovDegrees * Math.PI) / 360);
  const height = (PANEL_HEIGHT * PANEL_SCALE) / FIT_FILL;
  const width = (PANEL_WIDTH * PANEL_SCALE) / FIT_FILL;
  return Math.max(height / visible, width / (visible * Math.max(aspect, 0.1)));
}

export type PageCandidate = { id: string; distance: number; inView: boolean };

/**
 * Which pages are open. `pins` are pages the user clicked, oldest first: they
 * stay open wherever the camera goes until closed. `nearby` are pages opened
 * by proximity, each with when it was last used (opened or touched). Pages in
 * `dismissed` — closed by hand, or evicted to make room — don't reopen by
 * proximity until the camera has left them (past PAGE_FAR, or out of view),
 * so a closed page doesn't spring straight back.
 *
 * Together pins and nearby never pass MAX_PAGES: a new page closes the
 * least-recently-used nearby page first, and only once every slot is pinned
 * the oldest pin.
 */
export type Deck = { pins: string[]; nearby: Map<string, number>; dismissed: Set<string> };

export const createDeck = (): Deck => ({ pins: [], nearby: new Map(), dismissed: new Set() });

/** every open page: pins oldest first, then nearby pages */
export const openPages = (deck: Deck): string[] => [...deck.pins, ...deck.nearby.keys()];

function evictLeastRecent(deck: Deck, among: (id: string) => boolean = () => true): boolean {
  let lru: string | null = null;
  for (const [id, used] of deck.nearby) {
    if (among(id) && (lru === null || used < deck.nearby.get(lru)!)) lru = id;
  }
  if (lru === null) return false;
  deck.nearby.delete(lru);
  deck.dismissed.add(lru);
  return true;
}

/** pin a page (a click) — or refresh its pin — making room as needed */
export function pinPage(deck: Deck, id: string) {
  deck.dismissed.delete(id);
  deck.nearby.delete(id);
  deck.pins = [...deck.pins.filter((p) => p !== id), id];
  while (deck.pins.length > MAX_PAGES) deck.dismissed.add(deck.pins.shift()!);
  while (deck.pins.length + deck.nearby.size > MAX_PAGES && evictLeastRecent(deck));
}

/** close one page (its ×): it stays closed until the camera has left it */
export function closePage(deck: Deck, id: string) {
  deck.pins = deck.pins.filter((p) => p !== id);
  deck.nearby.delete(id);
  deck.dismissed.add(id);
}

/** the user is using a nearby page: it is the last to be evicted */
export function touchPage(deck: Deck, id: string, now: number) {
  if (deck.nearby.has(id)) deck.nearby.set(id, now);
}

/**
 * One look from the camera: nearby pages close past PAGE_FAR or out of view;
 * unpinned pages in view within PAGE_NEAR open, nearest first, into free
 * slots — or, with none free, in place of the least-recently-used nearby page
 * clearly (10%) farther away. `opening: false` (mid-flight) opens nothing
 * new. Pages no longer in the graph are dropped.
 */
export function updateNearby(deck: Deck, candidates: readonly PageCandidate[], now: number, opening = true) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const near = (c: PageCandidate | undefined, reach: number): c is PageCandidate =>
    !!c && c.inView && c.distance <= reach;
  deck.pins = deck.pins.filter((id) => byId.has(id));
  for (const id of deck.dismissed) if (!near(byId.get(id), PAGE_FAR)) deck.dismissed.delete(id);
  for (const id of deck.nearby.keys()) if (!near(byId.get(id), PAGE_FAR)) deck.nearby.delete(id);
  if (!opening) return;
  const fresh = candidates
    .filter((c) => c.inView && c.distance < PAGE_NEAR && !deck.nearby.has(c.id) && !deck.dismissed.has(c.id) && !deck.pins.includes(c.id))
    .sort((a, b) => a.distance - b.distance);
  for (const c of fresh) {
    if (deck.pins.length + deck.nearby.size >= MAX_PAGES) {
      const farther = (id: string) => byId.get(id)!.distance * 0.9 > c.distance;
      if (!evictLeastRecent(deck, farther)) break;
    }
    deck.nearby.set(c.id, now);
  }
}

/** ----------------------------------------------------------- embed check */

const answers = new Map<string, Promise<EmbedAnswer>>();

/** may the page be framed here? Cached for the session; failures are not */
export function checkEmbeddable(url: string): Promise<EmbedAnswer> {
  /* an https app cannot frame an http page at all (mixed content) */
  if (typeof window !== "undefined" && window.location.protocol === "https:" && url.startsWith("http:")) {
    return Promise.resolve({ embeddable: false, reason: "The page is not served over https" });
  }
  const cached = answers.get(url);
  if (cached) return cached;
  const answer = fetch(`/api/embed-check?url=${encodeURIComponent(url)}`)
    .then((response) => response.json() as Promise<EmbedAnswer>)
    .then((body) => ({ embeddable: body.embeddable === true, ...(body.reason ? { reason: String(body.reason) } : {}) }))
    .catch(() => {
      answers.delete(url);
      return { embeddable: false, reason: "Couldn't check whether this page can be shown" };
    });
  answers.set(url, answer);
  return answer;
}

/** test-only */
export function __clearEmbedAnswers() {
  answers.clear();
}

/** ------------------------------------------------------------------ DOM */

export const faviconUrl = (host: string) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

const FONT = "var(--font-sans, ui-sans-serif, system-ui, sans-serif)";
const BORDER = "#E1E2E3";
const CHROME = "#F9F9F9";
/** the border while the pointer is over the panel and the page takes input */
const BORDER_LIVE = "#A3A6AB";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function favicon(host: string, size: number) {
  const img = el("img", { width: `${size}px`, height: `${size}px`, flex: "none", borderRadius: "4px" });
  img.alt = "";
  img.src = faviconUrl(host);
  img.referrerPolicy = "no-referrer";
  img.draggable = false;
  return img;
}

function openLink(url: string, label: string, primary: boolean) {
  const a = el(
    "a",
    {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      flex: "none",
      height: primary ? "30px" : "22px",
      padding: primary ? "0 12px" : "0 8px",
      borderRadius: "6px",
      border: primary ? "0" : "1px solid #E1E2E3",
      background: primary ? "#1D1F20" : "#FFFFFF",
      color: primary ? "#FFFFFF" : "#313435",
      font: `500 ${primary ? 12 : 11}px ${FONT}`,
      textDecoration: "none",
      cursor: "pointer",
    },
    label,
  );
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dataset.panelOpen = "";
  return a;
}

export type Panel = {
  element: HTMLDivElement;
  setState: (state: PanelState, reason?: string) => void;
  /** mark the panel as taking input (the pointer is over it): a darker border */
  setLive: (live: boolean) => void;
};

/**
 * The panel for one page, in its "checking" state. `onClose` runs from the
 * header's close button; `forwardWheel` gets wheel events over the panel's own
 * chrome (not the page), so zooming keeps working across the header and card;
 * `onHover` hears the pointer enter and leave the panel, iframe included.
 */
export function createPanel(
  page: PanelPage,
  {
    onClose,
    forwardWheel,
    onHover,
    read = readThroughTelem,
  }: {
    onClose: () => void;
    forwardWheel?: (event: WheelEvent) => void;
    onHover?: (over: boolean) => void;
    /** how a blocked page is read instead (Telem, unless a test says otherwise) */
    read?: (url: string) => Promise<ReadView>;
  },
): Panel {
  const element = el("div", {
    width: `${PANEL_WIDTH}px`,
    height: `${PANEL_HEIGHT}px`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "10px",
    border: `1px solid ${BORDER}`,
    background: CHROME,
    boxShadow: "0 8px 28px rgba(15,15,16,0.12)",
    font: `13px ${FONT}`,
    pointerEvents: "auto",
    transition: "border-color 120ms ease-out",
    color: "#0F0F10",
  });
  element.dataset.graphPanel = page.url;
  element.dataset.state = "checking";

  /* the graph's own pointer handling (node clicks, hover) stops at the panel */
  for (const type of ["pointerdown", "pointermove", "pointerup", "click", "dblclick"] as const) {
    element.addEventListener(type, (event) => event.stopPropagation());
  }
  if (onHover) {
    element.addEventListener("pointerenter", () => onHover(true));
    element.addEventListener("pointerleave", () => onHover(false));
  }
  const setLive = (live: boolean) => {
    element.style.borderColor = live ? BORDER_LIVE : BORDER;
    if (live) element.dataset.live = "";
    else delete element.dataset.live;
  };

  const header = el("div", {
    height: `${HEADER_HEIGHT}px`,
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "0 4px 0 10px",
    boxSizing: "border-box",
    background: CHROME,
  });
  const title = el(
    "span",
    { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: `500 12px ${FONT}` },
    page.title,
  );
  const host = el("span", { flex: "none", color: "#848D92", font: `11px ${FONT}` }, page.host);
  const close = el(
    "button",
    {
      width: "24px",
      height: "24px",
      flex: "none",
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: "#494D50",
      font: `16px/1 ${FONT}`,
      cursor: "pointer",
    },
    "×",
  );
  close.type = "button";
  close.setAttribute("aria-label", "Close page");
  close.dataset.panelClose = "";
  close.addEventListener("click", onClose);
  header.append(favicon(page.host, 14), title, host, openLink(page.url, "Open in new tab", false), close);

  const body = el("div", {
    position: "relative",
    flex: "none",
    width: `${PAGE_WIDTH}px`,
    height: `${PAGE_HEIGHT}px`,
    margin: `0 ${FRAME}px ${FRAME}px`,
    overflow: "hidden",
    borderRadius: "6px",
    border: "0",
    boxShadow: "0 0 0 1px #EAEBEC",
    background: "#FFFFFF",
  });
  element.append(header, body);

  if (forwardWheel) {
    for (const chrome of [header, body]) {
      chrome.addEventListener(
        "wheel",
        (event) => {
          /* the live page and the reading view scroll themselves; everything else zooms the graph */
          const target = event.target as HTMLElement | null;
          if (target?.tagName === "IFRAME" || target?.closest?.("[data-panel-reader]")) return;
          event.preventDefault();
          forwardWheel(event);
        },
        { passive: false },
      );
    }
  }

  const card = (status: string, withButton: boolean) => {
    const wrap = el("div", {
      position: "absolute",
      inset: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
      padding: "28px",
      textAlign: "center",
    });
    wrap.dataset.panelCard = "";
    const name = el("div", { maxWidth: "520px", font: `600 16px/1.3 ${FONT}`, color: "#0F0F10" }, page.title);
    const where = el("div", { font: `12px ${FONT}`, color: "#494D50" }, page.host);
    const note = el("div", { maxWidth: "400px", font: `11px/1.5 ${FONT}`, color: "#848D92" }, status);
    wrap.append(favicon(page.host, 40), name, where, note);
    if (withButton) {
      const button = openLink(page.url, "Open in new tab", true);
      button.style.marginTop = "6px";
      wrap.append(button);
    }
    return wrap;
  };

  /** the read in flight; a newer state (or read) wins */
  let reads = 0;
  /** "reader" is where "card" goes once Telem has read the page, never set directly */
  const setState = (state: PanelState, reason?: string) => {
    if (state === "reader") return;
    reads += 1;
    element.dataset.state = state;
    if (state === "page") {
      const frame = document.createElement("iframe");
      frame.src = page.url;
      frame.title = page.title;
      frame.setAttribute("sandbox", IFRAME_SANDBOX);
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("loading", "lazy");
      frame.width = String(PAGE_WIDTH);
      frame.height = String(PAGE_HEIGHT);
      /* pixel sizes: a percentage height does not resolve in the panel's layout */
      Object.assign(frame.style, {
        display: "block",
        width: "100%",
        height: `${PAGE_HEIGHT}px`,
        border: "0",
        background: "#FFFFFF",
        pointerEvents: "auto",
      });
      body.replaceChildren(frame);
    } else if (state === "card") {
      const why = reason ? `${reason}.` : "This site doesn't allow being shown here.";
      body.replaceChildren(card(`${why} Reading it through Telem…`, false));
      const asked = reads;
      read(page.url).then(
        (view) => {
          if (asked !== reads || element.dataset.state !== "card") return;
          element.dataset.state = "reader";
          body.replaceChildren(renderReader(view, { note: `${why} Shown as read by Telem.`, title: page.title }));
        },
        (error: unknown) => {
          if (asked !== reads || element.dataset.state !== "card") return;
          const failed = error instanceof Error && error.message ? ` Telem couldn't read it either: ${error.message}` : "";
          body.replaceChildren(card(`${why}${failed}`, true));
        },
      );
    } else {
      body.replaceChildren(card("Loading the page…", false));
    }
  };
  setState("checking");
  return { element, setState, setLive };
}
