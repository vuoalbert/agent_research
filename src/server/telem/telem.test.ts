import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setTelemForTests } from "./client";
import { findMore } from "./find";
import { platformOf } from "./platforms";
import { __clearReadCache, readPage, ReadError } from "./read";
import { fullPageBlock, PAGE_BLOCK, saveFullPage } from "../vault/full-page";

/* every hostname resolves to one public address; no real DNS in tests */
vi.mock("node:dns/promises", () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  return { lookup, default: { lookup } };
});

type FetchCall = { urls: string[]; options: Record<string, unknown> };
type SearchCall = { query: string; options: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let searchCalls: SearchCall[] = [];
let fetchAnswer: (call: FetchCall) => unknown;
let searchAnswer: (call: SearchCall) => unknown;

/** an SDK fetch response with these per-URL rows */
const fetched = (results: Record<string, unknown>[]) => ({
  status: results.some((r) => r.status === "succeeded") ? "succeeded" : "failed",
  results: results.map((r) => ({ latencyMs: 1, ...r })),
  raw: { session_id: "sess" },
});

/** an SDK search response, one run per provider */
const searched = (runs: { provider: string; results: { url: string; title?: string; summary?: string; rank: number }[] }[]) => ({
  status: "succeeded",
  results: runs.flatMap((run) => run.results.map((r) => ({ ...r, provider: run.provider }))),
  byProvider: runs.map((run) => ({
    provider: run.provider,
    status: "succeeded",
    latencyMs: 1,
    results: run.results.map((r) => ({ ...r, provider: run.provider })),
  })),
  raw: { session_id: "sess" },
});

beforeEach(() => {
  fetchCalls = [];
  searchCalls = [];
  __clearReadCache();
  vi.stubEnv("TELEM_API_KEY", "test-key");
  vi.stubEnv("TAVILY_API_KEY", "");
  __setTelemForTests({
    fetch: (async (urls: string[], options: Record<string, unknown>) => {
      const call = { urls, options };
      fetchCalls.push(call);
      const answer = fetchAnswer(call);
      if (answer instanceof Error) throw answer;
      return answer;
    }) as never,
    search: (async (query: string, options: Record<string, unknown>) => {
      const call = { query, options };
      searchCalls.push(call);
      return searchAnswer(call);
    }) as never,
  });
});

afterEach(() => {
  __setTelemForTests(null);
  vi.unstubAllEnvs();
});

describe("platformOf", () => {
  it("names the platform and the Telem providers to pin", () => {
    expect(platformOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ name: "YouTube", providers: ["fetchlayer_youtube", "socialdatax_youtube"] });
    expect(platformOf("https://youtu.be/dQw4w9WgXcQ")?.name).toBe("YouTube");
    expect(platformOf("https://x.com/nasa/status/123")?.providers).toEqual(["fetchlayer_x", "socialdatax_x"]);
    expect(platformOf("https://twitter.com/nasa/status/123")?.name).toBe("X");
    expect(platformOf("https://www.tiktok.com/@a/video/1")?.name).toBe("TikTok");
    expect(platformOf("https://www.linkedin.com/company/anthropic")?.providers).toEqual(["brightdata"]);
    expect(platformOf("https://maps.app.goo.gl/abc")?.name).toBe("Google Maps");
    expect(platformOf("https://www.reddit.com/r/x/comments/1/y")).toEqual({ name: "Reddit", providers: null });
    expect(platformOf("https://www.amazon.co.uk/dp/B000")?.providers).toEqual(["fetchlayer_amazon"]);
    // not a link form the platform's provider takes, or not a platform at all
    expect(platformOf("https://www.youtube.com/@channel")).toBeNull();
    expect(platformOf("https://x.com/nasa")).toBeNull();
    expect(platformOf("https://example.com/watch")).toBeNull();
    expect(platformOf("not a url")).toBeNull();
  });
});

