import { readByline, readTitle, toBlocks, type ReadView } from "./telem-reader-data";

/**
 * The Telem reading view as plain DOM, for the Force graph's page panels
 * (which live in a CSS3D layer, outside React): the page's title, its host and
 * who read it, then its text as readable paragraphs, headings and lists, in a
 * scroll area with no visible scrollbar and shadcn's `scroll-fade-y` edges.
 * Every string goes in through `textContent`.
 */

const FONT = "var(--font-sans, ui-sans-serif, system-ui, sans-serif)";
/** at most this many blocks are drawn; a page longer than that says so */
export const MAX_BLOCKS = 600;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string) {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderReader(view: ReadView, { note, title: known }: { note?: string; title?: string } = {}): HTMLDivElement {
  const scroll = el("div", {
    position: "absolute",
    inset: "0",
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: "20px 28px 28px",
    boxSizing: "border-box",
    color: "#313435",
    font: `14px/22px ${FONT}`,
    textAlign: "left",
  });
  /* the app's hidden scrollbar and edge fade, from the shared utilities */
  scroll.className = "scroll-fade-y scroll-fade-7 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
  scroll.dataset.panelReader = "";

  const article = el("article", { maxWidth: "560px", margin: "0 auto" });
  const title = el("h3", { margin: "0", font: `600 17px/24px ${FONT}`, color: "#0F0F10", overflowWrap: "anywhere" }, readTitle(view, known));
  const meta = el("p", { margin: "4px 0 14px", font: `11px/16px ${FONT}`, color: "#848D92" }, `${view.host} · ${readByline(view)}`);
  meta.dataset.readerMeta = "";
  article.append(title, meta);
  if (note) {
    const why = el("p", { margin: "-8px 0 14px", font: `11px/16px ${FONT}`, color: "#A3A6AB" }, note);
    article.append(why);
  }

  const blocks = toBlocks(view.text);
  let list: HTMLUListElement | HTMLOListElement | null = null;
  for (const block of blocks.slice(0, MAX_BLOCKS)) {
    if (block.kind !== "item") list = null;
    if (block.kind === "heading") {
      const size = block.level <= 2 ? 15 : 14;
      article.append(el("h4", { margin: "18px 0 6px", font: `600 ${size}px/22px ${FONT}`, color: "#0F0F10" }, block.text));
    } else if (block.kind === "paragraph") {
      article.append(el("p", { margin: "0 0 10px", overflowWrap: "anywhere" }, block.text));
    } else if (block.kind === "item") {
      const tag = block.ordered ? "ol" : "ul";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = el(tag, { margin: "0 0 10px", paddingLeft: "20px" });
        article.append(list);
      }
      list.append(el("li", { margin: "0 0 4px", overflowWrap: "anywhere" }, block.text));
    } else if (block.kind === "quote") {
      article.append(el("blockquote", { margin: "0 0 10px", padding: "0 0 0 12px", borderLeft: "2px solid #E1E2E3", color: "#494D50" }, block.text));
    } else {
      article.append(
        el("pre", {
          margin: "0 0 10px",
          padding: "10px 12px",
          borderRadius: "6px",
          background: "#F9F9F9",
          font: `12px/18px ui-monospace, SFMono-Regular, Menlo, monospace`,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }, block.text),
      );
    }
  }
  if (blocks.length === 0) article.append(el("p", { margin: "0", color: "#848D92" }, "Telem read the page, but it has no text to show."));
  if (blocks.length > MAX_BLOCKS || view.truncated) {
    article.append(el("p", { margin: "14px 0 0", font: `11px/16px ${FONT}`, color: "#A3A6AB" }, "The page goes on — open it in a new tab for the rest."));
  }
  scroll.append(article);
  return scroll;
}
