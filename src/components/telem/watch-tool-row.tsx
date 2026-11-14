"use client";

import { Eye, Radar } from "lucide-react";
import type { MouseEvent } from "react";

import { useTabView } from "@/components/tab-view-context";
import { Button } from "@/components/ui/button";
import type { ToolCall } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

/**
 * A Telem Monitors call in the chat: "Telem · Watching <topic>" (or Checking,
 * Asking, Running, Paused, Resumed …), set like the other tool rows. An eye
 * for watching and checking; a radar for a run and for talking to the
 * monitor's agent. It pulses while the call runs; clicking it opens the
 * Telem tab. No counts.
 */

const RADAR = /^(Running|Asking)\b/;

export function WatchToolRow({ call }: { call: ToolCall }) {
  const tabView = useTabView();
  const Icon = RADAR.test(call.query) ? Radar : Eye;
  const open = (event: MouseEvent<HTMLElement>) => tabView?.openView("Telem", event.currentTarget);
  const body = (
    <>
      <Icon aria-hidden size={14} data-icon={Icon === Radar ? "radar" : "eye"} className="size-3.5 shrink-0 text-[var(--ai-muted)]" />
      <span className="shrink-0 font-medium text-[var(--ai-ink)]">Telem</span>
      <span aria-hidden className="shrink-0 text-[var(--ai-muted)]">·</span>
      <span className="min-w-0 truncate text-[var(--ai-muted)]">{call.query}</span>
      {call.status === "error" && <span className="shrink-0 text-[var(--ai-muted)]">· failed</span>}
    </>
  );
  const className = cn(
    "flex min-w-0 items-center gap-1.5 px-1 text-left text-[13px] leading-5",
    call.status === "running" && "motion-safe:animate-pulse",
  );
  return tabView ? (
    /* the house row recipe (see visualize-tool-row.tsx): the Button primitive, boxed like the other rows */
    <Button
      variant="nav"
      data-ai="tool"
      data-action="watch"
      data-status={call.status}
      onClick={open}
      title="Open in the Telem tab"
      className={cn(
        className,
        "h-auto w-full justify-start rounded-[4px] border-0 font-normal whitespace-normal text-[var(--ai-ink)] hover:bg-[var(--ai-tint)] focus-visible:ring-2 focus-visible:ring-[#D6D7D9] active:not-aria-[haspopup]:translate-y-0",
      )}
    >
      {body}
    </Button>
  ) : (
    <div data-ai="tool" data-action="watch" data-status={call.status} className={className}>
      {body}
    </div>
  );
}
