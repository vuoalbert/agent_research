/**
 * The client side of the Telem reading views: one page, as `GET
 * /api/telem/read` returns it, remembered for the session (a failure is not,
 * so a retry asks again). Shared by the Force graph's panel (plain DOM), the
 * Knowledge base preview and References' "Read full page".
 *
 * Also the text prep every reader uses: page markdown with its images and raw
 * HTML dropped — a reading view shows the words, never another site's pixels.
 */

export const READ_ENDPOINT = "/api/telem/read";

export type ReadView = {
  url: string;
  title: string;
  host: string;
  text: string;
  provider: string;
  platform?: string;
  truncated?: boolean;
  chars: number;
};

const reads = new Map<string, Promise<ReadView>>();

export function readThroughTelem(url: string, { chatId }: { chatId?: string | null } = {}): Promise<ReadView> {
  const cached = reads.get(url);
  if (cached) return cached;
  const query = new URLSearchParams({ url, ...(chatId ? { chat: chatId } : {}) });
  const view = fetch(`${READ_ENDPOINT}?${query}`)
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as (ReadView & { error?: string }) | null;
      if (!response.ok || !body || typeof body.text !== "string") {
        throw new Error(body?.error || `Telem couldn't read this page (${response.status})`);
      }
      return body;
    })
    .catch((error: unknown) => {
      reads.delete(url);
      throw error instanceof Error ? error : new Error(String(error));
    });
  reads.set(url, view);
  return view;
}

/** test-only */
export function __clearReads() {
  reads.clear();
}

/** the page's markdown for reading: no images, no raw HTML, no empty link shells */
export function readableMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/<\/?[a-z][^>]*>/gi, "") // raw HTML tags
    .replace(/\[\s*\]\([^)]*\)/g, "") // links with no text
    .replace(/\n(?=\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s)/g, "\n\n") // a transcript keeps a line per paragraph
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** every link made absolute against the page (Telem keeps a site's relative links), anything not http(s) unlinked */
export function absoluteLinks(markdown: string, base: string): string {
  return markdown.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (whole, text: string, href: string) => {
    try {
      const url = new URL(href, base);
      return url.protocol === "http:" || url.protocol === "https:" ? `[${text}](${url.href})` : text;
    } catch {
      return text;
    }
  });
}

/** the title to show: Telem's, unless it is only the URL or a placeholder ("YouTube video <id>") and a better one is known */
export function readTitle(view: Pick<ReadView, "title" | "url">, known?: string): string {
  const placeholder = !view.title || view.title === view.url || /^\w+ (video|post) [\w-]+$/i.test(view.title);
  return placeholder && known ? known : view.title || known || view.url;
}

/** "via YouTube · fetchlayer_youtube" — who read the page, for the reader's byline */
export function readByline(view: Pick<ReadView, "provider" | "platform">): string {
  const who = view.provider ? `Read by Telem · ${view.provider}` : "Read by Telem";
  return view.platform ? `${who} · ${view.platform}` : who;
}

/* ── plain blocks, for the DOM reader ─────────────────────────────────────── */

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "item"; text: string; ordered: boolean }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string };

const TIMESTAMP = /^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s/;

/** inline markdown to plain text: links keep their words, emphasis and code marks go */
export function inlineText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Markdown to a flat list of readable blocks — headings, paragraphs, list
 * items, quotes and code — for a reader that builds its DOM by hand. A
 * transcript (most lines start with a timestamp) keeps one line per block.
 */
export function toBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = readableMarkdown(markdown).split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    const transcript = paragraph.length > 1 && paragraph.filter((l) => TIMESTAMP.test(l)).length >= paragraph.length / 2;
    const texts = transcript ? paragraph : [paragraph.join(" ")];
    for (const text of texts) {
      const clean = inlineText(text);
      if (clean) blocks.push({ kind: "paragraph", text: clean });
    }
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s{0,3}(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i]);
      if (code.join("").trim()) blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)) {
      flush();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const text = inlineText(heading[2]);
      if (text) blocks.push({ kind: "heading", level: heading[1].length, text });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const text = inlineText(item[3]);
      if (text) blocks.push({ kind: "item", text, ordered: Boolean(item[2]) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const text = inlineText(quote[1]);
      if (text) blocks.push({ kind: "quote", text });
      continue;
    }
    /* a table row reads as its cells */
    paragraph.push(line.includes("|") ? line.split("|").map((c) => c.trim()).filter(Boolean).join(" · ") : line);
  }
  flush();
  return blocks;
}
