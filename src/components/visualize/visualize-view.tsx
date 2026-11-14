"use client";

import { Box, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
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
 *   - once it is done: the figure itself, filling the page, in an iframe that
 *     may run its own script and nothing else (`sandbox="allow-scripts"`, no
 *     same-origin; the route adds a CSP with no network);
 *   - failed, stopped or interrupted: why, and what it got to;
 *   - before the first: "Ask Claude to visualize something".
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

  return (
    <section
      data-visualize={job.status}
      aria-label={job.subject}
      className={cn("flex flex-col bg-plane-pane", className)}
    >
      {/* pl leaves the Back button (16px in, ~72px wide) its corner */}
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-plane-border pr-5 pl-[104px]">
        <h2 className="min-w-0 truncate text-[15px] leading-6 font-medium text-plane-ink">{job.subject}</h2>
        <StatusChip status={job.status} />
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

      {job.figure ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {message && (
            <p className="flex h-10 shrink-0 items-center border-b border-plane-border bg-plane-band px-5 text-[12px] text-plane-muted">
              {message}
            </p>
          )}
          <iframe
            title={job.subject}
            src={figureEndpoint(job.id)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="block min-h-0 w-full flex-1 border-0 bg-white"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pt-4 pb-5">
          {active ? (
            <p className="text-[13px] leading-5 text-plane-muted">
              Claude is building this figure in the background with the anatomy skill. It usually takes 15–60 minutes.
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
      {lines.map((line, index) => (
        <li key={`${line.t}-${index}`} data-log-line="" className="flex gap-3">
          <span className="shrink-0 text-plane-faint tabular-nums">{clock(line.t)}</span>
          <span className="min-w-0 break-words whitespace-pre-wrap text-plane-ink-2">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}
