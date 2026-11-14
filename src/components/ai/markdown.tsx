"use client";

import "katex/dist/katex.min.css";
import "./markdown.css";

import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import Link from "next/link";
import { memo, type ComponentProps } from "react";
import { Streamdown, type Components } from "streamdown";

import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { cn } from "@/lib/utils";

/**
 * An assistant turn's text, rendered as markdown while it streams.
 *
 * Streamdown does the streaming-safe part: it splits the reply into blocks and
 * re-parses only the last one, and closes unterminated `**`, `` ` ``, `[`,
 * `$$` and code fences before parsing, so a half-arrived token never shows as
 * a raw marker. On top of it:
 *
 * - Math: KaTeX via `@streamdown/math`, with single-dollar inline math on.
 *   `\( \)` and `\[ \]` are rewritten to dollars first (remark-math only knows
 *   dollars), a one-line `$$…$$` is opened onto its own lines so it renders as
 *   display math, and a `$` that can't open or close math by Pandoc's rules
 *   (`$5 and $10`) is escaped so prices stay prices.
 * - Code: Shiki via `@streamdown/code`, light theme in both slots.
 * - Typography: the thread's 16/25 muted body, ink for headings and strong.
 *   Elements Streamdown builds itself (code block, inline code, KaTeX) are
 *   styled from `markdown.css` under `[data-ai="markdown"]`.
 */

const math = createMathPlugin({ singleDollarTextMath: true });
const code = createCodePlugin({ themes: ["github-light", "github-light"] });
const PLUGINS = { math, code };

const LINK_SAFETY = { enabled: false };
const CONTROLS = { code: { copy: true, download: false }, table: false, mermaid: false } as const;

/* ── Preprocessing ──────────────────────────────────────────────────────────── */

/** Fenced code (closed, or still open at the end) and inline code spans. */
const CODE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\3[`~]*[ \t]*(?=\n|$)|$)|(`+)[^`\n][\s\S]*?\4(?!`)/g;

/** Runs `fn` over the prose between code, leaving code untouched. `tail`
 *  marks the prose that ends the text (where a stream is still arriving). */
function outsideCode(text: string, fn: (prose: string, tail: boolean) => string) {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(CODE)) {
    const start = match.index + (match[1]?.length ?? 0);
    out += fn(text.slice(last, start), false) + text.slice(start, match.index + match[0].length);
    last = match.index + match[0].length;
  }
  return out + fn(text.slice(last), true);
}

/** `\[ \]` → display, `\( \)` → inline, one-line `$$x$$` → its own lines. */
function normalizeDelimiters(prose: string) {
  return prose
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
    .replace(/^([ \t]*)\$\$([^\n$]+?)\$\$[ \t]*$/gm, (_, indent: string, body: string) =>
      `${indent}$$\n${indent}${body.trim()}\n${indent}$$`,
    );
}

/**
 * Escapes single `$`s that can't be math. An opener needs a non-space right
 * after it; its closer needs a non-space right before it and no digit right
 * after. A `$` with no such partner on its line is a literal dollar.
 *
 * While streaming, an unpartnered `$` at the very end with no space after it
 * (`$E=mc^`) is a formula still arriving, not a price: hold it back until its
 * closer lands rather than flash the raw source. Same for an open `\(`/`\[`.
 */
function escapeLoneDollars(prose: string, holdTail: boolean) {
  if (holdTail) {
    const open = Math.max(prose.lastIndexOf("\\("), prose.lastIndexOf("\\["));
    if (open !== -1) prose = prose.slice(0, open);
  }
  const lines = prose.split("\n");
  return lines
    .map((line, n) => {
      const singles: number[] = [];
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\") {
          i++;
          continue;
        }
        if (line[i] !== "$") continue;
        if (line[i + 1] === "$") {
          i++;
          continue;
        }
        singles.push(i);
      }
      const escape = new Set<number>();
      for (let k = 0; k < singles.length; k++) {
        const open = singles[k];
        const opens = line[open + 1] !== undefined && !/\s/.test(line[open + 1]);
        let close = -1;
        if (opens) {
          for (let j = k + 1; j < singles.length; j++) {
            const at = singles[j];
            if (!/\s/.test(line[at - 1]) && !/\d/.test(line[at + 1] ?? "")) {
              close = j;
              break;
            }
          }
        }
        if (close === -1) {
          escape.add(open);
          continue;
        }
        k = close;
      }
      if (holdTail && n === lines.length - 1 && escape.size > 0) {
        const lastLone = Math.max(...escape);
        if (lastLone === singles[singles.length - 1] && !/\s/.test(line.slice(lastLone + 1))) {
          escape.delete(lastLone);
          line = line.slice(0, lastLone);
        }
      }
      if (escape.size === 0) return line;
      return [...line].map((ch, i) => (escape.has(i) ? "\\$" : ch)).join("");
    })
    .join("\n");
}

