import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("reports a failed model call", async () => {
    query.mockReturnValueOnce(stream({ type: "result", subtype: "error_max_turns" }));
    const response = await post({ question: "hi", graph });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("error_max_turns");
  });
});
