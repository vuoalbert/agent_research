import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiThread } from "@/components/ai/thread";
import { TabViewProvider, useTabView } from "@/components/tab-view-context";
import { VisualizeToolRow } from "@/components/visualize/visualize-tool-row";
import { VisualizeView } from "@/components/visualize/visualize-view";
import type { Message, ToolCall } from "@/lib/agent-store";
import type { JobDetail, JobStatus } from "@/lib/visualize";

/**
 * The chat's Visualize row (a Box, following its job, opening the view) and
 * the Visualize view — the one current visualization — against a mocked
 * /api/visualize.
 */

const NOW = Date.UTC(2026, 10, 14, 13, 0, 0);
const ID = "20261114-1300-a-dial-indicator-gauge-ab12";

function job(status: JobStatus, extra: Partial<JobDetail> = {}): JobDetail {
  return {
    id: ID,
    subject: "a dial indicator gauge",
    status,
    createdAt: NOW - 120_000,
    startedAt: NOW - 120_000,
    ...(status === "running" || status === "queued" ? {} : { endedAt: NOW - 1_000 }),
    elapsedMs: 119_000,
    log: [
      { t: NOW - 60_000, text: "Skill: studio:anatomy" },
      { t: NOW - 30_000, text: "Bash: node build.mjs --light" },
    ],
    ...extra,
  };
}

/** /api/visualize answering from `current`, which a test can change between polls */
let current: JobDetail | null = null;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/visualize/current")) return Response.json({ job: current });
  const stop = /^\/api\/visualize\/jobs\/([^/?]+)\/stop$/.exec(url);
  if (stop && init?.method === "POST" && current?.id === stop[1]) {
    current = { ...current, status: "stopped", error: "Stopped before it finished.", endedAt: NOW };
    return Response.json({ job: current });
  }
  const one = /^\/api\/visualize\/jobs\/([^/?]+)\?lines=(\d+)$/.exec(url);
  if (one && current?.id === decodeURIComponent(one[1])) {
    return Response.json({ job: one[2] === "0" ? { ...current, log: [] } : current });
  }
  return Response.json({ error: "no such job" }, { status: 404 });
});

const jobCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`/api/visualize/jobs/${ID}?`)).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  current = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** let pending fetches resolve and their renders land */
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const visualizeCall = (extra: Partial<ToolCall> = {}): ToolCall => ({
  id: ID,
  name: "Visualize",
  action: "visualize",
  jobId: ID,
  query: "a dial indicator gauge",
  status: "done",
  ...extra,
});

function ViewProbe() {
  return <output data-testid="view">{useTabView()?.view ?? "none"}</output>;
}

