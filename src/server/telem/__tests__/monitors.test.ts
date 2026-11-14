import { describe, expect, it } from "vitest";

import { TelemError, chatReply, createMonitorsClient, waitForJob } from "../monitors";

import { MONITOR_ID, fakeTelem, monitorJson } from "./fake";

describe("the monitors client", () => {
  it("creates a monitor with an agent, daily, for 7 days, with the bearer key", async () => {
    const { client, calls } = fakeTelem({ "POST /v1/monitors": monitorJson() });
    const monitor = await client.create({ query: "Solid-state battery production announcements" });
    expect(monitor.id).toBe(MONITOR_ID);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/monitors",
      auth: "Bearer test-key",
      body: { query: "Solid-state battery production announcements", options: { frequency: "1d" }, ttl: "7d", agent: true },
    });
  });

  it("reads changes from a cursor and builds every agent path", async () => {
    const { client, calls } = fakeTelem({
      [`GET /v1/monitors/${MONITOR_ID}/agent/changes`]: { changes: [], next_cursor: 5, watermark: 5 },
      [`POST /v1/monitors/${MONITOR_ID}/agent/ticks`]: { job_id: "j1" },
      [`GET /v1/monitors/${MONITOR_ID}/agent/objects/a%2Fb`]: { identity_key: "a/b", name: "A", status: "qualified" },
      [`POST /v1/monitors/${MONITOR_ID}/agent/chat`]: { job_id: "j2", message_id: "m" },
    });
    await client.changes(MONITOR_ID, { cursor: 3 });
    await client.runNow(MONITOR_ID);
    await client.object(MONITOR_ID, "a/b");
    await client.chat(MONITOR_ID, "What did you find?");
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      `GET /v1/monitors/${MONITOR_ID}/agent/changes?cursor=3`,
      `POST /v1/monitors/${MONITOR_ID}/agent/ticks`,
      `GET /v1/monitors/${MONITOR_ID}/agent/objects/a%2Fb`,
      `POST /v1/monitors/${MONITOR_ID}/agent/chat`,
    ]);
    expect(calls[3].body).toEqual({ message: "What did you find?" });
  });

  it("turns both error shapes into a TelemError with the status and code", async () => {
    const { client } = fakeTelem({
      [`GET /v1/monitors/${MONITOR_ID}`]: new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
    });
    await expect(client.get(MONITOR_ID)).rejects.toMatchObject({ status: 404, message: expect.stringContaining("Not Found") });
    await expect(client.agent(MONITOR_ID)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(client.agent(MONITOR_ID)).rejects.toBeInstanceOf(TelemError);
  });

  it("waits out one 429 and retries", async () => {
    let n = 0;
    const waits: number[] = [];
    const client = createMonitorsClient({
      apiKey: "k",
      sleep: async (ms) => void waits.push(ms),
      fetch: async () =>
        ++n === 1
          ? new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "retry-after": "3" } })
          : new Response(JSON.stringify({ monitors: [], next_cursor: null })),
    });
    await expect(client.list()).resolves.toEqual({ monitors: [], next_cursor: null });
    expect(waits).toEqual([3000]);
  });

  it("refuses to call Telem without a key", async () => {
    const saved = process.env.TELEM_API_KEY;
    delete process.env.TELEM_API_KEY;
    await expect(createMonitorsClient({ fetch: async () => new Response("{}") }).list()).rejects.toMatchObject({ code: "not_configured" });
    if (saved !== undefined) process.env.TELEM_API_KEY = saved;
  });

  it("follows a chat job to its reply", async () => {
    let polls = 0;
    const { client } = fakeTelem({
      [`GET /v1/monitors/${MONITOR_ID}/agent/jobs/j2`]: () =>
        ++polls < 2 ? { id: "j2", kind: "chat", status: "running" } : { id: "j2", kind: "chat", status: "done", result: { reply: "Two new plants." } },
    });
    const job = await waitForJob(client, MONITOR_ID, "j2", { sleep: async () => undefined });
    expect(chatReply(job)).toBe("Two new plants.");
    expect(chatReply({ id: "x", kind: "chat", status: "done", result: null }, [{ role: "user", text: "hi" }, { role: "agent", text: "Hello" }])).toBe("Hello");
  });
});
