import { beforeEach, describe, expect, it, vi } from "vitest";

import { __setTelemForTests } from "@/server/telem/client";

import { MAX_LABEL, MAX_LINKS, MAX_NODES } from "./navigate";

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (args: unknown) => query(args) }));

async function* stream(...messages: unknown[]) {
  for (const message of messages) yield message;
}
const answer = (structured: unknown) =>
  stream({ type: "result", subtype: "success", result: "", structured_output: structured });

const post = async (body: unknown) => {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost/api/graph-chat", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
};

const graph = {
  nodes: [
    { id: "chat:a", kind: "chat", label: "Chat A", degree: 1 },
    { id: "search:a:m:c", kind: "search", label: "solar costs", degree: 3 },
    { id: "page:x.org", kind: "page", label: "X report", degree: 2 },
    { id: "page:y.org", kind: "page", label: "Y study", degree: 2 },
  ],
  links: [
    { source: "chat:a", target: "search:a:m:c", kind: "asked" },
    { source: "search:a:m:c", target: "page:x.org", kind: "found" },
    { source: "search:a:m:c", target: "page:y.org", kind: "found" },
    { source: "page:x.org", target: "page:y.org", kind: "conflicts" },
  ],
};

beforeEach(() => query.mockReset());

describe("POST /api/graph-chat", () => {
  it("rejects malformed requests", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ graph })).status).toBe(400);
    expect((await post({ question: "  ", graph })).status).toBe(400);
    expect((await post({ question: "hi", graph: { nodes: [{ id: "a", kind: "planet", label: "", degree: 0 }], links: [] } })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("answers an empty graph without the model", async () => {
    const response = await post({ question: "hi", graph: { nodes: [], links: [] } });
    expect(await response.json()).toMatchObject({ focus: null, highlight: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("asks once, tool-less, with a draft-07 schema, and maps the aliases back to ids", async () => {
    query.mockReturnValueOnce(answer({ reply: "X and Y disagree.", focus: "n3", highlight: ["n4", "n99", "page:x.org", "bogus"] }));
    const response = await post({ question: "what conflicts?", graph });
    expect(response.status).toBe(200);
    // unknown ids dropped; the real id the model copied kept, once
    expect(await response.json()).toEqual({ reply: "X and Y disagree.", focus: "page:x.org", highlight: ["page:y.org", "page:x.org"] });

    const { prompt, options } = query.mock.calls[0][0];
    expect(options).toMatchObject({ model: "claude-opus-5-5", effort: "low", tools: [], settingSources: [] });
    expect(options.outputFormat.type).toBe("json_schema");
    expect(options.outputFormat.schema.$schema).toBeUndefined();
    expect(options.outputFormat.schema.required).toEqual(["reply", "focus", "highlight"]);
    expect(prompt).toContain("n3\tpage\t2\tX report");
    expect(prompt).toContain("n3 conflicts n4");
    expect(prompt).toContain("Question: what conflicts?");
    expect(prompt).not.toContain("page:x.org");
  });

  it("keeps the focus bright when the highlight leaves it out", async () => {
    query.mockReturnValueOnce(answer({ reply: "Y and its search.", focus: "n4", highlight: ["n2"] }));
    expect((await (await post({ question: "y?", graph })).json()).highlight).toEqual(["page:y.org", "search:a:m:c"]);
  });

  it("drops an unknown focus", async () => {
    query.mockReturnValueOnce(answer({ reply: "Not here.", focus: "n42", highlight: [] }));
    expect(await (await post({ question: "take me to Mars", graph })).json()).toEqual({ reply: "Not here.", focus: null, highlight: [] });
  });

  it("caps nodes, links and labels", async () => {
    query.mockReturnValueOnce(answer({ reply: "ok", focus: null, highlight: [] }));
    const nodes = Array.from({ length: MAX_NODES + 50 }, (_, i) => ({ id: `page:${i}`, kind: "page", label: "L".repeat(500), degree: 1 }));
    const links = Array.from({ length: MAX_LINKS + 50 }, (_, i) => ({ source: `page:${i % 100}`, target: `page:${(i % 100) + 1}`, kind: "agrees" }));
    expect((await post({ question: "hi", graph: { nodes, links } })).status).toBe(200);
    const { prompt } = query.mock.calls[0][0];
    expect(prompt).toContain(`Graph: ${MAX_NODES} nodes, ${MAX_LINKS} links.`);
    expect(prompt).toContain(`\t${"L".repeat(MAX_LABEL)}\n`);
    expect(prompt).not.toContain("L".repeat(MAX_LABEL + 1));
  });

  it("finds more sources with Telem off the node the question is about, minus pages already drawn", async () => {
    vi.stubEnv("TELEM_API_KEY", "test-key");
    vi.stubEnv("TAVILY_API_KEY", "");
    const run = (provider: string, results: { rank: number; url: string; title: string; summary?: string }[]) => ({
      provider,
      status: "succeeded",
      latencyMs: 1,
      results: results.map((r) => ({ ...r, provider })),
    });
    const telemSearch = vi.fn(async (q: string) => {
      expect(q).toBe("X report solar costs follow-up");
      const byProvider = [run("exa", [{ rank: 1, url: "https://www.x.org", title: "X again" }, { rank: 2, url: "https://z.org/new", title: "Z new", summary: "fresh" }])];
      return { status: "succeeded", results: byProvider[0].results, byProvider, raw: { session_id: "s1" } };
    });
    __setTelemForTests({ search: telemSearch as never, fetch: (async () => ({})) as never });
    try {
      query.mockReturnValueOnce(
        answer({ reply: "Searching for more like X.", focus: null, highlight: ["n4"], search: { query: "X report solar costs follow-up", from: "n3" } }),
      );
      const response = await post({ question: "find more sources like this", graph, focus: "page:x.org", chatId: "a" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        reply: "Found 1 new source for “X report solar costs follow-up” with Telem.",
        focus: "page:x.org",
        highlight: [],
        found: {
          query: "X report solar costs follow-up",
          from: "page:x.org",
          sources: [{ url: "https://z.org/new", title: "Z new", excerpt: "fresh", provider: "exa", providers: ["exa"], score: 1 }],
        },
      });
      // the model is told which node "this" is
      expect(query.mock.calls[0][0].prompt).toContain("Focused node: n3 (X report)");
    } finally {
      __setTelemForTests(null);
      vi.unstubAllEnvs();
    }
  });

  it("leaves Telem alone for a plain navigation question, and drops an unknown focus", async () => {
    query.mockReturnValueOnce(answer({ reply: "Here.", focus: "n2", highlight: [], search: null }));
    const response = await post({ question: "where is solar?", graph, focus: "page:nowhere" });
    expect(await response.json()).toEqual({ reply: "Here.", focus: "search:a:m:c", highlight: [] });
    expect(query.mock.calls[0][0].prompt).not.toContain("Focused node");
  });

  it("reports a failed model call", async () => {
    query.mockReturnValueOnce(stream({ type: "result", subtype: "error_max_turns" }));
    const response = await post({ question: "hi", graph });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("error_max_turns");
  });
});