describe("the Visualize tool row", () => {
  it("shows a Box, 'Visualize' and the subject, and pulses while its JOB runs, polling until it is done", async () => {
    current = job("running");
    const { container } = render(<VisualizeToolRow call={visualizeCall()} />);
    const row = container.querySelector('[data-ai="tool"]') as HTMLElement;
    expect(row.dataset.action).toBe("visualize");
    expect(row.querySelector("svg.lucide-box")).not.toBeNull();
    expect(row.querySelector("svg.lucide-wrench")).toBeNull();
    expect(row.textContent).toBe("Visualizea dial indicator gauge");
    // the call is done, but the job is not: still pulsing
    expect(row.className).toContain("animate-pulse");

    await flush();
    expect(row.dataset.status).toBe("running");
    expect(row.className).toContain("animate-pulse");
    expect(jobCalls()).toBe(1);

    await flush(3000);
    expect(jobCalls()).toBe(2);

    current = job("done", { figure: "figure.html" });
    await flush(3000);
    expect(row.dataset.status).toBe("done");
    expect(row.className).not.toContain("animate-pulse");
    expect(row.textContent).toBe("Visualizea dial indicator gauge· ready");

    // a finished job is not asked about again
    const calls = jobCalls();
    await flush(9000);
    expect(jobCalls()).toBe(calls);
  });

  it.each([
    ["error", "· failed"],
    ["stopped", "· stopped"],
    ["interrupted", "· interrupted"],
  ] as const)("says when its job %s", async (status, suffix) => {
    current = job(status);
    const { container } = render(<VisualizeToolRow call={visualizeCall()} />);
    await flush();
    expect(container.textContent).toContain(suffix);
  });

  it("says 'replaced' once a newer figure took its place, and stops asking", async () => {
    current = null;
    const { container } = render(<VisualizeToolRow call={visualizeCall()} />);
    await flush();
    expect(container.textContent).toBe("Visualizea dial indicator gauge· replaced");
    expect((container.firstElementChild as HTMLElement).className).not.toContain("animate-pulse");
    await flush(9000);
    expect(jobCalls()).toBe(1);
  });

  it("opens the Visualize view when clicked", async () => {
    current = job("running");
    render(
      <TabViewProvider>
        <VisualizeToolRow call={visualizeCall()} />
        <ViewProbe />
      </TabViewProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Visualize/ }));
    expect(screen.getByTestId("view").textContent).toBe("Visualize");
  });

  it("is a plain muted row when a figure was already building, and asks nothing", () => {
    const { container } = render(
      <VisualizeToolRow call={visualizeCall({ id: "x", jobId: undefined, query: "already building a pin-tumbler lock" })} />,
    );
    const row = container.querySelector('[data-ai="tool"]') as HTMLElement;
    expect(container.querySelector("button")).toBeNull();
    expect(row.dataset.status).toBe("busy");
    expect(row.textContent).toBe("Visualizealready building a pin-tumbler lock");
    expect(row.querySelector("span")?.className).toContain("text-[var(--ai-muted)]");
    expect(row.querySelector("span")?.className).not.toContain("font-medium");
    expect(row.className).not.toContain("animate-pulse");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a plain failed row when the figure could not start", () => {
    const { container } = render(<VisualizeToolRow call={visualizeCall({ id: "x", jobId: undefined, status: "error" })} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("· failed");
  });

  it("takes the place of the wrench row in the thread, leaving the other rows as they were", async () => {
    current = job("running");
    const messages: Message[] = [
      { id: "u1", role: "user", content: "Visualize how a dial indicator gauge works.", createdAt: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "It's building in the background.",
        createdAt: 2,
        tools: [{ id: "t1", name: "Tavily", query: "dial indicator mechanism", status: "done" }, visualizeCall()],
      },
    ];
    const { container } = render(<AiThread messages={messages} />);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-ai="tool"]')];
    expect(rows.map((r) => r.dataset.action)).toEqual(["search", "visualize"]);
    expect(rows[0].querySelector("svg.lucide-wrench")).not.toBeNull();
    expect(rows[1].querySelector("svg.lucide-box")).not.toBeNull();
    await flush();
  });
});

describe("the Visualize view", () => {
  it("asks for a visualization when there is none", async () => {
    render(<VisualizeView />);
    await flush();
    expect(screen.getByText("Ask Claude to visualize something")).toBeTruthy();
  });

  it("shows the one visualization: subject, status, elapsed time and progress while it builds, with Stop", async () => {
    current = job("running");
    const { container } = render(<VisualizeView />);
    await flush();

    const view = container.querySelector('[data-visualize="running"]') as HTMLElement;
    expect(view).not.toBeNull();
    expect(within(view).getByRole("heading").textContent).toBe("a dial indicator gauge");
    expect(view.querySelector('[data-status-chip="running"]')).not.toBeNull();
    expect(view.querySelector("[data-elapsed]")?.textContent).toBe("2m 00s");
    expect([...view.querySelectorAll("[data-log-line]")].map((li) => li.textContent?.slice(8))).toEqual([
      "Skill: studio:anatomy",
      "Bash: node build.mjs --light",
    ]);
    expect(view.querySelector("iframe")).toBeNull();
    // no list of jobs: one visualization only
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelectorAll("section")).toHaveLength(1);

    // the clock ticks between polls
    await flush(1000);
    expect(view.querySelector("[data-elapsed]")?.textContent).toBe("2m 01s");

    fireEvent.click(within(view).getByRole("button", { name: /Stop/ }));
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(`/api/visualize/jobs/${ID}/stop`, { method: "POST" });
    expect(container.querySelector('[data-visualize="stopped"]')).not.toBeNull();
    expect(container.textContent).toContain("Stopped before it finished.");
  });

  it("shows a finished figure in a script-only sandboxed iframe filling the whole view", async () => {
    current = job("done", { figure: "figure.html" });
    const { container } = render(<VisualizeView />);
    await flush();
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`/api/visualize/jobs/${ID}/figure`);
    expect(frame.getAttribute("title")).toBe("a dial indicator gauge");
    // it fills the whole view from the very top, the header floating over it with no background
    expect(frame.className).toContain("absolute inset-0");
    expect(frame.className).toContain("mask-image");
    const header = container.querySelector("header") as HTMLElement;
    expect(header.className).toContain("absolute");
    expect(header.className).not.toMatch(/\bbg-|border-b/);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it.each([
    ["error", "Ran out of time: 60 minutes without a finished figure."],
    ["stopped", "Stopped before it finished."],
    ["interrupted", "The server restarted while this figure was being built."],
  ] as const)("says why it ended %s, with what it got to", async (status, error) => {
    current = job(status, { error });
    const { container } = render(<VisualizeView />);
    await flush();
    const view = container.querySelector(`[data-visualize="${status}"]`) as HTMLElement;
    expect(view.textContent).toContain(error);
    expect(view.querySelectorAll("[data-log-line]")).toHaveLength(2);
    expect(view.querySelector("iframe")).toBeNull();
  });

  it("switches to a new visualization when one replaces the current", async () => {
    current = job("done", { figure: "figure.html" });
    const { container } = render(<VisualizeView />);
    await flush();
    expect(container.querySelector("iframe")).not.toBeNull();
    current = { ...job("running"), id: "20261114-1400-a-lock-cd34", subject: "a pin-tumbler lock" };
    await flush(3000);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("a pin-tumbler lock");
  });

  it("hides its scrollbars", async () => {
    current = job("running");
    const { container } = render(<VisualizeView />);
    await flush();
    const scrollers = container.querySelectorAll(".overflow-y-auto");
    expect(scrollers.length).toBeGreaterThan(0);
    for (const scroller of scrollers) expect(scroller.className).toContain("[scrollbar-width:none]");
  });

  it("asks every 3 seconds while it is open, and stops when it closes", async () => {
    const { unmount } = render(<VisualizeView />);
    await flush();
    const calls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/visualize/current")).length;
    expect(calls()).toBe(1);
    await flush(3000);
    expect(calls()).toBe(2);
    unmount();
    await flush(9000);
    expect(calls()).toBe(2);
  });
});

