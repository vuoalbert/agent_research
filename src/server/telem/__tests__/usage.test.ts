// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { percentile, summarizeAll, summarizeChat, type UsageRecord } from "@/lib/telem-usage";

import { emitTelemCall, onTelemCall, type TelemCallMeta } from "../events";
import { estimateTelemCost, isFallback } from "../pricing";
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

const search = (over: Partial<TelemCallMeta> = {}): TelemCallMeta => ({
  kind: "search",
  providers: ["exa"],
  runs: [{ provider: "exa", status: "succeeded", latencyMs: 900 }],
  latencyMs: 1000,
  status: "ok",
  chatId: "chat-1",
  agent: "main",
  sessionId: "sess-1",
  trajectoryId: "traj-1",
  ...over,
});

describe("events", () => {
  it("delivers each call to every listener, and a throwing one never stops the rest", () => {
    const seen: TelemCallMeta[] = [];
    const offBad = onTelemCall(() => {
      throw new Error("boom");
    });
    const off = onTelemCall((meta) => seen.push(meta));
    emitTelemCall(search());
    off();
    offBad();
    emitTelemCall(search());
    expect(seen).toHaveLength(1);
    expect(typeof seen[0].at).toBe("number");
  });
});

describe("cost estimation", () => {
  it("uses Telem's own figure when the call reports one", () => {
    expect(estimateTelemCost(search({ costUsd: 0.0123 }))).toEqual({ costUsd: 0.0123, source: "actual" });
  });

  it("prices each provider run that answered, at the call's tier; failed runs are free", () => {
    const meta = search({
      providers: ["tavily", "brave"],
      runs: [
        { provider: "tavily", status: "succeeded" },
        { provider: "brave", status: "succeeded" },
        { provider: "exa", status: "failed" },
      ],
    });
    expect(estimateTelemCost(meta).costUsd).toBeCloseTo(0.01);
    expect(estimateTelemCost({ ...meta, tier: "extended" }).costUsd).toBeCloseTo(0.015);
    expect(estimateTelemCost(meta).source).toBe("estimated");
  });

  it("prices a fetch per URL by the provider that served it", () => {
    const meta: TelemCallMeta = {
      kind: "fetch",
      providers: ["tavily", "firecrawl"],
      runs: [
        { provider: "tavily", status: "succeeded" },
        { provider: "firecrawl", status: "succeeded", units: 2 },
      ],
      latencyMs: 2000,
      status: "ok",
    };
    expect(estimateTelemCost(meta).costUsd).toBeCloseTo(0.001 + 2 * 0.000798);
  });

  it("charges nothing for a failed call, and counts reported run costs as actual", () => {
    expect(estimateTelemCost(search({ status: "error" })).costUsd).toBe(0);
    expect(estimateTelemCost(search({ runs: [{ provider: "exa", status: "succeeded", costUsd: 0.007 }] }))).toEqual({
      costUsd: 0.007,
      source: "actual",
    });
  });

  it("falls back to the providers list when there are no runs, and to a typical price for an unknown provider", () => {
    expect(estimateTelemCost(search({ runs: undefined, providers: ["brave", "newco"] })).costUsd).toBeCloseTo(0.01);
  });

  it("flags a fallback: one provider failed, another answered", () => {
    expect(isFallback(search({ runs: [{ provider: "exa", status: "failed" }, { provider: "brave", status: "succeeded" }] }))).toBe(true);
    expect(isFallback(search())).toBe(false);
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

  it("appends every Telem call to its chat's JSON lines file", async () => {
    const store = startUsageRecorder(createUsageStore(dir));
    emitTelemCall(search());
    emitTelemCall(search({ kind: "fetch", providers: ["tavily"], runs: [{ provider: "tavily", status: "succeeded" }] }));
    emitTelemCall(search({ chatId: undefined }));
    await store.flush();
    const lines = readFileSync(join(dir, "chat-1.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ t: "telem", kind: "search", providers: ["exa"], costUsd: 0.005, costSource: "estimated", sessionId: "sess-1" });
    expect(readFileSync(join(dir, "_unscoped.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
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
    store.append(telemRecordFrom(search()));
    await store.flush();
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, "chat-1.jsonl"), '{"t":"telem","at":');
    expect(await store.read("chat-1")).toHaveLength(1);
    expect((await store.readAll()).get("chat-1")).toHaveLength(1);
  });
});

describe("aggregation", () => {
  const at = Date.UTC(2026, 10, 13, 12);
  const records: UsageRecord[] = [
    telemRecordFrom(search({ at, latencyMs: 400 })),
    telemRecordFrom(search({ at, latencyMs: 800, providers: ["exa", "brave"], runs: [{ provider: "exa", status: "succeeded" }, { provider: "brave", status: "succeeded" }] })),
    telemRecordFrom(search({ at, latencyMs: 3000, status: "error", providers: [], runs: [] })),
    telemRecordFrom(search({ at: at + 86_400_000, kind: "fetch", latencyMs: 1200, agent: "sub-a", sessionId: "sess-2", providers: ["tavily"], runs: [{ provider: "exa", status: "failed" }, { provider: "tavily", status: "succeeded" }] })),
    { ...claudeRecordFrom({ type: "result", subtype: "success", total_cost_usd: 0.5 }, { chatId: "chat-1", agent: "main" }), at },
    { ...claudeRecordFrom({ type: "result", subtype: "success", total_cost_usd: 0.2 }, { chatId: "chat-1", agent: "sub-a", title: "The numbers" }), at },
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

  it("summarizes every chat by day and by chat", () => {
    const all = summarizeAll(new Map([["chat-1", records], ["chat-2", [telemRecordFrom(search({ at, chatId: "chat-2" }))]]]));
    expect(all.totals.searches).toBe(4);
    expect(all.days.map((d) => [d.day, d.searches, d.fetches])).toEqual([["2026-11-13", 4, 0], ["2026-11-14", 0, 1]]);
    expect(all.chats.map((c) => c.chatId).sort()).toEqual(["chat-1", "chat-2"]);
  });
});