describe("readPage", () => {
  it("refuses non-web and private targets before calling Telem", async () => {
    fetchAnswer = () => fetched([]);
    await expect(readPage("file:///etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(readPage("http://127.0.0.1/admin")).rejects.toMatchObject({ status: 403 });
    await expect(readPage("http://localhost:3000/")).rejects.toMatchObject({ status: 403 });
    await expect(readPage(null)).rejects.toBeInstanceOf(ReadError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("reads a platform link with its providers pinned, falling back to the default chain, and caches it", async () => {
    fetchAnswer = (call) =>
      call.options.providers
        ? new Error("400: no pinned provider accepts this link")
        : fetched([{ url: "https://www.youtube.com/watch?v=abc", status: "succeeded", title: "Video", content: "[00:01] hi", provider: "jina" }]);
    const view = await readPage("https://www.youtube.com/watch?v=abc#t=1", { chatId: "c1" });
    expect(fetchCalls.map((c) => c.options.providers)).toEqual([["fetchlayer_youtube", "socialdatax_youtube"], undefined]);
    expect(fetchCalls[0].urls).toEqual(["https://www.youtube.com/watch?v=abc"]);
    // filed under the chat's Telem session, as the reader
    expect(fetchCalls[0].options.metadata).toMatchObject({ caller: "reader" });
    expect(view).toMatchObject({ title: "Video", text: "[00:01] hi", provider: "jina", platform: "YouTube", host: "youtube.com", chars: 10 });
    // the hash is dropped, and the second read comes from memory
    await readPage("https://www.youtube.com/watch?v=abc");
    expect(fetchCalls).toHaveLength(2);
  });

  it("does not keep a failure", async () => {
    fetchAnswer = () => fetched([{ url: "https://a.org/", status: "failed", error: "timeout", provider: "" }]);
    await expect(readPage("https://a.org/")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("timeout") });
    fetchAnswer = () => fetched([{ url: "https://a.org/", status: "succeeded", title: "A", content: "ok", provider: "tavily" }]);
    expect((await readPage("https://a.org/")).text).toBe("ok");
  });
});

describe("findMore", () => {
  it("drops sources the chat has or the graph draws, keeping Telem's order", async () => {
    searchAnswer = () =>
      searched([
        { provider: "exa", results: [{ url: "https://www.known.org/a/", rank: 1 }, { url: "https://new.org/1", title: "New", summary: "fresh", rank: 2 }] },
        { provider: "brave", results: [{ url: "https://drawn.org/x", rank: 1 }] },
      ]);
    const found = await findMore("  more   on solar ", {
      known: ["https://known.org/a"],
      isKnown: (url) => url.includes("drawn.org"),
      chatId: "c1",
      caller: "graph-chat",
    });
    expect(found.query).toBe("more on solar");
    expect(found.sources.map((s) => [s.url, s.title, s.excerpt, s.provider])).toEqual([["https://new.org/1", "New", "fresh", "exa"]]);
    expect(searchCalls[0].query).toBe("more on solar");
    expect(searchCalls[0].options.metadata).toMatchObject({ caller: "graph-chat" });
    expect(await findMore("   ")).toEqual({ query: "", sources: [] });
    expect(searchCalls).toHaveLength(1);
  });
});

describe("saveFullPage", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vault-full-page-"));
    await mkdir(path.join(root, "Sources"));
    await writeFile(
      path.join(root, "Sources", "Guinness.md"),
      "---\ntype: source\nurl: https://www.guinnessworldrecords.com/x\n---\n<!-- agent-research:start -->\n# Guinness\n<!-- agent-research:end -->\n\nMy own notes.\n",
    );
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const page = { url: "https://guinnessworldrecords.com/x/", title: "G", text: "# Heading\n\nBody <!-- agent-research:end --> text", provider: "tavily" };

  it("appends the page under a managed Full page section, replaced on a second save", async () => {
    await saveFullPage("Sources/Guinness.md", page, root);
    await saveFullPage("Sources/Guinness.md", { ...page, text: "Second read" }, root);
    const text = await readFile(path.join(root, "Sources", "Guinness.md"), "utf8");
    expect(text).toContain("My own notes.");
    expect(text).toContain("<!-- agent-research:start -->\n# Guinness");
    expect(text.match(new RegExp(`<!-- ${PAGE_BLOCK}:start -->`, "g"))).toHaveLength(1);
    expect(text).toContain("## Full page");
    expect(text).toContain("Second read");
    expect(text).not.toContain("Body");
    expect(text).toMatch(/^---\ntype: source\nurl: .*\nupdated: \d{4}-\d{2}-\d{2}\n---/);
  });

  it("demotes the page's headings and strips forged markers", () => {
    const block = fullPageBlock(page, "2026-11-14");
    expect(block).toContain("_Read by Telem (tavily) on 2026-11-14 from <https://guinnessworldrecords.com/x/>_");
    expect(block).toContain("### Heading");
    expect(block).not.toContain("agent-research:end");
  });

  it("refuses a note about another page, a missing note and a path out of the vault", async () => {
    await expect(saveFullPage("Sources/Guinness.md", { ...page, url: "https://other.org" }, root)).rejects.toMatchObject({ status: 409 });
    await expect(saveFullPage("Sources/Nope.md", page, root)).rejects.toMatchObject({ status: 404 });
    await expect(saveFullPage("../outside.md", page, root)).rejects.toThrow();
  });
});
