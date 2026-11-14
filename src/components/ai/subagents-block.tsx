"use client";

/**
 * A `deploy_subagents` call in the chat: "Running 4 subagents", then a small
 * tree of them, one row each — a geometric mark in its own soft colour, the
 * subagent's title, under it what it is doing (its latest search or read, then
 * its one-line result), and "Opus 5.5 · a few seconds ago" on the right.
 *
 * The mark turns slowly while its subagent runs and stops when it is done; a
 * subagent that failed or timed out is muted red. Reduced motion: no turning.
 * Clicking a row opens that subagent's own searches and reads, drawn with the
 * thread's usual tool rows (`renderCall`, so this file does not import the
 * thread back).
 */

import { Network } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { Subagent, SubagentShape, ToolCall } from "@/lib/agent-store";
import { useReduced } from "@/lib/motion-tokens";
import { SUBAGENT_MODEL_LABEL } from "@/lib/subagents";
import { cn } from "@/lib/utils";

/** one soft colour per shape, in deploy order */
export const SHAPE_COLOR: Record<SubagentShape, string> = {
  square: "#6B8AFD",
  circle: "#3BAF7E",
  triangle: "#E5A13A",
  diamond: "#A47AE6",
  hexagon: "#E8798B",
};
export const ERROR_COLOR = "#C46A62";
const GUIDE = "var(--ai-line, #E1E2E3)";

/** each mark in a 16-unit box, centred on (8, 8) so it turns in place */
const SHAPE_PATH: Record<SubagentShape, ReactNode> = {
  square: <rect x="3" y="3" width="10" height="10" rx="2" />,
  circle: <circle cx="8" cy="8" r="5.5" />,
  triangle: <path d="M8 1.8 L13.6 11.1 H2.4 Z" />,
  diamond: <path d="M8 1.8 L14.2 8 L8 14.2 L1.8 8 Z" />,
  hexagon: <path d="M8 2 L13.2 5 V11 L8 14 L2.8 11 V5 Z" />,
};

export function ShapeIcon({ shape, status }: { shape: SubagentShape; status: Subagent["status"] }) {
  const reduce = useReduced();
  const spinning = status === "running" && !reduce;
  const color = status === "error" ? ERROR_COLOR : SHAPE_COLOR[shape];
  return (
    <svg
      aria-hidden
      data-shape={shape}
      data-spinning={spinning ? "true" : "false"}
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill={color}
      fillOpacity={0.2}
      stroke={color}
      strokeWidth={1.5}
      strokeLinejoin="round"
      className={cn(
        "size-4 shrink-0",
        spinning && "motion-safe:animate-[spin_1.6s_linear_infinite]",
      )}
    >
      {SHAPE_PATH[shape]}
    </svg>
  );
}

/** "a few seconds ago", "2 minutes ago" … */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 45) return "a few seconds ago";
  if (seconds < 90) return "a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 45) return `${minutes} minutes ago`;
  if (minutes < 90) return "an hour ago";
  const hours = Math.round(minutes / 60);
  if (hours < 22) return `${hours} hours ago`;
  const days = Math.max(1, Math.round(hours / 24));
  return days === 1 ? "a day ago" : `${days} days ago`;
}

/** the clock the relative times read, ticking while mounted */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function SubagentsBlock({
  call,
  calls,
  renderCall,
}: {
  /** the group's call (`action: "subagents"`) */
  call: ToolCall;
  /** the turn's calls; the ones tagged with this group's id belong to its subagents */
  calls: readonly ToolCall[];
  renderCall: (call: ToolCall) => ReactNode;
}) {
  const subagents = call.subagents ?? [];
  const running = call.status === "running";
  const now = useNow(15_000);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const n = subagents.length;
  const noun = n === 1 ? "subagent" : "subagents";

  return (
    <div data-ai="subagents" data-status={call.status} className="w-[520px] max-w-full">
      <div className="flex items-center gap-1.5 px-1 text-[13px] leading-5 text-[var(--ai-muted)]">
        <Network aria-hidden data-icon="network" size={14} className="shrink-0" />
        <span>{running ? `Running ${n} ${noun}` : `Ran ${n} ${noun}`}</span>
        {call.status === "error" && <span>· stopped</span>}
      </div>
      <ul className="ml-[11px] mt-0.5">
        {subagents.map((sub, index) => {
          const last = index === subagents.length - 1;
          const own = calls.filter((c) => c.parentId === call.id && c.agentId === sub.id);
          const expanded = open.has(sub.id);
          const at = sub.finishedAt ?? sub.startedAt;
          return (
            <li key={sub.id} data-ai="subagent" data-status={sub.status} className="relative pl-4">
              {/* the tree: the guide runs on past every row but the last, an elbow into each */}
              {!last && <span aria-hidden className="absolute bottom-0 left-0 top-0 w-px" style={{ background: GUIDE }} />}
              <span
                aria-hidden
                className="absolute left-0 top-0 h-[17px] w-2.5 rounded-bl-[6px] border-b border-l"
                style={{ borderColor: GUIDE }}
              />
              {/* the house row recipe: the Button primitive, its box set here */}
              <Button
                variant="nav"
                aria-expanded={expanded}
                onClick={() => toggle(sub.id)}
                title={expanded ? "Hide its searches" : "Show its searches"}
                className="h-auto w-full min-w-0 items-start justify-start gap-2 rounded-[6px] border-0 px-1.5 py-1.5 text-left font-normal whitespace-normal text-[var(--ai-ink)] hover:bg-[var(--ai-tint)] focus-visible:ring-2 focus-visible:ring-[#D6D7D9] active:not-aria-[haspopup]:translate-y-0"
              >
                <span className="flex h-5 items-center">
                  <ShapeIcon shape={sub.shape} status={sub.status} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-baseline gap-3">
                    <span data-ai="subagent-title" className="min-w-0 flex-1 truncate text-[14px] leading-5 text-[var(--ai-ink)]">
                      {sub.title}
                    </span>
                    <span data-ai="subagent-meta" className="shrink-0 text-[12px] leading-5 text-[var(--ai-muted)]">
                      {SUBAGENT_MODEL_LABEL}
                      {at !== undefined && ` · ${relativeTime(at, now)}`}
                    </span>
                  </span>
                  <span
                    data-ai="subagent-line"
                    className={cn("truncate text-[13px] leading-5", sub.status === "error" ? "text-[#A0554E]" : "text-[var(--ai-muted)]")}
                  >
                    {sub.line}
                  </span>
                </span>
              </Button>
              {expanded && (
                <div data-ai="subagent-calls" className="flex flex-col gap-1 pb-1.5 pl-[30px] pt-0.5">
                  {own.length > 0 ? (
                    own.map((c) => <div key={c.id}>{renderCall(c)}</div>)
                  ) : (
                    <span className="px-1 text-[12px] leading-5 text-[var(--ai-muted)]">No searches yet</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
