"use client";

import { ArrowUp, ExternalLink, Eye, Pause, Play, Radar, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { NO_SCROLLBAR } from "@/components/ai/tokens";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "@/lib/agent-store";
import { hostOf } from "@/lib/source-key";
import {
  FREQUENCY_LABEL,
  FREQUENCY_OPTIONS,
  MONITORS_ENDPOINT,
  brief,
  budgetPerDay,
  formatUsd,
  monitorChatEndpoint,
  monitorEndpoint,
  objectEndpoint,
  relativeTime,
  runEndpoint,
  tickTime,
  updatesEndpoint,
  words,
  type MonitorChatMessage,
  type MonitorDetail,
  type MonitorObject,
  type MonitorRow,
} from "@/lib/telem-watch";
import { cn } from "@/lib/utils";

import { UsageSection } from "./usage-section";

/**
 * The Telem page (a full-width tab view): what Telem watches for this app.
 *
 *   left   — Watching: every monitor (its topic, status, schedule, spend),
 *            and under it the usage slot (<UsageSection />, Telem-3's);
 *   middle — the selected monitor: status, schedule, last and next run,
 *            spend against budget, and its controls (pause/resume, run now,
 *            frequency, delete); then its latest changes and events, the
 *            objects its agent found (open one for its values, verdicts,
 *            history and pages) and its panels;
 *   right  — a chat with the monitor's own agent.
 *
 * Polled while open: the list every 30 s, the selected monitor every 15 s
 * (every 5 s while its agent is answering or running). Scroll areas use
 * shadcn's scroll-fade-y mask, no scrollbars. The header leaves room on the
 * left for FullTabView's Back button.
 */

const LIST_EVERY = 30_000;
const DETAIL_EVERY = 15_000;
const BUSY_EVERY = 5_000;

const SCROLL = cn("scroll-fade-y scroll-fade-7 min-h-0 overflow-y-auto", NO_SCROLLBAR);

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

async function send(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-plane-state-done",
  ready: "bg-plane-state-done",
  compiling: "bg-plane-state-progress motion-safe:animate-pulse",
  running: "bg-plane-state-progress motion-safe:animate-pulse",
  paused: "bg-plane-state-backlog",
  failed: "bg-plane-state-cancelled",
  ended: "bg-plane-state-backlog",
  deleted: "bg-plane-state-backlog",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      data-telem-status={status}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-plane-border bg-plane-pane px-1.5 text-[12px] leading-5 font-[450] text-plane-ink-2 capitalize"
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[status] ?? "bg-plane-state-backlog")} />
      {words(status)}
    </span>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-baseline justify-between gap-2">
      <h3 className="text-[13px] leading-5 font-semibold text-plane-ink">{children}</h3>
      {aside}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-[13px] leading-5 text-plane-muted">{children}</p>;
}

/** the effective status: the agent's when it says more (compiling, failed), else the monitor's */
const statusOf = (row: { status: string; agent?: { status?: string } | null; agent_state?: { status?: string } | null }) => {
  const agent = row.agent?.status ?? row.agent_state?.status;
  if (row.status === "active" && agent && agent !== "ready") return agent;
  return row.status;
};

