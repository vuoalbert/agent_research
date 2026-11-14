// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitTelemCall } from "@/server/telem/events";
import { createUsageStore, recordClaudeResult, startUsageRecorder, stopUsageRecorder } from "@/server/telem/usage";

import { GET } from "../usage/route";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "telem-usage-route-"));
  startUsageRecorder(createUsageStore(dir));
});
afterEach(() => {
  stopUsageRecorder();
  rmSync(dir, { recursive: true, force: true });
});

const get = (query: string) => GET(new Request(`http://localhost/api/telem/usage${query}`));

describe("GET /api/telem/usage", () => {
  it("asks for a chat or scope=all", async () => {
    expect((await get("")).status).toBe(400);
  });

  it("returns one chat's usage, including calls still being written", async () => {
    emitTelemCall({ kind: "search", providers: ["brave"], latencyMs: 700, status: "ok", chatId: "c1", sessionId: "s1" });
    recordClaudeResult({ type: "result", subtype: "success", total_cost_usd: 0.3 }, { chatId: "c1" });
    const response = await get("?chat=c1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.scope).toBe("chat");
    expect(body.usage.totals).toMatchObject({ searches: 1, claudeTurns: 1, latencyP50Ms: 700 });
    expect(body.usage.providers[0]).toMatchObject({ provider: "brave", share: 1 });
    expect(body.usage.sessionIds).toEqual(["s1"]);
  });

  it("returns an empty summary for a chat with nothing recorded", async () => {
    const body = await (await get("?chat=nobody")).json();
    expect(body.usage.totals.searches).toBe(0);
    expect(body.usage.tree.subagents).toEqual([]);
  });

  it("totals every chat with scope=all", async () => {
    emitTelemCall({ kind: "search", providers: ["exa"], latencyMs: 500, status: "ok", chatId: "a" });
    emitTelemCall({ kind: "fetch", providers: ["tavily"], latencyMs: 900, status: "ok", chatId: "b" });
    const body = await (await get("?scope=all")).json();
    expect(body.scope).toBe("all");
    expect(body.usage.totals).toMatchObject({ searches: 1, fetches: 1 });
    expect(body.usage.days).toHaveLength(1);
    expect(body.usage.providers.map((p: { provider: string }) => p.provider).sort()).toEqual(["exa", "tavily"]);
    expect(body.usage.chats).toHaveLength(2);
  });
});
