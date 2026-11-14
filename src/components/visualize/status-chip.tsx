import { cn } from "@/lib/utils";
import { STATUS_LABEL, type JobStatus } from "@/lib/visualize";

/** a job's status as a small pill: a coloured dot and the word */

const DOT: Record<JobStatus, string> = {
  queued: "bg-plane-state-backlog",
  running: "bg-plane-state-progress motion-safe:animate-pulse",
  done: "bg-plane-state-done",
  error: "bg-plane-state-cancelled",
  stopped: "bg-plane-state-backlog",
  interrupted: "bg-plane-state-progress",
};

export function StatusChip({ status, className }: { status: JobStatus; className?: string }) {
  return (
    <span
      data-status-chip={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-plane-border bg-plane-pane px-1.5 text-[12px] leading-5 font-[450] text-plane-ink-2",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}