/**
 * While streaming, a marker that has arrived without any content yet (`is **`,
 * `use \``, a fence line still being typed) has nothing for Streamdown to
 * close, so it would flash as raw text. Hold it until its content lands.
 */
function holdBareMarkers(prose: string) {
  return prose.replace(/(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*$/, "$1").replace(/(^|[\s([])[*_`~]+$/, "$1");
}

export function prepareMarkdown(text: string, streaming = false) {
  return outsideCode(outsideCode(text, normalizeDelimiters), (prose, tail) =>
    streaming && tail ? escapeLoneDollars(holdBareMarkers(prose), true) : escapeLoneDollars(prose, false),
  );
}

/* ── Elements ───────────────────────────────────────────────────────────────── */

const ink = "font-semibold text-[var(--ai-ink)]";

const COMPONENTS: Components = {
  p: ({ node: _node, className, ...props }) => <p className={cn("my-3", className)} {...props} />,
  strong: ({ node: _node, className, ...props }) => <strong className={cn(ink, className)} {...props} />,
  h1: ({ node: _node, className, ...props }) => (
    <h1 className={cn("mt-5 mb-2 text-[20px] leading-[28px]", ink, className)} {...props} />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2 className={cn("mt-5 mb-2 text-[18px] leading-[26px]", ink, className)} {...props} />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3 className={cn("mt-4 mb-1.5 text-[16px] leading-[25px]", ink, className)} {...props} />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4 className={cn("mt-4 mb-1.5 text-[16px] leading-[25px]", ink, className)} {...props} />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5 className={cn("mt-3 mb-1 text-[16px] leading-[25px]", ink, className)} {...props} />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6 className={cn("mt-3 mb-1 text-[16px] leading-[25px]", ink, className)} {...props} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul className={cn("my-3 list-disc space-y-1 pl-6 marker:text-[var(--ai-muted)]", className)} {...props} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol className={cn("my-3 list-decimal space-y-1 pl-6 marker:text-[var(--ai-muted)]", className)} {...props} />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li className={cn("pl-1 [&>ol]:my-1 [&>p]:my-1 [&>ul]:my-1", className)} {...props} />
  ),
  // next/link, the house link primitive; an external href renders a plain anchor
  a: ({ node: _node, className, href, ref: _ref, ...props }) => (
    <Link
      className={cn(
        "text-[var(--ai-ink)] underline decoration-[#C4C6C8] underline-offset-2 transition-colors hover:decoration-[var(--ai-ink)] [overflow-wrap:anywhere]",
        className,
      )}
      href={href ?? "#"}
      prefetch={false}
      {...props}
      rel="noopener noreferrer"
      target="_blank"
    />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote className={cn("my-3 border-l-2 border-[var(--ai-chip)] pl-4", className)} {...props} />
  ),
  hr: ({ node: _node, className, ...props }) => (
    /* no hairline: a `---` in a reply only adds space, it draws no rule */
    <hr className={cn("my-5 border-0", className)} {...props} />
  ),
  table: ({ node: _node, className, ...props }) => (
    <div data-ai="md-table" className={cn("my-3 max-w-full overflow-x-auto", NO_SCROLLBAR)}>
      <table className={cn("w-max min-w-full border-collapse text-[15px] leading-[22px]", className)} {...props} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn(
        "border border-[var(--ai-chip)] bg-[var(--ai-tint)] px-3 py-1.5 text-left font-semibold text-[var(--ai-ink)]",
        className,
      )}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td className={cn("border border-[var(--ai-chip)] px-3 py-1.5 align-top", className)} {...props} />
  ),
};

type MarkdownProps = Omit<ComponentProps<"div">, "children"> & {
  children: string;
  /** this turn is still receiving tokens */
  streaming?: boolean;
};

export const Markdown = memo(function Markdown({ children, streaming = false, className, ...props }: MarkdownProps) {
  return (
    <div
      data-ai="markdown"
      className={cn(
        "px-1 py-2 text-[16px] leading-[25px] text-[var(--ai-muted)] [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    >
      <Streamdown
        /* the elements' own margins space the blocks (they collapse); Streamdown
           already zeroes the first's top and the last's bottom */
        className="space-y-0"
        plugins={PLUGINS}
        components={COMPONENTS}
        controls={CONTROLS}
        linkSafety={LINK_SAFETY}
        lineNumbers={false}
        codeBlockMaxHeight={0}
        tableMaxHeight={0}
        isAnimating={streaming}
      >
        {prepareMarkdown(children, streaming)}
      </Streamdown>
    </div>
  );
});
