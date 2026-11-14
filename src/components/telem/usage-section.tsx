"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";

import { PANE_TONES } from "@/components/ai/tokens";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAgentStore } from "@/lib/agent-store";
import { cn } from "@/lib/utils";
import {
  consoleUrl,
  formatMs,
  formatUsd,
  type AgentNode,
  type AllUsage,
  type ChatUsage,
  type DayUsage,
  type ProviderShare,
  type UsageTotals,
} from "@/lib/telem-usage";

/**
 * The Telem tab's Usage section: what research has spent, from
 * GET /api/telem/usage (the recorder in src/server/telem/usage.ts).
 *
 *   This chat   Telem searches and reads, the providers that answered (chips
 *               with each one's share, over a thin segmented bar), median and
 *               p95 latency, failures and fallbacks, the estimated Telem cost,
 *               Claude's turns and cost, and the research tree — the chat's
 *               own agent, then its subagents — each with its Telem session
 *               and trajectory ids and a link to the console.
 *   All chats   the same totals over every chat, Telem calls by day (columns)
 *               and by provider (bars).
 *
 * Colors: the dataviz reference palette's categorical slots, in fixed order
 * and fixed per provider (a provider keeps its color whatever else is on
 * screen); providers past the eighth slot fold into "Other", in grey.
 */

const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;
const OTHER = "#8a8d90";
/** the providers Telem routes to most, in palette order: color follows the provider */
const PROVIDER_SLOTS = ["exa", "tavily", "brave", "parallel", "linkup", "perplexity", "you", "serpapi"];

export function providerColor(provider: string): string {
  const slot = PROVIDER_SLOTS.indexOf(provider.toLowerCase());
  return slot === -1 ? OTHER : SERIES[slot];
}

const POLL_MS = 10_000;

type Scope = "chat" | "all";

/** reads the active chat from the store unless one is given */
export function UsageSection({ chatId, className }: { chatId?: string | null; className?: string }) {
  const store = useAgentStore();
  const activeChatId = chatId === undefined ? store.activeChatId : chatId;
  const [scope, setScope] = useState<Scope>("chat");
  const [chat, setChat] = useState<ChatUsage | null>(null);
  const [all, setAll] = useState<AllUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (scope === "chat" && !activeChatId) return;
    let cancelled = false;
    const url = scope === "all" ? "/api/telem/usage?scope=all" : `/api/telem/usage?chat=${encodeURIComponent(activeChatId!)}`;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { usage: ChatUsage | AllUsage };
        if (cancelled) return;
        setFailed(false);
        if (scope === "all") setAll(body.usage as AllUsage);
        else setChat(body.usage as ChatUsage);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scope, activeChatId]);

  return (
    <UsageView
      scope={scope}
      onScope={setScope}
      chat={scope === "chat" && activeChatId && chat?.chatId === activeChatId ? chat : null}
      all={all}
      hasChat={Boolean(activeChatId)}
      failed={failed}
      chatTitles={Object.fromEntries(store.chats.map((c) => [c.id, c.title]))}
      className={className}
    />
  );
}

