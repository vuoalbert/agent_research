import type { TelemCallMeta, TelemProviderRun } from "./events";

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

const succeeded = (run: TelemProviderRun) => /^(succeeded|success|ok|done|completed)$/i.test(run.status);

function runPrice(kind: TelemCallMeta["kind"], run: TelemProviderRun, tier?: string): number {
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

export function estimateTelemCost(meta: TelemCallMeta): { costUsd: number; source: "actual" | "estimated" } {
  if (typeof meta.costUsd === "number" && Number.isFinite(meta.costUsd)) return { costUsd: meta.costUsd, source: "actual" };
  // a failed call is free
  if (meta.status === "error") return { costUsd: 0, source: "estimated" };
  const runs: TelemProviderRun[] = meta.runs?.length
    ? meta.runs.filter(succeeded)
    : meta.providers.map((provider) => ({ provider, status: "succeeded" }));
  const allReported = runs.length > 0 && runs.every((run) => typeof run.costUsd === "number");
  const costUsd = runs.reduce((total, run) => total + runPrice(meta.kind, run, meta.tier), 0);
  return { costUsd, source: allReported ? "actual" : "estimated" };
}

/** a provider failed and another answered: Telem fell back */
export function isFallback(meta: TelemCallMeta): boolean {
  if (!meta.runs?.length || meta.status !== "ok") return false;
  return meta.runs.some((run) => !succeeded(run)) && meta.runs.some(succeeded);
}
