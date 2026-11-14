"use client";

import { ArrowLeft, ExternalLink, FileText, LoaderCircle, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { TelemReader } from "@/components/telem-reader";
import { useWatchUpdates } from "@/components/telem/use-watch";
import { Button } from "@/components/ui/button";
import {
  addFoundSources,
  selectChatSources,
  selectSourceOrigins,
  sourceKey,
  useAgentStore,
  type Message,
  type Source,
} from "@/lib/agent-store";
import { cn } from "@/lib/utils";

/**
 * The Knowledge base panel: every source Claude's searches turned up in the
 * active chat, de-duplicated by URL in the order they were first found — a
 * source list in the manner of NotebookLM's, set in this app's light theme.
 * A row opens the page right here, read through Telem (title, host, clean
 * text; a back arrow returns to the list), with a small icon beside it that
 * opens the page itself in a new tab. "Find more" runs a Telem search seeded
 * from the chat's topic and appends what is new; sources found that way, or
 * from the Force graph's chatbox, carry a small tag. The heading stays put: the component
 * fills the panel and only the list below it scrolls (scrollbar hidden), with
 * shadcn's `scroll-fade-y` mask fading whichever edge has more list beyond it. Sources only: claims
 * live in References (the vault's Claims/ notes) and the Force graph.
 *
 * After the chat's own sources come the ones its Telem monitors found since
 * (src/components/telem/use-watch.ts), each marked "New" until the chat's
 * watch is next seen.
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

/** the Knowledge base's "Find more": a Telem search for sources the chat does not have */
export const FIND_ENDPOINT = "/api/telem/find";

/** a chat's topic, for "Find more": its first question, else its title */
export function chatTopic(turns: readonly Message[] | undefined, title: string | undefined): string {
  const first = turns?.find((turn) => turn.role === "user" && turn.content.trim())?.content ?? "";
  const topic = (first || title || "").replace(/\s+/g, " ").trim();
  return topic.length > 300 ? `${topic.slice(0, 300).replace(/\s+\S*$/, "")}` : topic;
}

const ICON_BUTTON =
  "rounded-md border-0 text-plane-muted hover:bg-[#F9F9F9] hover:text-plane-ink focus-visible:bg-[#F9F9F9] focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-0 motion-reduce:transition-none";

const ORIGIN_LABEL = { graph: "Graph", kb: "Telem" } as const;

function SourceRow({
  source,
  origin,
  onOpen,
  fresh = false,
}: {
  source: Source;
  origin?: "graph" | "kb";
  onOpen: (source: Source) => void;
  /** a source a Telem monitor just found, not seen yet */
  fresh?: boolean;
}) {
  const host = hostOf(source.url);
  return (
    <li className="group/row relative">
      <Button
        variant="nav"
        data-source-row=""
        data-source-url={source.url}
        title={`${source.title}\n${host}`}
        onClick={() => onOpen(source)}
        className="-mx-2 h-9 w-[calc(100%+16px)] min-w-0 justify-start gap-2.5 rounded-md border-0 px-2 pr-9 font-normal hover:bg-[#F9F9F9] focus-visible:bg-[#F9F9F9] focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-0"
      >
        <Favicon host={host} />
        <span className="min-w-0 truncate text-[14px] leading-5 text-plane-ink">{source.title}</span>
        {fresh && (
          <span data-kb-new="" className="ml-auto shrink-0 text-[11px] leading-4 font-medium text-plane-brand">
            New
          </span>
        )}
        {origin && (
          <span
            data-source-origin={origin}
            title={origin === "graph" ? "Found from the Force graph with Telem" : "Found with Telem's Find more"}
            className="shrink-0 rounded-full bg-plane-active px-1.5 text-[11px] leading-4 text-plane-muted"
          >
            {ORIGIN_LABEL[origin]}
          </span>
        )}
      </Button>
      {/* the page itself, a small way out: the house link recipe */}
      <Button
        variant="nav"
        size="icon-xs"
        nativeButton={false}
        role="link"
        render={<Link href={source.url} target="_blank" rel="noopener noreferrer" prefetch={false} />}
        aria-label={`Open ${source.title} in a new tab`}
        title="Open in new tab"
        data-source-open=""
        className={cn(
          "absolute top-1/2 right-[-4px] -translate-y-1/2 opacity-60 group-hover/row:opacity-100 focus-visible:opacity-100",
          ICON_BUTTON,
        )}
      >
        <ExternalLink aria-hidden size={14} className="size-3.5" />
      </Button>
    </li>
  );
}

type FindState = { status: "idle" } | { status: "pending" } | { status: "done"; text: string; error?: boolean };

export function KnowledgeBase({ titleId }: { titleId: string }) {
  const { activeChatId, messages, chats } = useAgentStore();
  const turns = activeChatId ? messages[activeChatId] : undefined;
  const own = useMemo(() => selectChatSources(turns), [turns]);
  const origins = useMemo(() => selectSourceOrigins(turns), [turns]);
  const { updates } = useWatchUpdates(activeChatId);
  const { sources, fresh } = useMemo(() => {
    const seen = new Set(own.map((source) => sourceKey(source.url)));
    const watched: Source[] = [];
    for (const source of updates?.sources ?? []) {
      const key = sourceKey(source.url);
      if (seen.has(key)) continue;
      seen.add(key);
      watched.push({ title: source.title, url: source.url });
    }
    return { sources: [...own, ...watched], fresh: new Set(updates?.fresh.sources ?? []) };
  }, [own, updates]);
  const count = sources.length;
  const chat = chats.find((c) => c.id === activeChatId);
  const topic = chatTopic(turns, chat?.title);

  /** the source being read in the panel, with the chat it was opened from */
  const [reading, setReading] = useState<{ source: Source; chatId: string | null } | null>(null);
  const [find, setFind] = useState<FindState>({ status: "idle" });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /* another chat: back to its list */
  const [shownChat, setShownChat] = useState(activeChatId);
  if (shownChat !== activeChatId) {
    setShownChat(activeChatId);
    setReading(null);
    setFind({ status: "idle" });
  }

  const findMore = async () => {
    if (!activeChatId || !topic || find.status === "pending") return;
    const chatId = activeChatId;
    setFind({ status: "pending" });
    try {
      const response = await fetch(FIND_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: topic, known: sources.map((s) => s.url), chatId }),
      });
      const body = (await response.json().catch(() => null)) as
        | { query?: string; sources?: Source[]; error?: string }
        | null;
      if (!response.ok || !body || !Array.isArray(body.sources)) throw new Error(body?.error || `Find more failed (${response.status})`);
      const write = addFoundSources(chatId, { query: body.query || topic, sources: body.sources, origin: "kb" });
      const added = write?.added ?? 0;
      setFind({
        status: "done",
        text: added === 0 ? "Telem found nothing new" : `Added ${added} ${added === 1 ? "source" : "sources"} from Telem`,
      });
      if (added > 0) {
        requestAnimationFrame(() => {
          const list = scrollRef.current;
          list?.scrollTo?.({ top: list.scrollHeight, behavior: "smooth" });
        });
      }
    } catch (error) {
      setFind({ status: "done", text: error instanceof Error ? error.message : "Find more failed", error: true });
    }
  };

  return (
    <div data-kb="root" data-kb-view={reading ? "reader" : "list"} className="flex h-full min-h-0 flex-col">
      <div data-kb="header" className="flex h-5 shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {reading && (
            <Button
              variant="nav"
              size="icon-xs"
              aria-label="Back to all sources"
              title="Back"
              data-kb="back"
              onClick={() => setReading(null)}
              className={cn("-my-0.5 -ml-1", ICON_BUTTON)}
            >
              <ArrowLeft aria-hidden size={16} className="size-4" />
            </Button>
          )}
          <h2 id={titleId} className="text-[13px] leading-5 font-semibold text-plane-ink">
            Knowledge base
          </h2>
        </div>
        {reading ? (
          <Button
            variant="nav"
            size="icon-xs"
            nativeButton={false}
            role="link"
            render={<Link href={reading.source.url} target="_blank" rel="noopener noreferrer" prefetch={false} />}
            aria-label="Open in new tab"
            title="Open in new tab"
            data-kb="reader-open"
            className={cn("-my-0.5 -mr-1", ICON_BUTTON)}
          >
            <ExternalLink aria-hidden size={14} className="size-3.5" />
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span data-kb="count" className="text-[13px] leading-5 text-plane-muted">
              {count} {count === 1 ? "source" : "sources"}
            </span>
            {activeChatId && topic && (
              <Button
                variant="nav"
                size="xs"
                data-kb="find-more"
                aria-busy={find.status === "pending"}
                disabled={find.status === "pending"}
                onClick={findMore}
                title={`Search the web with Telem for more on “${topic}”`}
                className="-my-0.5 -mr-1.5 h-6 gap-1 rounded-md border-0 px-1.5 text-[12px] font-medium text-plane-ink-2 hover:bg-[#F9F9F9] focus-visible:bg-[#F9F9F9] focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-0 disabled:opacity-60"
              >
                {find.status === "pending" ? (
                  <LoaderCircle aria-hidden size={13} className="size-3.5 motion-safe:animate-spin" />
                ) : (
                  <Search aria-hidden size={13} className="size-3.5" />
                )}
                Find more
              </Button>
            )}
          </div>
        )}
      </div>
      {!reading && find.status === "done" && (
        <p
          data-kb="find-status"
          role="status"
          className={cn("mt-1 shrink-0 truncate text-[12px] leading-4", find.error ? "text-plane-muted" : "text-plane-faint")}
        >
          {find.text}
        </p>
      )}
      {reading ? (
        <div
          key={reading.source.url}
          data-kb="reader"
          className={cn("scroll-fade-y scroll-fade-7 -mx-4 mt-2 min-h-0 flex-1 overflow-y-auto px-4", NO_SCROLLBAR)}
        >
          <TelemReader url={reading.source.url} title={reading.source.title} chatId={reading.chatId} />
        </div>
      ) : count === 0 ? (
        <div data-kb="empty" className="mt-6 flex flex-col items-center gap-2 text-center">
          <FileText aria-hidden size={18} className="text-plane-faint" />
          <p className="text-[13px] leading-5 text-plane-muted">Sources Claude finds will appear here</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          data-kb="scroll"
          className={cn("scroll-fade-y scroll-fade-7 -mx-4 mt-2 min-h-0 flex-1 overflow-y-auto px-4", NO_SCROLLBAR)}
        >
          <ul aria-label="Sources" className="flex flex-col">
            {sources.map((source) => (
              <SourceRow
                key={source.url}
                source={source}
                origin={origins.get(sourceKey(source.url))}
                onOpen={(picked) => setReading({ source: picked, chatId: activeChatId })}
                fresh={fresh.has(source.url)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
