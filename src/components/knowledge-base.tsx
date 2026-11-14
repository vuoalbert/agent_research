"use client";

import { FileText } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { ScrollBlur } from "@/components/ui/scroll-blur";
import { selectChatSources, useAgentStore, type Source } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

/**
 * The Knowledge base panel: every source Claude's searches turned up in the
 * active chat, de-duplicated by URL in the order they were first found — a
 * source list in the manner of NotebookLM's, set in this app's light theme.
 * Each row is a link out to the page. The heading stays put: the component
 * fills the panel and only the list below it scrolls (scrollbar hidden), with
 * a soft fade at whichever edge has more list beyond it. Sources only: claims
 * live in References (the vault's Claims/ notes) and the Force graph.
 */

/** a URL's host without the `www.`, or the URL itself if it does not parse */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const faviconFor = (host: string) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

/** the site's favicon, or a neutral circle with its initial when that fails */
function Favicon({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden
        data-favicon="fallback"
        className="grid size-5 shrink-0 place-items-center rounded-full bg-plane-active text-[11px] font-medium text-plane-muted uppercase"
      >
        {host.charAt(0)}
      </span>
    );
  }
  return (
    /* a plain <img>: a remote 64px icon, not worth configuring next/image's hosts */
    <img
      src={faviconFor(host)}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-5 shrink-0 rounded-full bg-plane-active object-cover"
    />
  );
}

function SourceRow({ source }: { source: Source }) {
  const host = hostOf(source.url);
  return (
    <li>
      {/* the house link recipe: the Button primitive rendering a next/link,
          which leaves an external href as a plain anchor */}
      <Button
        variant="nav"
        nativeButton={false}
        role="link"
        render={
          <Link
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            prefetch={false}
            title={`${source.title}\n${host}`}
          />
        }
        data-source-row=""
        className="-mx-2 h-9 w-[calc(100%+16px)] min-w-0 justify-start gap-2.5 rounded-md border-0 px-2 font-normal hover:bg-[#F9F9F9] focus-visible:bg-[#F9F9F9] focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-0"
      >
        <Favicon host={host} />
        <span className="min-w-0 truncate text-[14px] leading-5 text-plane-ink">{source.title}</span>
      </Button>
    </li>
  );
}

export function KnowledgeBase({ titleId }: { titleId: string }) {
  const { activeChatId, messages } = useAgentStore();
  const turns = activeChatId ? messages[activeChatId] : undefined;
  const sources = useMemo(() => selectChatSources(turns), [turns]);
  const count = sources.length;

  return (
    <div data-kb="root" className="flex h-full min-h-0 flex-col">
      <div data-kb="header" className="flex shrink-0 items-baseline justify-between gap-2">
        <h2 id={titleId} className="text-[13px] leading-5 font-semibold text-plane-ink">
          Knowledge base
        </h2>
        <span data-kb="count" className="text-[13px] leading-5 text-plane-muted">
          {count} {count === 1 ? "source" : "sources"}
        </span>
      </div>
      {count === 0 ? (
        <div data-kb="empty" className="mt-6 flex flex-col items-center gap-2 text-center">
          <FileText aria-hidden size={18} className="text-plane-faint" />
          <p className="text-[13px] leading-5 text-plane-muted">Sources Claude finds will appear here</p>
        </div>
      ) : (
        <ScrollBlur
          fadeSize={28}
          className="-mx-4 mt-2 flex-1"
          viewportClassName={cn("overflow-y-auto px-4", NO_SCROLLBAR)}
          viewportLabel="Sources"
          viewportProps={{ "data-kb": "scroll" }}
        >
          <ul aria-label="Sources" className="flex flex-col">
            {sources.map((source) => (
              <SourceRow key={source.url} source={source} />
            ))}
          </ul>
        </ScrollBlur>
      )}
    </div>
  );
}
