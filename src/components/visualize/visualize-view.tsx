"use client";

import { Box, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MESSAGE_LINE_PREFIX,
  figureEndpoint,
  formatElapsed,
  isActive,
  stopEndpoint,
  type JobDetail,
  type LogLine,
} from "@/lib/visualize";

import { StatusChip } from "./status-chip";
import { useCurrentVisualization, useNow } from "./use-jobs";

/**
 * The Visualize page (a full-width tab view): the ONE visualization there is.
 *
 *   - while it builds: its subject, status and elapsed time, the agent's latest
 *     progress lines, and Stop;
 *   - once it is done: the figure itself, filling the whole view from the very
 *     top, in an iframe that may run its own script and nothing else
 *     (`sandbox="allow-scripts"`, no same-origin; the route adds a CSP with no
 *     network). The header floats over it on no background, and the iframe
 *     fades in under the header instead of starting at a hard edge, so a
 *     zoomed or panned drawing slides under the title;
 *   - failed, stopped or interrupted: why, and what it got to;
 *   - before the first: "Ask Claude to visualize something".
 *
 * The chat can message the agent (message_visualize): its messages show in
 * the progress log, a finished figure that was picked back up shows its
 * progress again until the updated page is ready. The header shows only the
 * time: the agent's reply (what it changed) goes back to the chat, not here.
 *
 * It is polled every few seconds while the page is open. The header leaves
 * room on the left for FullTabView's Back button, which sits over it.
 */

export function VisualizeView({ className }: { className?: string }) {
  const { job, refresh } = useCurrentVisualization();
  if (job === undefined) return <div data-visualize="loading" className={className} />;
  if (job === null) return <EmptyState className={className} />;
  return <CurrentVisualization key={job.id} job={job} refresh={refresh} className={className} />;
}

function EmptyState({ className }: { className?: string }) {
  return (
    <div
      data-visualize="empty"
      className={cn("flex flex-col items-center justify-center gap-2 px-6 text-center", className)}
    >
      <Box aria-hidden size={22} className="text-plane-faint" />
      <p className="text-[15px] font-medium text-plane-ink">Ask Claude to visualize something</p>
      <p className="max-w-[380px] text-[13px] leading-5 text-plane-muted">
        Try “Visualize how a dial indicator gauge works.” Research answers get a figure too. It builds in the
        background and shows up here.
      </p>
    </div>
  );
}

function CurrentVisualization({
  job,
  refresh,
  className,
}: {
  job: JobDetail;
  refresh: () => void;
  className?: string;
}) {
  const active = isActive(job.status);
  const now = useNow(job.status === "running");
  const [stopping, setStopping] = useState(false);
  const elapsed = job.startedAt ? (job.endedAt ?? now) - job.startedAt : 0;
  const message = job.status === "done" ? job.note : job.error;

  const stop = async () => {
    setStopping(true);
    try {
      await fetch(stopEndpoint(job.id), { method: "POST" });
    } catch {
      /* the next poll shows what happened */
    } finally {
      setStopping(false);
      refresh();
    }
  };

  // a figure being updated (the chat messaged its agent) shows its progress, then the new page
  const figure = Boolean(job.figure) && !active;

  return (
    <section
      data-visualize={job.status}
      aria-label={job.subject}
      className={cn("relative flex flex-col", figure ? "bg-white" : "bg-plane-pane", className)}
    >
      {/* pl leaves the Back button (16px in, ~72px wide) its corner; over a figure
          it floats on no background and lets the pointer through to the figure */}
      <header
        className={cn(
          "flex h-[60px] shrink-0 items-center gap-3 pr-5 pl-[104px]",
          figure && "pointer-events-none absolute inset-x-0 top-0 z-10 [&_button]:pointer-events-auto",
        )}
      >
        {/* only the time shows here; the subject stays as the region's label */}
        <h2 className="sr-only">{job.subject}</h2>
        {/* no chip once it is done: the finished figure says that itself */}
        {job.status !== "done" && <StatusChip status={job.status} />}
        {job.startedAt !== undefined && (
          <span data-elapsed="" className="shrink-0 text-[13px] text-plane-muted tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        )}
        {active && (
          <Button variant="outline" size="sm" onClick={stop} disabled={stopping} className="ml-auto text-plane-ink-2">
            <Square aria-hidden />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
      </header>

      {figure ? (
        <>
          <iframe
            title={job.subject}
            src={figureEndpoint(job.id)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            data-figure=""
            className="absolute inset-0 block size-full border-0 bg-white [mask-image:linear-gradient(to_bottom,transparent_0,rgb(0_0_0/.35)_28px,#000_64px)]"
          />
          {message && (
            <p className="pointer-events-none absolute inset-x-0 top-[52px] z-10 px-5 text-[12px] leading-5 text-plane-muted">
              {message}
            </p>
          )}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pt-4 pb-5">
          {active ? (
            <p className="text-[13px] leading-5 text-plane-muted">
              {job.figure
                ? "Claude is updating this figure with the chat’s message. The new version shows here when it’s done."
                : "Claude is building this figure in the background with the anatomy skill. It usually takes 15–60 minutes."}
            </p>
          ) : (
            message && (
              <p className="rounded-[8px] border border-plane-border bg-plane-band px-4 py-3 text-[13px] leading-5 text-plane-ink-2">
                {message}
              </p>
            )
          )}
          <ProgressLog lines={job.log} />
        </div>
      )}
    </section>
  );
}

const clock = (t: number) => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** the latest progress lines, oldest first, kept scrolled to the newest */
function ProgressLog({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const last = lines.length ? lines[lines.length - 1].t : 0;
  useLayoutEffect(() => {
    const list = ref.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [last, lines.length]);
  if (lines.length === 0) return null;
  return (
    <ol
      ref={ref}
      aria-label="Progress"
      className={cn("min-h-0 flex-1 overflow-y-auto font-mono text-[12px] leading-5", NO_SCROLLBAR)}
    >
      {lines.map((line, index) => {
        // the chat's messages stand out from the agent's own lines
        const asked = line.text.startsWith(MESSAGE_LINE_PREFIX);
        return (
          <li key={`${line.t}-${index}`} data-log-line="" data-message={asked ? "" : undefined} className="flex gap-3">
            <span className="shrink-0 text-plane-faint tabular-nums">{clock(line.t)}</span>
            <span
              className={cn(
                "min-w-0 break-words whitespace-pre-wrap",
                asked ? "font-medium text-plane-ink" : "text-plane-ink-2",
              )}
            >
              {line.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
