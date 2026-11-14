import { describe, expect, it, vi } from "vitest";

import { createWatch, pollWatch } from "./monitors";

/** Watch: a Telem Monitor per label on the shared monitors client (faked), polled for new trustworthy sources */

const client = (over: Record<string, unknown>) => ({ create: vi.fn(), updateAgent: vi.fn(), poll: vi.fn(), delete: vi.fn(), ...over }) as never;

describe("createWatch", () => {
  it("creates an hourly monitor that ends after 7 days and caps its agent's budget", async () => {
    const create = vi.fn(async () => ({ id: "mon_1", status: "active", frequency: "1h", expires_at: "2026-11-21T00:00:00Z", agent_state: { status: "compiling" } }));
    const updateAgent = vi.fn(async () => ({}));
    const out = await createWatch("x".repeat(400), { client: client({ create, updateAgent }) });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ query: "x".repeat(300), frequency: "1h", ttl: "7d" }));
    expect(updateAgent).toHaveBeenCalledWith("mon_1", { budget: expect.objectContaining({ tick_budget_usd: 0.2, daily_budget_usd: 0.4 }) });
    expect(out).toEqual({ id: "mon_1", status: "active", frequency: "1h", expires_at: "2026-11-21T00:00:00Z" });
  });

  it("still watches when the budget cannot be set, and says why", async () => {
    const create = vi.fn(async () => ({ id: "mon_2", status: "active", frequency: "1h", agent_state: {} }));
    const updateAgent = vi.fn(async () => {
      throw new Error("nope");
    });
    expect(await createWatch("q", { client: client({ create, updateAgent }) })).toMatchObject({ id: "mon_2", budgetNote: "nope" });
  });
});

describe("pollWatch", () => {
  it("keeps new trustworthy results once each, with warnings", async () => {
    const poll = vi.fn(async () => ({
      preprocessor_runs: [
        {
          preprocessor_name: "exa",
          output_payload: {
            warnings: [{ code: "slow" }],
            results: [
              { url: "https://www.nyc.gov/a", title: "A" },
              { url: "https://www.reddit.com/r/x", title: "R" },
              { url: "http://nyc.gov/a/", title: "dup" },
            ],
          },
        },
        { preprocessor_name: "brave", output_payload: { warnings: ["slow"], results: [{ url: "https://apnews.com/b" }] } },
      ],
      warnings: "first_run_pending",
    }));
    const out = await pollWatch("mon_1", { client: client({ poll }) });
    expect(poll).toHaveBeenCalledWith("mon_1");
    expect(out.total).toBe(4);
    expect(out.new_results.map((r) => [r.url, r.provider, r.trust.label])).toEqual([
      ["https://www.nyc.gov/a", "exa", "Government"],
      ["https://apnews.com/b", "brave", "Reputable news"],
    ]);
    expect(out.new_results[1].title).toBe("https://apnews.com/b");
    expect(out.warnings).toEqual(["slow", "first_run_pending"]);
  });
});
