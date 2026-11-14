"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Markdown } from "@/components/ai/markdown";
import { cn } from "@/lib/utils";

import { absoluteLinks, readableMarkdown, readByline, readThroughTelem, readTitle, type ReadView } from "./telem-reader-data";

/**
 * TelemReader — a page read through Telem, inside a panel: the title, the
 * host and who read it, then the page's text as light markdown (no images, no
 * raw HTML, links absolute and opening in a new tab). The Knowledge base
 * preview and References' "Read full page" both use it; the Force graph's
 * panels draw the same view in plain DOM (`telem-reader-dom.ts`).
 *
 * The caller owns the scroll area (scroll-fade-y, no scrollbar) and the
 * header; this is only the reading.
 */

export type ReadState = { status: "loading" } | { status: "ready"; view: ReadView } | { status: "error"; message: string };

/** the read for a URL (null: nothing to read yet), cached for the session */
export function useTelemRead(url: string | null, chatId?: string | null): ReadState {
  const [state, setState] = useState<ReadState & { url: string | null }>({ status: "loading", url });
  useEffect(() => {
    if (!url) return;
    let live = true;
    readThroughTelem(url, { chatId }).then(
      (view) => live && setState({ status: "ready", view, url }),
      (error: Error) => live && setState({ status: "error", message: error.message, url }),
    );
    return () => {
      live = false;
    };
  }, [url, chatId]);
  /* a new URL reads as loading until its own answer lands */
  return state.url === url ? state : { status: "loading" };
}

/** the most page text a panel renders as markdown */
export const MAX_RENDER_CHARS = 40_000;

const PROSE = cn(
  "px-0 py-0 text-[14px] leading-[22px] text-plane-ink-2",
  "[&_h1]:mt-4 [&_h1]:mb-1 [&_h1]:text-[15px] [&_h1]:leading-[22px]",
  "[&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:text-[14px] [&_h2]:leading-[22px]",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[14px] [&_h3]:leading-[22px]",
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-[14px] [&_h4]:leading-[22px]",
  "[&_p]:my-2 [&_ol]:my-2 [&_ol]:pl-5 [&_ul]:my-2 [&_ul]:pl-5 [&_blockquote]:pl-3",
);

export function ReadBody({ view, className }: { view: ReadView; className?: string }) {
  const markdown = absoluteLinks(readableMarkdown(view.text), view.url).slice(0, MAX_RENDER_CHARS);
  const cut = view.truncated || view.text.length > MAX_RENDER_CHARS;
  return (
    <div data-telem-reader="body" className={className}>
      {markdown ? (
        <Markdown className={PROSE}>{markdown}</Markdown>
      ) : (
        <p className="text-[13px] leading-5 text-plane-muted">Telem read the page, but it has no text to show.</p>
      )}
      {cut && <p className="mt-3 text-[12px] leading-4 text-plane-faint">The page goes on — open it in a new tab for the rest.</p>}
    </div>
  );
}

export function ReadStatus({ state }: { state: Exclude<ReadState, { status: "ready" }> }) {
  return state.status === "loading" ? (
    <p data-telem-reader="loading" className="flex items-center gap-1.5 text-[13px] leading-5 text-plane-muted">
      <LoaderCircle aria-hidden size={14} className="shrink-0 motion-safe:animate-spin" />
      Reading the page through Telem…
    </p>
  ) : (
    <p data-telem-reader="error" className="text-[13px] leading-5 text-plane-muted">
      Telem couldn&apos;t read this page. {state.message}
    </p>
  );
}

/** the whole reading view: title, byline and text, or where the read is */
export function TelemReader({ url, chatId, title }: { url: string; chatId?: string | null; title?: string }) {
  const state = useTelemRead(url, chatId);
  return (
    <article data-telem-reader="root" data-status={state.status} className="flex flex-col gap-1 pb-2">
      <h3 className="text-[15px] leading-[22px] font-semibold text-plane-ink [overflow-wrap:anywhere]">
        {state.status === "ready" ? readTitle(state.view, title) : (title ?? url)}
      </h3>
      <p data-telem-reader="meta" className="text-[12px] leading-4 text-plane-faint">
        {state.status === "ready" ? `${state.view.host} · ${readByline(state.view)}` : hostLabel(url)}
      </p>
      <div className="mt-2">{state.status === "ready" ? <ReadBody view={state.view} /> : <ReadStatus state={state} />}</div>
    </article>
  );
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