describe("messages to the Visualize agent", () => {
  const askedCall = (extra: Partial<ToolCall> = {}): ToolCall =>
    visualizeCall({ id: "m1", action: "visualize-message", query: "make the bell dome blue", ...extra });

  it("is a muted 'Visualize · Asked: …' row that pulses while the agent applies it, then says it was applied", async () => {
    current = job("running");
    const { container } = render(<VisualizeToolRow call={askedCall()} />);
    const row = container.querySelector('[data-ai="tool"]') as HTMLElement;
    expect(row.dataset.action).toBe("visualize-message");
    expect(row.textContent).toBe("Visualize· Asked:make the bell dome blue");
    expect(within(row).getByText("Visualize").className).toContain("text-[var(--ai-muted)]");
    expect(within(row).getByText("Visualize").className).not.toContain("font-medium");
    await flush();
    expect(row.className).toContain("animate-pulse");

    current = job("done", { figure: "figure.html" });
    await flush(3000);
    expect(row.className).not.toContain("animate-pulse");
    expect(row.textContent).toBe("Visualize· Asked:make the bell dome blue· applied");
  });

  it("is a failed row when the message could not be sent", () => {
    const { container } = render(<VisualizeToolRow call={askedCall({ jobId: undefined, status: "error" })} />);
    expect(container.textContent).toBe("Visualize· Asked:make the bell dome blue· failed");
  });

  it("goes in the thread where the wrench row would", async () => {
    current = job("running");
    const message: Message = {
      id: "a1",
      role: "assistant",
      content: "The Visualize agent is applying it.",
      createdAt: 2,
      tools: [askedCall()],
    };
    const { container } = render(<AiThread messages={[message]} />);
    await flush();
    const row = container.querySelector('[data-action="visualize-message"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector("svg.lucide-box")).not.toBeNull();
  });

  it("keeps the header to the time: the agent's last reply does not show there", async () => {
    current = job("done", { figure: "figure.html", lastReply: "Made the dome blue and labelled the striker." });
    const { container } = render(<VisualizeView />);
    await flush();
    expect(container.querySelector("[data-last-reply]")).toBeNull();
    expect(container.querySelector("header")?.textContent).not.toContain("Made the dome blue");
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("shows progress, not the old page, while a finished figure is being updated — then the new page", async () => {
    current = job("running", {
      figure: "figure.html",
      log: [
        { t: NOW - 20_000, text: "Message from chat: add a caption saying 'ring ring'" },
        { t: NOW - 10_000, text: "Resumed the background agent's session to apply it" },
      ],
    });
    const { container } = render(<VisualizeView />);
    await flush();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("updating this figure with the chat’s message");
    const lines = [...container.querySelectorAll("[data-log-line]")] as HTMLElement[];
    // the chat's message stands out from the agent's own lines
    expect(lines[0].hasAttribute("data-message")).toBe(true);
    expect(lines[0].querySelector(".font-medium")?.textContent).toBe("Message from chat: add a caption saying 'ring ring'");
    expect(lines[1].hasAttribute("data-message")).toBe(false);

    current = job("done", { figure: "figure.html", lastReply: "Added the caption." });
    await flush(3000);
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(container.querySelector("[data-last-reply]")).toBeNull();
  });
});
