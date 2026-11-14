/** what pricing needs to know about a call, whatever shape it came in */
export type PricedRun = { provider: string; status: string; costUsd?: number; units?: number };
export type PricedCall = {
  kind: "search" | "fetch";
  tier?: string;
  /** did Telem answer at all (a failed call is free) */
  ok: boolean;
  /** Telem's own total for the call, when it ever reports one */
  costUsd?: number;
  runs: PricedRun[];
};

/**
 * What a Telem call cost — Telem's own figure when the response carried one,
 * otherwise an estimate from https://docs.telem.ai/pricing/ (November 2026).
 *
 * Telem bills each provider call that answers at the provider's own price, no
 * markup; a search with no results still counts, a failed call (error or
 * timeout) is free. So the estimate is the sum, over the runs that succeeded,
 * of that provider's list price at the call's tier. Providers Telem bills "as
 * they report it" (exa, parallel fetch) use the run's reported cost when it is
 * there, and a typical price when it is not.
 */

type Price = { base: number; /** at `extended` / `max` */ advanced?: number };

export const SEARCH_PRICES: Record<string, Price> = {
  brave: { base: 0.005 },
  ceramic: { base: 0.00005 },
  /** billed as exa reports it; a basic exa search lists at $0.005 */
  exa: { base: 0.005 },
  linkup: { base: 0.005, advanced: 0.05 },
  parallel: { base: 0.001, advanced: 0.005 },
  perplexity: { base: 0.005 },
  seltz: { base: 0.005 },
  serpapi: { base: 0.006 },
  tavily: { base: 0.005, advanced: 0.01 },
  tinyfish: { base: 0 },
  /** plus $0.001 per page crawled live, when the run says how many */
  you: { base: 0.005 },
};

/** per fetched URL */
export const FETCH_PRICES: Record<string, number> = {
  brightdata: 0.0015,
  /** billed as exa reports it */
  exa: 0.001,
  /** $0.000798 per firecrawl credit, usually one a page */
  firecrawl: 0.000798,
  /** $0.045 per million tokens; ~5k tokens a page when the size is unknown */
  jina: 0.045 * 5_000 / 1_000_000,
  linkup: 0.005,
  /** as parallel reports it, $0.001 a unit */
  parallel: 0.001,
  tavily: 0.001,
  tinyfish: 0,
  you: 0.001,
};

/** a provider the table does not know yet */
const UNKNOWN_SEARCH = 0.005;
const UNKNOWN_FETCH = 0.001;

export const succeeded = (run: { status: string }) => /^(succeeded|success|ok|done|completed)$/i.test(run.status);

/** one run's price: its reported cost, or the list price at the tier */
export function runPrice(kind: PricedCall["kind"], run: PricedRun, tier?: string): number {
  if (typeof run.costUsd === "number" && Number.isFinite(run.costUsd)) return run.costUsd;
  const provider = run.provider.toLowerCase();
  if (kind === "search") {
    const price = SEARCH_PRICES[provider];
    if (!price) return UNKNOWN_SEARCH;
    const advanced = tier === "extended" || tier === "max";
    const base = advanced && price.advanced !== undefined ? price.advanced : price.base;
    return provider === "you" && run.units ? base + 0.001 * run.units : base;
  }
  if (provider === "jina" && run.units) return (0.045 * run.units) / 1_000_000;
  if (provider === "firecrawl" && run.units) return 0.000798 * run.units;
  return FETCH_PRICES[provider] ?? UNKNOWN_FETCH;
}

export function estimateTelemCost(call: PricedCall): { costUsd: number; source: "actual" | "estimated" } {
  if (typeof call.costUsd === "number" && Number.isFinite(call.costUsd)) return { costUsd: call.costUsd, source: "actual" };
  // a failed call is free
  if (!call.ok) return { costUsd: 0, source: "estimated" };
  const runs = call.runs.filter(succeeded);
  const allReported = runs.length > 0 && runs.every((run) => typeof run.costUsd === "number");
  const costUsd = runs.reduce((total, run) => total + runPrice(call.kind, run, call.tier), 0);
  return { costUsd, source: allReported ? "actual" : "estimated" };
}

/** a provider failed and another answered: Telem fell back within the call */
export function isFallback(runs: readonly { status: string }[]): boolean {
  return runs.some((run) => !succeeded(run)) && runs.some(succeeded);
}

/**
 * The dollars a provider's native `usage` reports, when Telem passes it
 * through (exa's `costDollars`, a number or `{ total }`).
 */
export function usageCost(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  for (const value of [u.costDollars, u.cost_dollars, u.cost_usd, u.costUsd]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object") {
      const total = (value as Record<string, unknown>).total;
      if (typeof total === "number" && Number.isFinite(total)) return total;
    }
  }
  return undefined;
}
