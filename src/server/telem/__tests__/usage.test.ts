// @vitest-environment node
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { percentile, summarizeAll, summarizeChat, type UsageRecord } from "@/lib/telem-usage";

import { emitTelemCall, type TelemCallMeta, type TelemProviderRun } from "../events";
import { estimateTelemCost, isFallback, usageCost } from "../pricing";
import {
  claudeRecordFrom,
  createUsageStore,
  fileFor,
  recordClaudeResult,
  recordJob,
  startUsageRecorder,
  stopUsageRecorder,
  telemRecordFrom,
} from "../usage";

const run = (provider: string, status = "succeeded", over: Partial<TelemProviderRun> = {}): TelemProviderRun => ({
  provider,
  status,
  latencyMs: 900,
  results: status === "succeeded" ? 5 : 0,
  ...over,
});

let n = 0;
/** a TelemCallMeta as Telem-1's client emits it */
const call = (over: Partial<TelemCallMeta> = {}): TelemCallMeta => ({
  id: `call-${++n}`,
  kind: "search",
  caller: "chat",
  chatId: "chat-1",
  turnId: "turn-1",
  query: "solid state batteries",
  sessionId: "sess-1",
  trajectoryId: "traj-1",
  status: "succeeded",
  providers: [run("exa")],
  resultCount: 5,
  latencyMs: 1000,
  startedAt: 1_000,
  finishedAt: 2_000,
  ...over,
});

const price = (meta: TelemCallMeta) => estimateTelemCost({ kind: meta.kind, tier: meta.tier, ok: true, runs: meta.providers });

describe("cost estimation", () => {
  it("uses Telem's own figure when the call reports one", () => {
    expect(telemRecordFrom(call({ costUsd: 0.0123 }))).toMatchObject({ costUsd: 0.0123, costSource: "actual" });
  });

  it("prices each provider run that answered, at the call's tier; failed runs are free", () => {
    const meta = call({ status: "partially_succeeded", providers: [run("tavily"), run("brave"), run("exa", "failed")] });
    expect(price(meta).costUsd).toBeCloseTo(0.01);
    expect(price({ ...meta, tier: "extended" }).costUsd).toBeCloseTo(0.015);
    expect(telemRecordFrom(meta)).toMatchObject({ costSource: "estimated", providers: ["tavily", "brave"], fallback: true, status: "ok" });
  });

  it("prices a fetch per URL by the provider that served it", () => {
    const meta = call({ kind: "fetch", query: undefined, urls: ["https://a.example", "https://b.example"], providers: [run("tavily"), run("firecrawl")] });
    expect(telemRecordFrom(meta).costUsd).toBeCloseTo(0.001 + 0.000798);
    expect(estimateTelemCost({ kind: "fetch", ok: true, runs: [{ provider: "firecrawl", status: "succeeded", units: 3 }] }).costUsd).toBeCloseTo(3 * 0.000798);
  });

  it("charges nothing for a failed call, and takes a provider's reported usage as actual", () => {
    expect(telemRecordFrom(call({ status: "failed", providers: [run("exa", "failed")] }))).toMatchObject({ costUsd: 0, status: "error", providers: [] });
    expect(telemRecordFrom(call({ providers: [run("exa", "succeeded", { usage: { costDollars: { total: 0.007 } } })] }))).toMatchObject({
      costUsd: 0.007,
      costSource: "actual",
    });
    expect(usageCost({ costDollars: 0.002 })).toBe(0.002);
    expect(usageCost("nope")).toBeUndefined();
  });

  it("prices an unknown provider at a typical rate", () => {
    expect(telemRecordFrom(call({ providers: [run("brave"), run("newco")] })).costUsd).toBeCloseTo(0.01);
  });

  it("flags fallbacks: a provider failed and another answered, or Telem failed and Tavily served it", () => {
    expect(isFallback([run("exa", "failed"), run("brave")])).toBe(true);
    expect(isFallback([run("exa")])).toBe(false);
    const tavily = telemRecordFrom(call({ status: "failed", fallback: "tavily", providers: [], error: "503 all_providers_failed" }));
    expect(tavily).toMatchObject({ status: "error", fallback: true, fallbackTo: "tavily", costUsd: 0, error: "503 all_providers_failed" });
  });

  it("keeps the lineage and who made the call", () => {
    const sub = telemRecordFrom(call({ caller: "subagent", agentId: "sub-a", agentTitle: "The numbers", parentTrajectoryId: "traj-0", interactionId: "int-1" }));
    expect(sub).toMatchObject({ agent: "sub-a", title: "The numbers", caller: "subagent", turnId: "turn-1", sessionId: "sess-1", trajectoryId: "traj-1", parentTrajectoryId: "traj-0", interactionId: "int-1", at: 2_000 });
    expect(telemRecordFrom(call({ chatId: undefined })).chatId).toBe("_unscoped");
  });
});

