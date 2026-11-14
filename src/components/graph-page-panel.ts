/**
 * graph-page-panel — the live page the Force graph shows at a page node once
 * the camera is close to it.
 *
 * The panel is plain DOM (built here, never React-rendered, so it can live in
 * a CSS3DRenderer layer): a header strip with the page's favicon, title, host,
 * "Open in new tab" and a close button, over either the live page in an
 * <iframe> or — for sites that forbid embedding — a card that opens the page
 * in a new tab. Whether a site may be embedded comes from `/api/embed-check`,
 * remembered in memory for the session. Nothing is captured or stored.
 *
 * All page-supplied text (titles) goes in through `textContent`.
 */

/** the panel's CSS size: an iframe of 1024×720 under a 40px header */
export const PANEL_WIDTH = 1024;
export const PAGE_HEIGHT = 720;
export const HEADER_HEIGHT = 40;
export const PANEL_HEIGHT = PAGE_HEIGHT + HEADER_HEIGHT;
/** world units per CSS pixel: the panel is ~72×53 units, a few nodes across */
export const PANEL_SCALE = 0.07;

/**
 * Camera distance (world units) at which the nearest page opens, and the
 * farther one at which it closes again — the gap keeps a camera resting on the
 * boundary from flickering the iframe in and out. At PAGE_NEAR the panel takes
 * roughly a third of the view's height; clicking a page flies to `fitDistance`.
 */
export const PAGE_NEAR = 160;
export const PAGE_FAR = 190;
/** the share of the view a page fills after a click flies to it */
export const FIT_FILL = 0.72;

export const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-forms";

export type PanelPage = { id: string; url: string; title: string; host: string };
export type EmbedAnswer = { embeddable: boolean; reason?: string };
export type PanelState = "checking" | "page" | "card";

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
 * Which page should have the panel: the nearest one in view within PAGE_NEAR.
 * The page already open keeps it until it leaves the view or passes PAGE_FAR,
 * unless another page comes clearly (10%) nearer.
 *
 * A `pinned` page — one the user clicked — beats every nearer neighbour (one
 * often sits between the camera and the page it flew to): it gets the panel
 * once within PAGE_NEAR and keeps it to PAGE_FAR, and no other page opens
 * while it is pinned. The caller unpins it once it has been left behind.
 */
export function pickPage(
  candidates: readonly PageCandidate[],
  current: string | null,
  pinned: string | null = null,
): string | null {
  if (pinned) {
    const target = candidates.find((c) => c.id === pinned);
    const reach = current === pinned ? PAGE_FAR : PAGE_NEAR;
    return target && target.inView && target.distance <= reach ? pinned : null;
  }
  let best: PageCandidate | null = null;
  let open: PageCandidate | null = null;
  for (const c of candidates) {
    if (!c.inView) continue;
    if (c.id === current) open = c;
    if (c.distance < PAGE_NEAR && (!best || c.distance < best.distance)) best = c;
  }
  if (open && open.distance <= PAGE_FAR) {
    if (!best || best.id === open.id || best.distance > open.distance * 0.9) return open.id;
  }
  return best?.id ?? null;
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
      height: primary ? "36px" : "28px",
      padding: primary ? "0 16px" : "0 10px",
      borderRadius: "6px",
      border: primary ? "0" : "1px solid #E1E2E3",
      background: primary ? "#1D1F20" : "#FFFFFF",
      color: primary ? "#FFFFFF" : "#313435",
      font: `500 ${primary ? 14 : 13}px ${FONT}`,
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
};

/**
 * The panel for one page, in its "checking" state. `onClose` runs from the
 * header's close button; `forwardWheel` gets wheel events over the panel's own
 * chrome (not the page), so zooming keeps working across the header and card.
 */
export function createPanel(
  page: PanelPage,
  { onClose, forwardWheel }: { onClose: () => void; forwardWheel?: (event: WheelEvent) => void },
): Panel {
  const element = el("div", {
    width: `${PANEL_WIDTH}px`,
    height: `${PANEL_HEIGHT}px`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "12px",
    border: "1px solid #E1E2E3",
    background: "#FFFFFF",
    boxShadow: "0 12px 40px rgba(15,15,16,0.12)",
    font: `14px ${FONT}`,
    color: "#0F0F10",
  });
  element.dataset.graphPanel = page.url;
  element.dataset.state = "checking";

  /* the graph's own pointer handling (node clicks, hover) stops at the panel */
  for (const type of ["pointerdown", "pointermove", "pointerup", "click", "dblclick"] as const) {
    element.addEventListener(type, (event) => event.stopPropagation());
  }

  const header = el("div", {
    height: `${HEADER_HEIGHT}px`,
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "0 8px 0 14px",
    borderBottom: "1px solid #EAEBEC",
    background: "#F9F9F9",
  });
  const title = el(
    "span",
    { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: `500 14px ${FONT}` },
    page.title,
  );
  const host = el("span", { flex: "none", color: "#848D92", font: `13px ${FONT}` }, page.host);
  const close = el(
    "button",
    {
      width: "28px",
      height: "28px",
      flex: "none",
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: "#494D50",
      font: `18px/1 ${FONT}`,
      cursor: "pointer",
    },
    "×",
  );
  close.type = "button";
  close.setAttribute("aria-label", "Close page");
  close.dataset.panelClose = "";
  close.addEventListener("click", onClose);
  header.append(favicon(page.host, 16), title, host, openLink(page.url, "Open in new tab", false), close);

  const body = el("div", { position: "relative", flex: "none", height: `${PAGE_HEIGHT}px`, background: "#FFFFFF" });
  element.append(header, body);

  if (forwardWheel) {
    for (const chrome of [header, body]) {
      chrome.addEventListener(
        "wheel",
        (event) => {
          /* the live page scrolls itself; everything else zooms the graph */
          if ((event.target as HTMLElement | null)?.tagName === "IFRAME") return;
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
      gap: "12px",
      padding: "48px",
      textAlign: "center",
    });
    wrap.dataset.panelCard = "";
    const name = el("div", { maxWidth: "720px", font: `600 22px/1.3 ${FONT}`, color: "#0F0F10" }, page.title);
    const where = el("div", { font: `15px ${FONT}`, color: "#494D50" }, page.host);
    const note = el("div", { maxWidth: "560px", font: `13px/1.5 ${FONT}`, color: "#848D92" }, status);
    wrap.append(favicon(page.host, 64), name, where, note);
    if (withButton) {
      const button = openLink(page.url, "Open in new tab", true);
      button.style.marginTop = "8px";
      wrap.append(button);
    }
    return wrap;
  };

  const setState = (state: PanelState, reason?: string) => {
    element.dataset.state = state;
    if (state === "page") {
      const frame = document.createElement("iframe");
      frame.src = page.url;
      frame.title = page.title;
      frame.setAttribute("sandbox", IFRAME_SANDBOX);
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("loading", "lazy");
      frame.width = String(PANEL_WIDTH);
      frame.height = String(PAGE_HEIGHT);
      /* pixel sizes: a percentage height does not resolve in the panel's layout */
      Object.assign(frame.style, { display: "block", width: "100%", height: `${PAGE_HEIGHT}px`, border: "0", background: "#FFFFFF" });
      body.replaceChildren(frame);
    } else if (state === "card") {
      body.replaceChildren(card(reason ? `${reason}.` : "This site doesn't allow being shown here.", true));
    } else {
      body.replaceChildren(card("Loading the page…", false));
    }
  };
  setState("checking");
  return { element, setState };
}
