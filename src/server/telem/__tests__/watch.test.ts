import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTelemWatchServer, TELEM_WATCH_TOOLS } from "@/app/api/chat/telem-watch-tools";

import { readChatWatch } from "../store";
import { autoWatch, MODEST_BUDGET, topicOf } from "../watch";

import { MONITOR_ID, fakeTelem, monitorJson } from "./fake";

const temp = () => mkdtempSync(join(tmpdir(), "telem-watch-"));

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlerOf = (server: ReturnType<typeof createTelemWatchServer>, name: string) => {
  const tools = (server as unknown as { instance: { _registeredTools: Record<string, { handler?: Handler; callback?: Handler }> } }).instance._registeredTools;
  const t = tools[name];
  return (t.handler ?? t.callback) as Handler;
};

describe("watching a chat's topic", () => {
  it("auto-watches a chat once, daily, with a modest budget", async () => {
    const dir = temp();
    const { client, calls } = fakeTelem({
      "POST /v1/monitors": monitorJson(),
      [`PATCH /v1/monitors/${MONITOR_ID}/agent`]: { monitor_id: MONITOR_ID, status: "compiling", query: "q", frequency: "1d" },
    });
    const first = await autoWatch({ chatId: "c1", question: "Who is building solid-state battery plants?" }, { client, dir, enabled: true });
    expect(first?.record).toMatchObject({ id: MONITOR_ID, auto: true, frequency: "1d", cursor: 0 });
    expect(calls[0].body).toMatchObject({ options: { frequency: "1d" }, ttl: "7d", agent: true });
    expect(calls[1]).toMatchObject({ method: "PATCH", body: { budget: MODEST_BUDGET } });

    expect(await autoWatch({ chatId: "c1", question: "again" }, { client, dir, enabled: true })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect((await readChatWatch("c1", dir)).monitors).toHaveLength(1);
  });

  it("does nothing when Telem is off or there is no chat", async () => {
    const { client, calls } = fakeTelem({});
    expect(await autoWatch({ chatId: "c1", question: "q" }, { client, dir: temp(), enabled: false })).toBeNull();
    expect(await autoWatch({ question: "q" }, { client, dir: temp(), enabled: true })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("keeps a monitor query to one line under 300 characters", () => {
    const long = `${"word ".repeat(100)}end`;
    expect(topicOf(long).length).toBeLessThanOrEqual(300);
    expect(topicOf("  a\n b  ")).toBe("a b");
  });
});

describe("the chat's Telem tools", () => {
  it("has the six tools", () => {
    expect(TELEM_WATCH_TOOLS).toEqual(["watch_topic", "monitor_status", "ask_monitor", "pause_monitor", "resume_monitor", "run_monitor_now"]);
  });

  it("watch_topic reports one 'Watching' row, no counts, and records the monitor", async () => {
    const dir = temp();
    const rows: Record<string, unknown>[] = [];
    const { client } = fakeTelem({
      "POST /v1/monitors": monitorJson(),
      [`PATCH /v1/monitors/${MONITOR_ID}/agent`]: {},
    });
    const server = createTelemWatchServer({ chatId: "c2", onActivity: (a) => rows.push(a), client, dir });
    const result = await handlerOf(server, "watch_topic")({ query: "Solid-state battery production announcements", frequency: "7d" });
    expect(result.isError).toBeUndefined();
    expect(rows[0]).toMatchObject({ name: "Telem", action: "watch", query: "Watching Solid-state battery production announcements", status: "running" });
    expect(rows[1]).toMatchObject({ status: "done" });
    expect(Object.keys(rows[1])).toEqual(["id", "status"]);
    expect((await readChatWatch("c2", dir)).monitors[0].id).toBe(MONITOR_ID);
  });

  it("ask_monitor sends the message to the monitor's agent and returns its answer", async () => {
    const dir = temp();
    const rows: Record<string, unknown>[] = [];
    const { client, calls } = fakeTelem({
      "POST /v1/monitors": monitorJson(),
      [`PATCH /v1/monitors/${MONITOR_ID}/agent`]: {},
      [`POST /v1/monitors/${MONITOR_ID}/agent/chat`]: { job_id: "j9", message_id: "m" },
      [`GET /v1/monitors/${MONITOR_ID}/agent/jobs/j9`]: { id: "j9", kind: "chat", status: "done", result: null },
      [`GET /v1/monitors/${MONITOR_ID}/agent/chat`]: { messages: [{ role: "user", text: "What's new?" }, { role: "agent", text: "Two plants announced." }] },
    });
    const server = createTelemWatchServer({ chatId: "c3", onActivity: (a) => rows.push(a), client, dir });
    await handlerOf(server, "watch_topic")({ query: "Solid-state battery production announcements" });
    const result = await handlerOf(server, "ask_monitor")({ message: "What's new?" });
    expect(result.content[0].text).toContain("Two plants announced.");
    expect(calls.find((c) => c.path.endsWith("/agent/chat") && c.method === "POST")?.body).toEqual({ message: "What's new?" });
    expect(rows[2]).toMatchObject({ name: "Telem", query: "Asking Solid-state battery production announcements" });
  });

  it("says so when the chat watches nothing yet", async () => {
    const { client } = fakeTelem({});
    const server = createTelemWatchServer({ chatId: "none", onActivity: () => undefined, client, dir: temp() });
    const result = await handlerOf(server, "run_monitor_now")({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/isn't watching anything/);
  });
});