describe("recorder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "telem-usage-"));
  });
  afterEach(() => {
    stopUsageRecorder();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends every Telem call to its chat's JSON lines file, through onTelemCall", async () => {
    const store = startUsageRecorder(createUsageStore(dir));
    emitTelemCall(call());
    emitTelemCall(call({ kind: "fetch", providers: [run("tavily")] }));
    emitTelemCall(call({ chatId: undefined }));
    await store.flush();
    const lines = readFileSync(join(dir, "chat-1.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ t: "telem", kind: "search", providers: ["exa"], costUsd: 0.005, costSource: "estimated", sessionId: "sess-1" });
    expect(readFileSync(join(dir, "_unscoped.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("subscribes once however often it is started", async () => {
    const store = startUsageRecorder(createUsageStore(dir));
    startUsageRecorder();
    startUsageRecorder();
    emitTelemCall(call());
    expect(await store.read("chat-1")).toHaveLength(1);
  });

  it("records Claude results and jobs alongside, and reads them back", async () => {
    const store = startUsageRecorder(createUsageStore(dir));
    recordClaudeResult(
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.42,
        num_turns: 3,
        modelUsage: { "claude-opus-5-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10 } },
      },
      { chatId: "chat-1", agent: "main", turn: 1 },
    );
    recordJob("chat-1", "visualize", "job-1", 1);
    const records = await store.read("chat-1");
    expect(records.map((r) => r.t)).toEqual(["claude", "job"]);
    expect(records[0]).toMatchObject({ costUsd: 0.42, inputTokens: 100, cacheReadTokens: 1000, ok: true });
  });

  it("names files safely and skips torn lines", async () => {
    expect(fileFor("../../etc/passwd")).toBe("______etc_passwd.jsonl");
    const store = createUsageStore(dir);
    store.append(telemRecordFrom(call()));
    await store.flush();
    appendFileSync(join(dir, "chat-1.jsonl"), '{"t":"telem","at":');
    expect(await store.read("chat-1")).toHaveLength(1);
    expect((await store.readAll()).get("chat-1")).toHaveLength(1);
  });
});

describe("aggregation", () => {
  const at = Date.UTC(2026, 10, 13, 12);
  const records: UsageRecord[] = [
    telemRecordFrom(call({ finishedAt: at, latencyMs: 400 })),
    telemRecordFrom(call({ finishedAt: at, latencyMs: 800, providers: [run("exa"), run("brave")] })),
    telemRecordFrom(call({ finishedAt: at, latencyMs: 3000, status: "failed", providers: [] })),
    telemRecordFrom(
      call({ finishedAt: at + 86_400_000, kind: "fetch", latencyMs: 1200, caller: "subagent", agentId: "sub-a", agentTitle: "The numbers", sessionId: "sess-2", status: "partially_succeeded", providers: [run("exa", "failed"), run("tavily")] }),
    ),
    { ...claudeRecordFrom({ type: "result", subtype: "success", total_cost_usd: 0.5 }, { chatId: "chat-1", agent: "main" }), at },
    { ...claudeRecordFrom({ type: "result", subtype: "success", total_cost_usd: 0.2 }, { chatId: "chat-1", agent: "sub-a" }), at },
    { t: "job", at, chatId: "chat-1", kind: "visualize", jobId: "j" },
  ];

  it("percentile is nearest-rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  it("summarizes a chat: counts, latency, failures, fallbacks, costs, shares and the research tree", () => {
    const usage = summarizeChat("chat-1", records);
    expect(usage.totals).toMatchObject({
      searches: 3,
      fetches: 1,
      failures: 1,
      fallbacks: 1,
      latencyP50Ms: 800,
      latencyP95Ms: 1200,
      claudeTurns: 1,
      subagentRuns: 1,
      visualizeJobs: 1,
      telemCostEstimated: true,
    });
    expect(usage.totals.telemCostUsd).toBeCloseTo(0.005 + 0.01 + 0.001);
    expect(usage.totals.claudeCostUsd).toBeCloseTo(0.7);
    expect(usage.providers.map((p) => [p.provider, p.calls])).toEqual([["exa", 2], ["brave", 1], ["tavily", 1]]);
    expect(usage.providers[0].share).toBeCloseTo(0.5);
    expect(usage.tree.main).toMatchObject({ searches: 3, fetches: 0, failures: 1, sessionIds: ["sess-1"] });
    expect(usage.tree.subagents).toEqual([expect.objectContaining({ agent: "sub-a", title: "The numbers", fetches: 1, sessionIds: ["sess-2"] })]);
    expect(usage.sessionIds).toEqual(["sess-1", "sess-2"]);
  });

  it("attributes each provider its own runs' price, not an even split of the call", () => {
    const usage = summarizeChat("c", [
      telemRecordFrom(call({ tier: "extended", providers: [run("tavily"), run("parallel")] })),
      telemRecordFrom(call({ kind: "fetch", providers: [run("tavily")] })),
    ]);
    const cost = Object.fromEntries(usage.providers.map((p) => [p.provider, p.costUsd]));
    expect(cost.tavily).toBeCloseTo(0.01 + 0.001);
    expect(cost.parallel).toBeCloseTo(0.005);
  });

  it("summarizes every chat by day and by chat", () => {
    const all = summarizeAll(new Map([["chat-1", records], ["chat-2", [telemRecordFrom(call({ finishedAt: at, chatId: "chat-2" }))]]]));
    expect(all.totals.searches).toBe(4);
    expect(all.days.map((d) => [d.day, d.searches, d.fetches])).toEqual([["2026-11-13", 4, 0], ["2026-11-14", 0, 1]]);
    expect(all.chats.map((c) => c.chatId).sort()).toEqual(["chat-1", "chat-2"]);
  });
});
