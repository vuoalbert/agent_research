"use client";

import { Globe } from "lucide-react";
import type { MouseEvent } from "react";

import { useTabView } from "@/components/tab-view-context";
import { Button } from "@/components/ui/button";
import type { ToolCall } from "@/lib/agent-store";
import { cn } from "@/lib/utils";

import { useWorld } from "./use-world";

/**
 * The chat's World Labs row: a globe, "World Labs", and what the world is
 * doing — "Generating <title>" while World Labs builds it (pulsing), "<title>
 * ready" once it can be walked, "<title> · failed" if it could not be made.
 * The call itself ends the moment the world is started, so the row follows
 * the WORLD (polled while it generates), as a Visualize row follows its job.
 * Clicking it opens the World Labs tab.
 */
export function WorldToolRow({ call }: { call: ToolCall }) {
  const tabView = useTabView();
  const world = useWorld(call.chatId);
  const title = world?.title || call.query;
  // undefined until the first answer (counts as generating); null: the server has no such world
  const status = world === null ? "gone" : (world?.status ?? "generating");
  const detail = status === "ready" ? `${title} ready` : status === "generating" ? `Generating ${title}` : title;

  const open = (event: MouseEvent<HTMLElement>) => tabView?.openView("World Labs", event.currentTarget);

  return (
    <Button
      variant="nav"
      data-ai="tool"
      data-action="world"
      data-status={status}
      onClick={open}
      title="Open in the World Labs tab"
      className={cn(
        "flex h-auto w-full min-w-0 items-center justify-start gap-1.5 rounded-[4px] border-0 px-1 text-[13px] leading-5 font-normal whitespace-normal text-[var(--ai-ink)] hover:bg-[var(--ai-tint)] focus-visible:ring-2 focus-visible:ring-[#D6D7D9] active:not-aria-[haspopup]:translate-y-0",
        status === "generating" && "motion-safe:animate-pulse",
      )}
    >
      <Globe aria-hidden size={14} data-icon="globe" className="size-3.5 shrink-0 text-[var(--ai-muted)]" />
      <span className="shrink-0 font-medium text-[var(--ai-ink)]">World Labs</span>
      <span className="min-w-0 truncate text-[var(--ai-muted)]">{detail}</span>
      {status === "error" && <span className="shrink-0 text-[var(--ai-muted)]">· failed</span>}
    </Button>
  );
}
