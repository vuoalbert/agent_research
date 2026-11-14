import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TelemView } from "../telem-view";
import { WatchToolRow } from "../watch-tool-row";

const ID = "6f1c0000-0000-4000-8000-000000000001";

const row = {
  id: ID,
  query: "Solid-state battery production announcements",
  frequency: "1d",
  status: "active",
  chat: null,
  agent: { status: "ready", spend_usd: 0.012, budget: null, next_tick_at: null, last_tick: null, counts: null },
};
const detail = {
  monitor: { ...row, agent_state: { status: "ready" }, expires_at: null },
  agent: { status: "ready", spend_usd: 0.012, budget: { tick_budget_usd: 0.1, daily_budget_usd: 0.15 }, ticks: [], suggested_prompts: ["What changed this week?"] },
  changes: [{ seq: 2, kind: "entity_added", subject: { name: "QuantumScape Cobra line" }, after: { status: "candidate" }, at: "2026-11-14T11:00:00Z" }],
  events: [],
  objects: [{ identity_key: "k1", name: "QuantumScape Cobra line", status: "qualified", urls: ["https://example.com/qs"] }],
  objectsTotal: 1,
  panels: [{ id: "p1", title: "Plants", kind: "table", version: { rows: [{ name: "Cobra", stage: "production" }] } }],
  chat: [],
  jobs: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("TelemView", () => {
  it("lists the monitors and shows the selected one's finds, changes, panels and chat", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (url === "/api/telem/monitors") return json({ configured: true, monitors: [row] });
      if (url === `/api/telem/monitors/${ID}`) return json(detail);
      if (url === `/api/telem/monitors/${ID}/objects/k1`)
        return json({ object: { ...detail.objects[0], attributes: { stage: "production" }, criteria: { announced: "yes" } } });
      if (url === `/api/telem/monitors/${ID}/run` && init?.method === "POST") return json({ jobId: "j1" });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TelemView />);

    expect(await screen.findByRole("heading", { name: row.query }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText("$0.012").length).toBeGreaterThan(0);
    expect(screen.getByText("$0.150 a day")).toBeTruthy();
    expect(screen.getByText("Plants")).toBeTruthy();
    expect(screen.getByText("What changed this week?")).toBeTruthy();

    fireEvent.click(screen.getAllByText("QuantumScape Cobra line").find((el) => el.closest("[data-telem-object]"))!);
    expect(await screen.findByText("announced", undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/telem/monitors/${ID}/run`, expect.objectContaining({ method: "POST" })));
  });

  it("says so when Telem is not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ configured: false, monitors: [] }))));
    render(<TelemView />);
    expect(await screen.findByText(/TELEM_API_KEY/, undefined, { timeout: 5000 })).toBeTruthy();
  });
});

describe("WatchToolRow", () => {
  it("reads Telem · Watching <topic>, with an eye and no counts", () => {
    const { container } = render(
      <WatchToolRow call={{ id: "1", name: "Telem", action: "watch", query: "Watching solid-state batteries", status: "done" }} />,
    );
    expect(container.textContent).toBe("Telem·Watching solid-state batteries");
    expect(container.querySelector('[data-icon="eye"]')).toBeTruthy();
  });

  it("uses a radar for a run", () => {
    const { container } = render(<WatchToolRow call={{ id: "1", name: "Telem", action: "watch", query: "Running x", status: "running" }} />);
    expect(container.querySelector('[data-icon="radar"]')).toBeTruthy();
  });
});