/** the section itself, from data — what the tests render */
export function UsageView({
  scope,
  onScope,
  chat,
  all,
  hasChat = true,
  failed = false,
  chatTitles = {},
  className,
}: {
  chatTitles?: Record<string, string>;
  scope: Scope;
  onScope?: (scope: Scope) => void;
  chat?: ChatUsage | null;
  all?: AllUsage | null;
  hasChat?: boolean;
  failed?: boolean;
  className?: string;
}) {
  return (
    <section
      data-telem="usage"
      data-scope={scope}
      aria-labelledby="telem-usage-title"
      style={PANE_TONES}
      className={cn("flex flex-col gap-5 text-[13px] leading-5 text-[var(--ai-ink)]", className)}
    >
      <header className="flex items-center justify-between gap-3">
        <h2 id="telem-usage-title" className="text-[15px] font-semibold">
          Usage
        </h2>
        <ToggleGroup
          aria-label="Usage scope"
          value={[scope]}
          onValueChange={(next: string[]) => {
            // a segmented pair: pressing the pressed one keeps it pressed
            const picked = next.find((v) => v !== scope);
            if (picked === "chat" || picked === "all") onScope?.(picked);
          }}
          spacing={1}
          className="gap-0.5 rounded-md bg-[var(--ai-chip)] p-0.5"
        >
          {(["chat", "all"] as const).map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              size="sm"
              className="h-6 rounded-[5px] px-2.5 text-[12px] font-medium text-[var(--ai-muted)] hover:bg-transparent hover:text-[var(--ai-ink)] data-[pressed]:bg-white data-[pressed]:text-[var(--ai-ink)] data-[pressed]:shadow-sm"
            >
              {value === "chat" ? "This chat" : "All chats"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </header>

      {failed && !(scope === "chat" ? chat : all) ? (
        <Empty>Usage could not be loaded.</Empty>
      ) : scope === "chat" ? (
        !hasChat ? (
          <Empty>Open a chat to see what its research used.</Empty>
        ) : !chat ? (
          <Empty>Loading…</Empty>
        ) : (
          <ChatUsageBody usage={chat} />
        )
      ) : !all ? (
        <Empty>Loading…</Empty>
      ) : (
        <AllUsageBody usage={all} chatTitles={chatTitles} />
      )}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[var(--ai-muted)]">{children}</p>;
}

function hasAnything(totals: UsageTotals) {
  return totals.searches + totals.fetches + totals.claudeTurns + totals.subagentRuns + totals.visualizeJobs + totals.worldJobs > 0;
}

function ChatUsageBody({ usage }: { usage: ChatUsage }) {
  if (!hasAnything(usage.totals)) return <Empty>No research in this chat yet.</Empty>;
  return (
    <>
      <StatGrid totals={usage.totals} />
      {usage.providers.length > 0 && <ProviderChips providers={usage.providers} />}
      <ResearchTree tree={usage.tree} />
    </>
  );
}

function AllUsageBody({ usage, chatTitles }: { usage: AllUsage; chatTitles: Record<string, string> }) {
  if (!hasAnything(usage.totals)) return <Empty>No research recorded yet.</Empty>;
  return (
    <>
      <StatGrid totals={usage.totals} />
      {usage.providers.length > 0 && <ProviderChips providers={usage.providers} />}
      {usage.days.length > 0 && <DayColumns days={usage.days} />}
      {usage.providers.length > 0 && <ProviderBars providers={usage.providers} />}
      <ChatList chats={usage.chats} titles={chatTitles} />
    </>
  );
}

// ── stat tiles ───────────────────────────────────────────────────────────────

function StatGrid({ totals }: { totals: UsageTotals }) {
  const tiles: { label: string; value: string; note?: string }[] = [
    { label: "Searches", value: String(totals.searches) },
    { label: "Page reads", value: String(totals.fetches) },
    { label: "Median latency", value: formatMs(totals.latencyP50Ms), note: `p95 ${formatMs(totals.latencyP95Ms)}` },
    {
      label: "Failures",
      value: String(totals.failures),
      note: totals.fallbacks ? `${totals.fallbacks} fell back` : undefined,
    },
    { label: "Telem cost", value: formatUsd(totals.telemCostUsd), note: totals.telemCostEstimated ? "estimated" : undefined },
    {
      label: "Claude turns",
      value: String(totals.claudeTurns),
      note: totals.subagentRuns ? `+ ${totals.subagentRuns} subagent runs` : undefined,
    },
    { label: "Claude cost", value: formatUsd(totals.claudeCostUsd), note: "SDK estimate" },
    {
      label: "Figures",
      value: String(totals.visualizeJobs + totals.worldJobs),
      note: totals.worldJobs ? `${totals.worldJobs} worlds` : undefined,
    },
  ];
  return (
    <dl data-telem="stats" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--ai-line)] bg-[var(--ai-line)] sm:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-0.5 bg-white px-3 py-2.5">
          <dt className="text-[12px] text-[var(--ai-muted)]">{tile.label}</dt>
          <dd data-stat={tile.label} className="text-[18px] font-semibold leading-6">
            {tile.value}
          </dd>
          {tile.note && <dd className="text-[11px] text-[var(--ai-muted)]">{tile.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

// ── providers: chips over a thin segmented bar ───────────────────────────────

const pct = (share: number) => `${Math.round(share * 100)}%`;

function ProviderChips({ providers }: { providers: ProviderShare[] }) {
  return (
    <div data-telem="providers" className="flex flex-col gap-2">
      <h3 className="text-[12px] font-medium text-[var(--ai-muted)]">Providers that answered</h3>
      <div
        role="img"
        aria-label={providers.map((p) => `${p.provider} ${pct(p.share)}`).join(", ")}
        className="flex h-2 w-full gap-[2px]"
      >
        {providers.map((p) =>
          p.share > 0 ? (
            <span
              key={p.provider}
              title={`${p.provider}: ${pct(p.share)} · ${p.calls} calls · ${formatUsd(p.costUsd)}`}
              className="h-full rounded-full"
              style={{ flexGrow: p.share, flexBasis: 0, minWidth: 4, background: providerColor(p.provider) }}
            />
          ) : null,
        )}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {providers.map((p) => (
          <li
            key={p.provider}
            data-provider={p.provider}
            title={`${p.calls} calls · ${formatUsd(p.costUsd)}`}
            className="flex items-center gap-1.5 rounded-full bg-[var(--ai-tint)] px-2 py-0.5 ring-1 ring-[var(--ai-line)]"
          >
            <span aria-hidden className="size-2 rounded-full" style={{ background: providerColor(p.provider) }} />
            <span className="font-medium">{p.provider}</span>
            <span className="text-[var(--ai-muted)]">{pct(p.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── the research tree ────────────────────────────────────────────────────────

function ConsoleLink({ node }: { node: AgentNode }) {
  const ids = [
    ...node.sessionIds.map((id) => `session ${id}`),
    ...node.trajectoryIds.map((id) => `trajectory ${id}`),
  ];
  if (!ids.length) return null;
  return (
    <Link
      href={consoleUrl()}
      target="_blank"
      rel="noopener noreferrer"
      prefetch={false}
      title={ids.join("\n")}
      data-telem="console-link"
      className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--ai-muted)] underline-offset-2 hover:text-[var(--ai-ink)] hover:underline"
    >
      Open in Telem console
      <ExternalLink aria-hidden size={12} />
    </Link>
  );
}

function TreeRow({ node, child = false }: { node: AgentNode; child?: boolean }) {
  const parts = [
    `${node.searches} ${node.searches === 1 ? "search" : "searches"}`,
    `${node.fetches} ${node.fetches === 1 ? "read" : "reads"}`,
    ...(node.failures ? [`${node.failures} failed`] : []),
    `Telem ${formatUsd(node.telemCostUsd)}`,
    `Claude ${formatUsd(node.claudeCostUsd)}`,
  ];
  const session = node.sessionIds[0];
  return (
    <li data-agent={node.agent} className={cn("flex flex-col gap-0.5 py-1.5", child && "border-l border-[var(--ai-line)] pl-3")}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{node.title}</span>
        <ConsoleLink node={node} />
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-2 text-[12px] text-[var(--ai-muted)]">
        <span>{parts.join(" · ")}</span>
        {session && (
          <code className="truncate font-mono text-[11px]" title={session}>
            {session.slice(0, 8)}
          </code>
        )}
      </div>
    </li>
  );
}

function ResearchTree({ tree }: { tree: ChatUsage["tree"] }) {
  return (
    <div data-telem="tree" className="flex flex-col gap-1">
      <h3 className="text-[12px] font-medium text-[var(--ai-muted)]">Research tree</h3>
      <ul className="flex flex-col">
        <TreeRow node={tree.main} />
        {tree.subagents.length > 0 && (
          <li>
            <ul className="ml-2 flex flex-col">
              {tree.subagents.map((sub) => (
                <TreeRow key={sub.agent} node={sub} child />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </div>
  );
}

// ── all chats: by day, by provider ───────────────────────────────────────────

const CHART_H = 96;

/** every day from the first to the last, the quiet ones at zero, at most the last 30 */
export function fillDays(days: readonly DayUsage[]): DayUsage[] {
  if (days.length === 0) return [];
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: DayUsage[] = [];
  const last = Date.parse(`${days[days.length - 1].day}T00:00:00Z`);
  for (let t = Math.max(Date.parse(`${days[0].day}T00:00:00Z`), last - 29 * 86_400_000); t <= last; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, searches: 0, fetches: 0, telemCostUsd: 0, claudeCostUsd: 0 });
  }
  return out;
}

function DayColumns({ days }: { days: DayUsage[] }) {
  const recent = fillDays(days);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...recent.map((d) => d.searches + d.fetches));
  const shown = hover === null ? null : recent[hover];
  return (
    <div data-telem="by-day" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[12px] font-medium text-[var(--ai-muted)]">Telem calls by day</h3>
        {/* the tooltip: values lead, the day follows */}
        <p aria-live="polite" className="min-h-5 text-[12px] text-[var(--ai-muted)]">
          {shown && (
            <>
              <strong className="font-semibold text-[var(--ai-ink)]">{shown.searches + shown.fetches} calls</strong>
              {` · ${shown.searches} searches, ${shown.fetches} reads · Telem ${formatUsd(shown.telemCostUsd)} · Claude ${formatUsd(shown.claudeCostUsd)} · ${shown.day}`}
            </>
          )}
        </p>
      </div>
      <div className="relative flex items-end gap-[2px] border-b border-[var(--ai-line)]" style={{ height: CHART_H }}>
        {recent.map((d, i) => {
          const calls = d.searches + d.fetches;
          return (
            <div
              key={d.day}
              data-day={d.day}
              role="img"
              tabIndex={0}
              aria-label={`${d.day}: ${calls} calls`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className="flex h-full min-w-0 flex-1 items-end justify-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--ai-line)]"
            >
              <span
                className={cn("block w-full max-w-6 rounded-t", hover === i && "opacity-80")}
                style={{ height: calls ? Math.max(2, (calls / max) * CHART_H) : 0, background: SERIES[0] } as CSSProperties}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-[var(--ai-muted)]">
        <span>{recent[0].day}</span>
        {recent.length > 1 && <span>{recent[recent.length - 1].day}</span>}
      </div>
      <table className="sr-only">
        <caption>Telem calls by day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Searches</th>
            <th>Reads</th>
            <th>Telem cost</th>
            <th>Claude cost</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.searches}</td>
              <td>{d.fetches}</td>
              <td>{formatUsd(d.telemCostUsd)}</td>
              <td>{formatUsd(d.claudeCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProviderBars({ providers }: { providers: ProviderShare[] }) {
  const max = Math.max(1, ...providers.map((p) => p.calls));
  return (
    <div data-telem="by-provider" className="flex flex-col gap-2">
      <h3 className="text-[12px] font-medium text-[var(--ai-muted)]">By provider</h3>
      <ul className="flex flex-col gap-1.5">
        {providers.map((p) => (
          <li key={p.provider} className="grid grid-cols-[88px_1fr] items-center gap-2" title={`${pct(p.share)} of calls`}>
            <span className="truncate">{p.provider}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="h-3 rounded-r"
                style={{ width: `${(p.calls / max) * 70}%`, minWidth: 2, background: providerColor(p.provider) }}
              />
              <span className="shrink-0 text-[12px] tabular-nums text-[var(--ai-muted)]">
                {p.calls} · {formatUsd(p.costUsd)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatList({ chats, titles }: { chats: AllUsage["chats"]; titles: Record<string, string> }) {
  const named = chats.filter((c) => c.telemCalls > 0 || c.claudeCostUsd > 0).slice(0, 8);
  if (!named.length) return null;
  return (
    <div data-telem="by-chat" className="flex flex-col gap-1">
      <h3 className="text-[12px] font-medium text-[var(--ai-muted)]">Recent chats</h3>
      <table className="w-full text-left text-[12px]">
        <thead className="text-[var(--ai-muted)]">
          <tr>
            <th className="py-1 font-normal">Chat</th>
            <th className="py-1 text-right font-normal">Telem calls</th>
            <th className="py-1 text-right font-normal">Telem</th>
            <th className="py-1 text-right font-normal">Claude</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {named.map((c) => (
            <tr key={c.chatId} className="border-t border-[var(--ai-line)]">
              <td className="max-w-0 truncate py-1 pr-2">{titles[c.chatId] ?? (c.chatId === "_unscoped" ? "Outside a chat" : c.chatId)}</td>
              <td className="py-1 text-right">{c.telemCalls}</td>
              <td className="py-1 text-right">{formatUsd(c.telemCostUsd)}</td>
              <td className="py-1 text-right">{formatUsd(c.claudeCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