export function TelemView({ className }: { className?: string }) {
  const { activeChatId } = useAgentStore();
  const [rows, setRows] = useState<MonitorRow[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const body = await getJson<{ configured: boolean; monitors: MonitorRow[] }>(MONITORS_ENDPOINT);
      setConfigured(body.configured);
      setRows(body.monitors);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void loadList();
    const timer = setInterval(() => void loadList(), LIST_EVERY);
    return () => clearInterval(timer);
  }, [loadList]);

  /* opening the page counts as seeing the active chat's watch news */
  useEffect(() => {
    if (activeChatId) void fetch(updatesEndpoint(activeChatId), { method: "POST" }).catch(() => undefined);
  }, [activeChatId]);

  /* the active chat's newest monitor first, else the newest */
  const ordered = useMemo(() => {
    if (!rows) return [];
    const mine = rows.filter((r) => r.chat?.chatId === activeChatId);
    return [...mine, ...rows.filter((r) => r.chat?.chatId !== activeChatId)];
  }, [rows, activeChatId]);
  const current = selected && ordered.some((r) => r.id === selected) ? selected : (ordered[0]?.id ?? null);

  return (
    <div data-telem="root" className={cn("flex min-h-0 bg-plane-pane", className)}>
      {/* Watching */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-plane-border pt-14">
        <div className="flex items-baseline justify-between px-4">
          <h2 className="text-[15px] leading-6 font-semibold text-plane-ink">Watching</h2>
          <span className="text-[12px] text-plane-faint">Telem Monitors</span>
        </div>
        <div data-telem="list" className={cn(SCROLL, "mt-2 flex-1 px-2 pb-3")}>
          {rows === null ? null : !configured ? (
            <Empty>Telem isn’t configured: set TELEM_API_KEY in .env.local.</Empty>
          ) : ordered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 pt-8 text-center">
              <Eye aria-hidden size={20} className="text-plane-faint" />
              <p className="text-[13px] leading-5 text-plane-muted">
                After a chat’s first research turn, Telem watches its topic daily. Or ask Claude to “watch” something.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {ordered.map((row) => (
                <li key={row.id}>
                  <Button
                    variant="nav"
                    data-telem-monitor={row.id}
                    aria-current={row.id === current || undefined}
                    onClick={() => setSelected(row.id)}
                    className={cn(
                      "flex w-full flex-col items-stretch gap-1 rounded-md border-0 px-2 py-2 text-left h-auto font-normal whitespace-normal active:not-aria-[haspopup]:translate-y-0",
                      row.id === current ? "bg-plane-active hover:bg-plane-active" : "hover:bg-plane-band",
                    )}
                  >
                    <span className="line-clamp-2 text-[13px] leading-5 text-plane-ink">{row.query}</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-4 text-plane-muted">
                      <StatusPill status={statusOf(row)} />
                      <span>{FREQUENCY_LABEL[row.frequency] ?? row.frequency}</span>
                      <span>{formatUsd(row.agent?.spend_usd)}</span>
                      {row.chat?.chatId === activeChatId && <span className="text-plane-brand">this chat</span>}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="px-2 pt-2 text-[12px] text-plane-state-cancelled">{error}</p>}
        </div>
        {/* ── <UsageSection /> slot: Telem-3's usage section (usage-section.tsx) ── */}
        <div data-telem="usage" className="shrink-0">
          <UsageSection />
        </div>
      </aside>

      {current ? (
        <MonitorPane key={current} id={current} onChanged={loadList} onDeleted={() => { setSelected(null); void loadList(); }} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[13px] text-plane-muted">
          {rows === null ? "" : "Nothing watched yet"}
        </div>
      )}
    </div>
  );
}

function MonitorPane({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [detail, setDetail] = useState<MonitorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openObject, setOpenObject] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [waitingReply, setWaitingReply] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getJson<MonitorDetail>(monitorEndpoint(id)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const running = Boolean(detail?.agent?.running_job) || detail?.agent?.status === "compiling" || waitingReply;
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), running ? BUSY_EVERY : DETAIL_EVERY);
    return () => clearInterval(timer);
  }, [load, running]);

  const act = async (label: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      await load();
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!detail) {
    return (
      <div data-telem="detail" className="flex flex-1 items-center justify-center text-[13px] text-plane-muted">
        {error ?? ""}
      </div>
    );
  }

  const { monitor, agent } = detail;
  const status = statusOf({ status: monitor.status, agent_state: monitor.agent_state, agent });
  const paused = monitor.status === "paused";
  const ended = monitor.status === "ended";
  const lastTick = agent?.ticks?.[0] ?? null;
  const perDay = budgetPerDay(agent?.budget);

  return (
    <div data-telem="detail" className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col pt-14">
        <header className="shrink-0 border-b border-plane-border px-6 pb-4">
          <div className="flex items-start gap-3">
            <Eye aria-hidden size={18} className="mt-0.5 shrink-0 text-plane-faint" />
            <h2 className="min-w-0 flex-1 text-[17px] leading-6 font-semibold text-plane-ink">{monitor.query}</h2>
            <StatusPill status={status} />
          </div>
          <dl className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-x-6 gap-y-2 text-[12px] leading-4">
            <Meta label="Frequency">{FREQUENCY_LABEL[monitor.frequency] ?? monitor.frequency}</Meta>
            <Meta label="Last run">{relativeTime(tickTime(lastTick))}</Meta>
            <Meta label="Next run">{relativeTime(agent?.next_tick_at ?? monitor.agent_state?.next_run_at)}</Meta>
            <Meta label="Spent so far">{formatUsd(agent?.spend_usd)}</Meta>
            <Meta label="Budget">{perDay !== null ? `${formatUsd(perDay)} a day` : "none set"}</Meta>
            <Meta label="Ends">{relativeTime(monitor.expires_at)}</Meta>
            <Meta label="Plan">{agent?.spec_version ? `v${agent.spec_version}` : "—"}</Meta>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={ended || busy !== null}
              onClick={() => act("pause", () => send(monitorEndpoint(id), "PATCH", { status: paused ? "active" : "paused" }))}
            >
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={ended || busy !== null || !agent}
              onClick={() => act("run", () => send(runEndpoint(id), "POST"), "Run started — its finds show up in a few minutes.")}
            >
              <Radar aria-hidden />
              Run now
            </Button>
            <label className="flex items-center gap-1.5 text-[12px] text-plane-muted">
              <span>Every</span>
              <select
                aria-label="Frequency"
                value={monitor.frequency}
                disabled={ended || busy !== null}
                onChange={(event) => act("frequency", () => send(monitorEndpoint(id), "PATCH", { frequency: event.target.value }))}
                className="h-7 rounded-md border border-plane-border-strong bg-plane-pane px-1.5 text-[12px] text-plane-ink-2"
              >
                {FREQUENCY_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <span className="flex-1" />
            {confirmDelete ? (
              <span className="flex items-center gap-1.5 text-[12px] text-plane-muted">
                End this monitor?
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => act("delete", () => send(monitorEndpoint(id), "DELETE")).then(onDeleted)}
                >
                  Delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button variant="ghost" size="sm" className="text-plane-muted" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                Delete
              </Button>
            )}
          </div>
          {notice && <p className="mt-2 text-[12px] text-plane-muted">{notice}</p>}
        </header>

        <div data-telem="body" className={cn(SCROLL, "flex-1 px-6 pt-4 pb-8")}>
          <div className="grid gap-x-8 gap-y-6 xl:grid-cols-2">
            <section data-telem="objects" className="min-w-0">
              <SectionTitle aside={<span className="text-[12px] text-plane-faint">qualified first</span>}>Found</SectionTitle>
              {detail.objects.length === 0 ? (
                <Empty>{agent?.status === "compiling" ? "The agent is still making its plan." : "Nothing found yet."}</Empty>
              ) : (
                <ul className="mt-1 flex flex-col">
                  {detail.objects.map((object) => (
                    <ObjectRow
                      key={object.identity_key}
                      monitorId={id}
                      object={object}
                      open={openObject === object.identity_key}
                      onToggle={() => setOpenObject((k) => (k === object.identity_key ? null : object.identity_key))}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section data-telem="changes" className="min-w-0">
              <SectionTitle>Latest changes</SectionTitle>
              <ChangeList detail={detail} />
            </section>
          </div>

          <section data-telem="panels" className="mt-6">
            <SectionTitle>Panels</SectionTitle>
            {detail.panels.length === 0 ? (
              <Empty>No panels yet. Ask the monitor’s agent for one, e.g. “Make a table of what you found.”</Empty>
            ) : (
              <div className="mt-2 grid gap-3 lg:grid-cols-2">
                {detail.panels.map((panel) => (
                  <div key={panel.id} data-telem-panel={panel.id} className="rounded-lg border border-plane-border p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium text-plane-ink">{panel.title}</span>
                      <span className="text-[12px] text-plane-faint">{panel.kind ?? panel.status}</span>
                    </div>
                    {panel.error ? (
                      <p className="mt-1 text-[12px] text-plane-state-cancelled">{panel.error}</p>
                    ) : (
                      <PanelContent version={panel.version} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {agent?.source_health?.length ? (
            <section data-telem="sources" className="mt-6">
              <SectionTitle>Where it looks</SectionTitle>
              <ul className="mt-1 flex flex-col text-[13px] leading-6 text-plane-ink-2">
                {agent.source_health.map((source, index) => (
                  <li key={String(source.name ?? index)} className="flex justify-between gap-4">
                    <span className="min-w-0 truncate">{String(source.name ?? source.kind ?? "source")}</span>
                    <span className="shrink-0 text-plane-muted">
                      {brief(source.status)} {typeof source.usd === "number" ? `· ${formatUsd(source.usd)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      <MonitorChat
        id={id}
        messages={detail.chat}
        suggestions={agent?.suggested_prompts ?? []}
        disabled={ended || !agent}
        onWaiting={setWaitingReply}
        onSent={load}
      />
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-plane-faint">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] leading-5 text-plane-ink-2">{children}</dd>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  entity_added: "New",
  value_changed: "Changed",
  fact_status_changed: "Verdict",
  alert: "Alert",
  run: "Run",
  plan_changed: "Plan",
};

function ChangeList({ detail }: { detail: MonitorDetail }) {
  const changes = [...detail.changes].reverse();
  if (changes.length === 0 && detail.events.length === 0) return <Empty>No changes yet.</Empty>;
  if (changes.length === 0) {
    return (
      <ul className="mt-1 flex flex-col text-[13px] leading-6">
        {detail.events.slice(0, 30).map((event, index) => (
          <li key={index} className="flex gap-2">
            <span className="w-16 shrink-0 text-plane-faint">tick {event.tick}</span>
            <span className="min-w-0 truncate text-plane-ink-2">
              {event.kind.replace(/_/g, " ")} {event.identity_key ?? brief(event.payload, 80)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="mt-1 flex flex-col text-[13px] leading-5">
      {changes.slice(0, 40).map((change) => {
        const after = brief(change.after, 120);
        const before = brief(change.before, 60);
        return (
          <li key={change.seq} data-telem-change={change.kind} className="flex gap-2 py-1">
            <span className="w-16 shrink-0 text-[12px] leading-5 text-plane-faint">{KIND_LABEL[change.kind] ?? words(change.kind)}</span>
            <span className="min-w-0 flex-1">
              <span className="text-plane-ink">{change.subject?.name ?? (change.kind === "run" ? "Run finished" : "Monitor")}</span>
              {(before || after) && change.kind !== "run" && (
                <span className="text-plane-muted"> {before ? `${before} → ` : ""}{after}</span>
              )}
            </span>
            <span className="shrink-0 text-[12px] text-plane-faint">{relativeTime(change.at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ObjectRow({
  monitorId,
  object,
  open,
  onToggle,
}: {
  monitorId: string;
  object: MonitorObject;
  open: boolean;
  onToggle: () => void;
}) {
  const [full, setFull] = useState<MonitorObject | null>(null);
  useEffect(() => {
    if (!open || full) return;
    getJson<{ object: MonitorObject }>(objectEndpoint(monitorId, object.identity_key))
      .then((body) => setFull(body.object))
      .catch(() => setFull(object));
  }, [open, full, monitorId, object]);
  const shown = full ?? object;

  return (
    <li data-telem-object={object.identity_key} className="border-b border-plane-border last:border-b-0">
      <Button
        variant="nav"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center justify-start gap-2 rounded-none border-0 px-0 py-2 text-left hover:bg-plane-band h-auto font-normal whitespace-normal active:not-aria-[haspopup]:translate-y-0"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-plane-ink">{object.name}</span>
        {object.urls?.[0] && <span className="shrink-0 text-[12px] text-plane-faint">{hostOf(object.urls[0])}</span>}
        <StatusPill status={object.status} />
      </Button>
      {open && (
        <div className="flex flex-col gap-3 pb-3 pl-1 text-[12px] leading-5">
          <KeyValues title="Values" values={shown.attributes} />
          <KeyValues title="Verdicts" values={shown.criteria} />
          {shown.history?.length ? (
            <div>
              <div className="text-plane-faint">History</div>
              <ul>
                {shown.history.slice(-8).map((h, i) => (
                  <li key={i} className="text-plane-ink-2">
                    {typeof h.tick === "number" ? `tick ${h.tick}: ` : ""}
                    {brief(h.status ?? h, 120)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <div className="text-plane-faint">Pages</div>
            <ul>
              {(shown.urls ?? []).slice(0, 8).map((url) => (
                <li key={url}>
                  <Button
                    variant="link"
                    nativeButton={false}
                    role="link"
                    render={<Link href={url} target="_blank" rel="noopener noreferrer" prefetch={false} />}
                    className="h-auto max-w-full justify-start gap-1 p-0 text-[12px] font-normal text-plane-brand"
                  >
                    <span className="truncate">{url}</span>
                    <ExternalLink aria-hidden size={11} className="shrink-0" />
                  </Button>
                </li>
              ))}
            </ul>
            {shown.evidence?.slice(0, 3).map((e, i) => (
              <blockquote key={i} className="mt-1 border-l-2 border-plane-border pl-2 text-plane-muted">
                {brief(e.quote ?? e.text ?? e, 220)}
              </blockquote>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function KeyValues({ title, values }: { title: string; values?: Record<string, unknown> }) {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="text-plane-faint">{title}</div>
      <dl className="grid grid-cols-[minmax(90px,max-content)_1fr] gap-x-3">
        {entries.slice(0, 16).map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="truncate text-plane-muted">{key.replace(/_/g, " ")}</dt>
            <dd className="min-w-0 text-plane-ink-2">{brief(value, 200) || "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** a panel's latest content: rows as a small table, text as text, anything else as one line */
function PanelContent({ version }: { version?: Record<string, unknown> | null }) {
  if (!version) return <p className="mt-1 text-[12px] text-plane-muted">Not computed yet.</p>;
  const data = (version.data ?? version.content ?? version.rows ?? version) as unknown;
  const rows = Array.isArray(data) ? data : Array.isArray((data as { rows?: unknown })?.rows) ? ((data as { rows: unknown[] }).rows) : null;
  if (rows && rows.length && typeof rows[0] === "object") {
    const columns = Object.keys(rows[0] as object).slice(0, 4);
    return (
      <table className="mt-2 w-full table-fixed text-left text-[12px] leading-5">
        <thead>
          <tr className="text-plane-faint">
            {columns.map((c) => (
              <th key={c} className="truncate font-normal">{c.replace(/_/g, " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((row, i) => (
            <tr key={i} className="border-t border-plane-border">
              {columns.map((c) => (
                <td key={c} className="truncate pr-2 text-plane-ink-2">{brief((row as Record<string, unknown>)[c], 60)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <p className="mt-1 line-clamp-4 text-[12px] text-plane-ink-2">{brief(data, 400)}</p>;
}

function MonitorChat({
  id,
  messages,
  suggestions,
  disabled,
  onWaiting,
  onSent,
}: {
  id: string;
  messages: MonitorChatMessage[];
  suggestions: string[];
  disabled: boolean;
  onWaiting: (waiting: boolean) => void;
  onSent: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<MonitorChatMessage[]>(messages);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setThread(messages), [messages]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, pending]);

  /* while an answer is coming, follow the chat job */
  useEffect(() => {
    if (!pending) return;
    onWaiting(true);
    let stop = false;
    const tick = async () => {
      try {
        const body = await getJson<{ messages: MonitorChatMessage[]; job: { status: string; error?: string | null } | null }>(monitorChatEndpoint(id));
        if (stop) return;
        setThread(body.messages);
        if (body.job && (body.job.status === "done" || body.job.status === "failed")) {
          if (body.job.status === "failed") setError(body.job.error ?? "The agent couldn’t answer.");
          setPending(null);
          onSent();
        }
      } catch {
        /* try again on the next tick */
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(timer);
      onWaiting(false);
    };
  }, [pending, id, onWaiting, onSent]);

  const submit = async (text: string) => {
    const message = text.trim();
    if (!message || pending) return;
    setError(null);
    setDraft("");
    setThread((t) => [...t, { role: "user", text: message }]);
    try {
      await send(monitorChatEndpoint(id), "POST", { message });
      setPending(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <aside data-telem="chat" className="flex w-[340px] shrink-0 flex-col border-l border-plane-border pt-14">
      <div className="px-4">
        <h3 className="text-[13px] leading-5 font-semibold text-plane-ink">Ask the monitor’s agent</h3>
        <p className="text-[12px] leading-4 text-plane-muted">It knows what it found, and can change what it tracks.</p>
      </div>
      <div ref={scrollRef} className={cn(SCROLL, "mt-3 flex flex-1 flex-col gap-2 px-4 pb-3")}>
        {thread.length === 0 && !pending && (
          <div className="flex flex-col gap-1.5">
            {suggestions.slice(0, 4).map((s) => (
              <Button
                key={s}
                variant="nav"
                disabled={disabled}
                onClick={() => void submit(s)}
                className="justify-start rounded-md border border-plane-border px-2.5 py-1.5 text-left text-[12px] leading-4 text-plane-ink-2 hover:bg-plane-band h-auto font-normal whitespace-normal active:not-aria-[haspopup]:translate-y-0"
              >
                {s}
              </Button>
            ))}
          </div>
        )}
        {thread.map((m, i) => (
          <div
            key={i}
            data-telem-chat={m.role === "user" ? "user" : "agent"}
            className={cn(
              "max-w-[92%] rounded-lg px-2.5 py-1.5 text-[13px] leading-5 whitespace-pre-wrap",
              m.role === "user" ? "self-end bg-plane-border text-plane-ink" : "self-start text-plane-ink-2",
            )}
          >
            {m.text}
          </div>
        ))}
        {pending && <div className="self-start text-[13px] text-plane-muted motion-safe:animate-pulse">Thinking…</div>}
        {error && (
          <div className="flex items-start gap-1 text-[12px] text-plane-state-cancelled">
            <X aria-hidden size={12} className="mt-0.5" />
            {error}
          </div>
        )}
      </div>
      <form
        className="m-3 flex items-end gap-2 rounded-xl border border-plane-border-strong p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft);
        }}
      >
        <textarea
          aria-label="Message the monitor's agent"
          value={draft}
          rows={2}
          disabled={disabled}
          placeholder={disabled ? "This monitor has ended" : "Ask what it found…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit(draft);
            }
          }}
          className={cn("min-h-0 flex-1 resize-none bg-transparent text-[13px] leading-5 text-plane-ink outline-none placeholder:text-plane-faint", NO_SCROLLBAR)}
        />
        <Button type="submit" size="icon-sm" disabled={disabled || !draft.trim() || pending !== null} aria-label="Send">
          <ArrowUp aria-hidden />
        </Button>
      </form>
    </aside>
  );
}
