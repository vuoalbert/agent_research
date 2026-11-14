import { describe, expect, it } from "vitest";

import { brief, budgetPerDay, formatUsd, relativeTime, words } from "./telem-watch";

describe("telem-watch helpers", () => {
  it("reads a degraded tick as words, not JSON", () => {
    expect(brief({ error: null, job_id: "90d7", reason: "budget_estimate" })).toBe("budget estimate");
    expect(brief({ tick: 2, stop_reason: "done" })).toBe("tick 2, stop reason done");
    expect(brief({ value: "production", url: "https://x" })).toBe("production");
  });

  it("finds the daily budget under Telem's field name", () => {
    expect(budgetPerDay({ tick_budget_usd: 0.2, daily_budget_usd: 0.4 })).toBe(0.4);
    expect(budgetPerDay(null)).toBeNull();
  });

  it("formats spend, times and status words", () => {
    expect(formatUsd(0.2677)).toBe("$0.268");
    expect(relativeTime("2026-11-14T10:00:00Z", Date.parse("2026-11-14T12:00:00Z"))).toBe("2 h ago");
    expect(words("age_unclear")).toBe("age unclear");
  });
});
