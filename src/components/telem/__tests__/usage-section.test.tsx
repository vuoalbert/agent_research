import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageSection, UsageView, fillDays, providerColor } from "@/components/telem/usage-section";
import { summarizeAll, summarizeChat, type UsageRecord } from "@/lib/telem-usage";

const at = Date.UTC(2026, 10, 13, 12);
const RECORDS: UsageRecord[] = [
  { t: "telem", at, chatId: "c1", kind: "search", providers: ["exa"], latencyMs: 600, status: "ok", costUsd: 0.005, costSource: "estimated", agent: "main", sessionId: "11111111-aaaa", trajectoryId: "t-main" },
  { t: "telem", at, chatId: "c1", kind: "search", providers: ["exa", "brave"], latencyMs: 900, status: "ok", costUsd: 0.01, costSource: "estimated", agent: "sub-1", sessionId: "22222222-bbbb", fallback: true },
  { t: "telem", at: at + 86_400_000, chatId: "c1", kind: "fetch", providers: ["tavily"], latencyMs: 1500, status: "ok", costUsd: 0.001, costSource: "estimated", agent: "sub-1" },
  { t: "telem", at, chatId: "c1", kind: "search", providers: [], latencyMs: 3000, status: "error", costUsd: 0, costSource: "estimated", agent: "main" },
  { t: "claude", at, chatId: "c1", agent: "main", ok: true, costUsd: 0.6, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { t: "claude", at, chatId: "c1", agent: "sub-1", title: "Market size", ok: true, costUsd: 0.2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { t: "job", at, chatId: "c1", kind: "visualize", jobId: "j1" },
];
const CHAT = summarizeChat("c1", RECORDS);
const ALL = summarizeAll(new Map([["c1", RECORDS]]));

afterEach(() => vi.unstubAllGlobals());

describe("UsageView — this chat", () => {
  it("shows the totals as stat tiles", () => {
    render(<UsageView scope="chat" chat={CHAT} />);
    const stat = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement!;
    expect(within(stat("Searches")).getByText("3")).toBeTruthy();
    expect(within(stat("Page reads")).getByText("1")).toBeTruthy();
    expect(within(stat("Median latency")).getByText("900 ms")).toBeTruthy();
    expect(within(stat("Median latency")).getByText("p95 1.5 s")).toBeTruthy();
    expect(within(stat("Failures")).getByText("1 fell back")).toBeTruthy();
    expect(within(stat("Telem cost")).getByText("$0.016")).toBeTruthy();
    expect(within(stat("Telem cost")).getByText("estimated")).toBeTruthy();
    expect(within(stat("Claude turns")).getByText("+ 1 subagent runs")).toBeTruthy();
    expect(within(stat("Claude cost")).getByText("$0.800")).toBeTruthy();
    expect(within(stat("Figures")).getByText("1")).toBeTruthy();
  });

  it("shows each provider as a chip with its share, in the provider's own color", () => {
    const { container } = render(<UsageView scope="chat" chat={CHAT} />);
    const chips = [...container.querySelectorAll("[data-provider]")];
    expect(chips.map((chip) => chip.getAttribute("data-provider"))).toEqual(["exa", "brave", "tavily"]);
    expect(within(chips[0] as HTMLElement).getByText("50%")).toBeTruthy();
    expect(providerColor("exa")).not.toBe(providerColor("brave"));
    expect(providerColor("somebody-new")).toBe(providerColor("another-new"));
  });

  it("draws the research tree, main then its subagents, each linking to the Telem console", () => {
    const { container } = render(<UsageView scope="chat" chat={CHAT} />);
    const tree = container.querySelector("[data-telem='tree']")!;
    const rows = [...tree.querySelectorAll("li[data-agent]")];
    expect(rows.map((row) => row.getAttribute("data-agent"))).toEqual(["main", "sub-1"]);
    expect(within(rows[1] as HTMLElement).getByText("Market size")).toBeTruthy();
    expect(rows[1].textContent).toContain("1 search · 1 read");
    const links = tree.querySelectorAll<HTMLAnchorElement>("[data-telem='console-link']");
    expect(links).toHaveLength(2);
    expect(links[0].href).toBe("https://app.telem.ai/");
    expect(links[0].title).toContain("session 11111111-aaaa");
    expect(links[0].title).toContain("trajectory t-main");
  });

  it("says so when there is no chat, or nothing in it", () => {
    const { rerender } = render(<UsageView scope="chat" hasChat={false} />);
    expect(screen.getByText("Open a chat to see what its research used.")).toBeTruthy();
    rerender(<UsageView scope="chat" chat={summarizeChat("c2", [])} />);
    expect(screen.getByText("No research in this chat yet.")).toBeTruthy();
  });
});

describe("UsageView — all chats", () => {
  it("shows totals, calls by day with a table view, by provider, and recent chats", () => {
    const { container } = render(<UsageView scope="all" all={ALL} chatTitles={{ c1: "Battery prices" }} />);
    const days = container.querySelector("[data-telem='by-day']")!;
    expect(days.querySelectorAll("[data-day]")).toHaveLength(2);
    expect(within(days as HTMLElement).getByRole("table", { hidden: true }).querySelectorAll("tbody tr")).toHaveLength(2);
    fireEvent.pointerEnter(days.querySelectorAll("[data-day]")[0]);
    expect(days.textContent).toContain("3 calls");
    expect(container.querySelector("[data-telem='by-provider']")!.textContent).toContain("exa");
    expect(screen.getByText("Battery prices")).toBeTruthy();
  });

  it("switches scope from the toggle", () => {
    const onScope = vi.fn();
    render(<UsageView scope="chat" chat={CHAT} onScope={onScope} />);
    fireEvent.click(screen.getByRole("button", { name: "All chats" }));
    expect(onScope).toHaveBeenCalledWith("all");
  });
});

describe("fillDays", () => {
  it("puts the quiet days in at zero, and keeps the last 30", () => {
    const d = (day: string, searches = 1) => ({ day, searches, fetches: 0, telemCostUsd: 0, claudeCostUsd: 0 });
    expect(fillDays([d("2026-11-10"), d("2026-11-13")]).map((x) => [x.day, x.searches])).toEqual([
      ["2026-11-10", 1], ["2026-11-11", 0], ["2026-11-12", 0], ["2026-11-13", 1],
    ]);
    const long = fillDays([d("2026-01-01"), d("2026-11-13")]);
    expect(long).toHaveLength(30);
    expect(long.at(-1)!.day).toBe("2026-11-13");
  });
});

describe("UsageSection", () => {
  it("loads the given chat's usage from the API, then all chats on the toggle", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("scope=all") ? { scope: "all", usage: ALL } : { scope: "chat", usage: CHAT }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<UsageSection chatId="c1" />);
    await waitFor(() => expect(container.querySelector("[data-telem='tree']")).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/telem/usage?chat=c1");
    fireEvent.click(screen.getByRole("button", { name: "All chats" }));
    await waitFor(() => expect(container.querySelector("[data-telem='by-day']")).toBeTruthy());
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/telem/usage?scope=all");
  });
});
