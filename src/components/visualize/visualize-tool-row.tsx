"use client";

import { Box } from "lucide-react";
import type { MouseEvent } from "react";

import { useTabView } from "@/components/tab-view-context";
import { Button } from "@/components/ui/button";
import type { ToolCall } from "@/lib/agent-store";
import { cn } from "@/lib/utils";
import { isActive, type JobStatus } from "@/lib/visualize";

import { useVisualizeJob } from "./use-jobs";

/**
 * A Visualize call in the chat: a box, "Visualize", and the subject, set like
 * the other tool rows. The call itself ends the moment the figure starts, so
 * the row follows the JOB instead: it pulses while the figure is being built
 * (polling the job), and says how it ended — or that it was replaced, since
 * there is only one visualization at a time. Clicking it opens the Visualize
 * view.
 *
 * Two rows carry no job: a call that failed ("· failed"), and one that found
 * a figure still building and so started nothing — that one is all muted:
 * "Visualize already building <subject>".
 */

const SUFFIX: Partial<Record<JobStatus, string>> = {
  queued: "queued",
  done: "ready",
  error: "failed",
  stopped: "stopped",
  interrupted: "interrupted",
};

export function VisualizeToolRow({ call }: { call: ToolCall }) {
  const tabView = useTabView();
  const jobId = call.jobId;
  // the row only needs the status: no log lines
  const { job } = useVisualizeJob(jobId, 0);

  // undefined until the first answer; "gone" once a newer figure replaced it
  const status: JobStatus | "gone" | undefined = job === null ? "gone" : job?.status;
  const busy = !jobId && call.status === "done";
  // before the first answer, a call that started a job counts as running
  const pulsing = jobId
    ? status === undefined || (status !== "gone" && isActive(status))
    : call.status === "running";
  let suffix: string | undefined;
  if (call.status === "error") suffix = "failed";
  else if (status === "gone") suffix = "replaced";
  else if (status) suffix = SUFFIX[status];

  const open = (event: MouseEvent<HTMLElement>) => tabView?.openView("Visualize", event.currentTarget);

  const body = (
    <>
      <Box aria-hidden size={14} data-icon="box" className="size-3.5 shrink-0 text-[var(--ai-muted)]" />
      <span className={cn("shrink-0", busy ? "text-[var(--ai-muted)]" : "font-medium text-[var(--ai-ink)]")}>
        Visualize
      </span>
      <span className="min-w-0 truncate text-[var(--ai-muted)]">{call.query}</span>
      {suffix && <span className="shrink-0 text-[var(--ai-muted)]">· {suffix}</span>}
    </>
  );
  const shared = {
    "data-ai": "tool",
    "data-action": "visualize",
    "data-status": busy ? "busy" : (status ?? call.status),
    className: cn(
      "flex min-w-0 items-center gap-1.5 px-1 text-[13px] leading-5",
      pulsing && "motion-safe:animate-pulse",
    ),
  };

  if (!jobId) return <div {...shared}>{body}</div>;
  return (
    /* the house row recipe: the Button primitive, its box set here so the
       row keeps the other tool rows' 13/20 line */
    <Button
      variant="nav"
      {...shared}
      data-job={jobId}
      onClick={open}
      title="Open in the Visualize tab"
      className={cn(
        shared.className,
        "h-auto w-full justify-start rounded-[4px] border-0 font-normal whitespace-normal text-[var(--ai-ink)] hover:bg-[var(--ai-tint)] focus-visible:ring-2 focus-visible:ring-[#D6D7D9] active:not-aria-[haspopup]:translate-y-0",
      )}
    >
      {body}
    </Button>
  );
}
