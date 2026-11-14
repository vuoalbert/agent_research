import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readWithTelem, searchTrusted, trustOf } from "./telem";

/** The World Labs screens' Telem sources: trust scoring, filtering, and the read route's guard (fetch mocked) */

beforeEach(() => {
  process.env.TELEM_API_KEY = "test-telem-key";
});
afterEach(() => {
  delete process.env.TELEM_API_KEY;
});

describe("trust scoring", () => {
  it("scores sources by kind and drops social and unknown sites", () => {
    expect(trustOf("https://www.nyc.gov/site/tlc")).toMatchObject({ score: 0.95, label: "Government" });
    expect(trustOf("https://web.mit.edu/x")).toMatchObject({ label: "University" });
    expect(trustOf("https://www.reuters.com/a")).toMatchObject({ score: 0.82, label: "Reputable news" });
    expect(trustOf("https://en.wikipedia.org/wiki/X")).toMatchObject({ label: "Encyclopedia (cited)" });
    expect(trustOf("https://www.reddit.com/r/nyc").score).toBeLessThan(0.7);
    expect(trustOf("https://some-blog.example/post").label).toBe("Unverified");
  });
});

describe("searchTrusted", () => {
  it("keeps trustworthy results, best first, at most two per site, and reports what it dropped", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ user_input: { query: "congestion pricing" }, search: { auto_routing: "accuracy" } });
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer test-telem-key");
      return Response.json({
        preprocessor_runs: [
          { preprocessor_name: "exa", output_payload: { results: [
            { url: "https://www.reuters.com/a", title: "Reuters A", rank: 1 },
            { url: "https://www.reddit.com/r/nyc/x", title: "Reddit", rank: 2 },
            { url: "https://new.mta.info/a", title: "MTA", rank: 3 },
          ] } },
          { preprocessor_name: "tavily", output_payload: { results: [
            { url: "https://www.nyc.gov/a", title: "NYC A", rank: 1 },
            { url: "https://www.nyc.gov/b", title: "NYC B", rank: 2 },
            { url: "https://www.nyc.gov/c", title: "NYC C", rank: 3 },
            { url: "https://www.reuters.com/a", title: "dup", rank: 4 },
          ] } },
        ],
      });
    });
    const out = await searchTrusted("congestion pricing", { fetch: fetch as typeof globalThis.fetch });
    expect(fetch.mock.calls[0][0]).toBe("https://router.telem.ai/v1/search");
    expect(out.providers).toEqual(["exa", "tavily"]);
    expect(out.total).toBe(6);
    expect(out.results.map((r) => r.url)).toEqual(["https://www.nyc.gov/a", "https://www.nyc.gov/b", "https://www.reuters.com/a"]);
    expect(out.results[0]).toMatchObject({ provider: "tavily", trust: { label: "Government", score: 0.95 } });
    expect(out.dropped.map((d) => d.host)).toEqual(["reddit.com", "new.mta.info"]);
  });
});

describe("readWithTelem — SSRF guard", () => {
  it("refuses private and non-http targets before calling Telem", async () => {
    const fetch = vi.fn();
    for (const url of ["http://127.0.0.1/", "http://localhost:3500/", "http://192.168.0.1/", "http://[::1]/"]) {
      expect(await readWithTelem(url, { fetch })).toMatchObject({ ok: false, status: 403 });
    }
    expect(await readWithTelem("file:///etc/passwd", { fetch })).toMatchObject({ ok: false, status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a public page through Telem Fetch, with its trust badge", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ preprocessor_runs: [{ output_payload: { fetched_results: [{ url: "https://www.nyc.gov/a", title: "A", content: "# A\nText", provider: "x" }] } }] }),
    );
    const out = await readWithTelem("https://www.nyc.gov/a", { fetch: fetch as typeof globalThis.fetch, guard: async () => {} });
    expect(fetch.mock.calls[0][0]).toBe("https://router.telem.ai/v1/fetch");
    expect(out).toMatchObject({ ok: true, url: "https://www.nyc.gov/a", content: "# A\nText", trust: { label: "Government" } });
  });
});
