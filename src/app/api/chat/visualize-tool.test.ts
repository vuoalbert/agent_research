import { describe, expect, it, vi } from "vitest";

/* `tool` and `createSdkMcpServer` as plain records, as in route.test.ts, so
   the test can call the handler the way Claude would */
type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: { subject: string; brief?: string; explicit?: boolean }) => Promise<Result>;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));

const { VISUALIZE_PROMPT, VISUALIZE_TOOL_ID, createVisualizeTurn, subjectFrom } = await import("./visualize-tool");
const { parseCrossref, quantityOf, researchBrief } = await import("./visualize-brief");

const SEARCH = "mcp__research__web_search";
const EXTRACT = "mcp__research__web_read";
const CROSSREF = "mcp__research__cross_reference";
const RESEARCH = [SEARCH, EXTRACT, CROSSREF];

const JOB = { id: "20261114-1300-a-dial-indicator-gauge-ab12", subject: "a dial indicator gauge", status: "running" as const, createdAt: 1 };

function turn(start = vi.fn((input: { subject: string }) => ({ status: "started" as const, job: { ...JOB, subject: input.subject } }))) {
  const events: Record<string, unknown>[] = [];
  const visualize = createVisualizeTurn({
    onActivity: (event) => events.push(event as Record<string, unknown>),
    researchTools: RESEARCH,
    crossrefTool: CROSSREF,
    start: start as never,
  });
  const handler = (visualize.server as unknown as { tools: { name: string; handler: Handler }[] }).tools[0];
  return { visualize, events, start, handler };
}

const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content } });
const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
const toolResult = (id: string, text: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
});

const CROSSREF_TABLE = [
  'Cross-reference on "EV share in Norway"',
  "",
  "Sources:",
  "- ofv.no: OFV — https://ofv.no/x",
  "- reuters.com: Reuters — https://www.reuters.com/y",
  "",
  "Claims (✓ supports, ✗ contradicts, ~ mentions):",
  "C1. Battery EVs were 88.9% of new cars sold in Norway in 2024.",
  '   ✓ ofv.no ("88.9 percent"); reuters.com ("almost 89%")',
  "C2. Norway's EV target for 2025 is 100% of new sales.",
  '   ✓ ofv.no ("100 percent")',
  '   ✗ reuters.com ("aims for 90%")',
  "",
  "Conflicts:",
  "- ofv.no vs reuters.com on C2",
].join("\n");

describe("the chat's visualize tool", () => {
  it("starts a figure, reports it running with its job id and then done, and returns at once", async () => {
    const { events, start, handler } = turn();
    expect(handler.name).toBe("visualize");
    expect(VISUALIZE_TOOL_ID).toBe("mcp__visualize__visualize");

    const result = await handler.handler({ subject: "a dial indicator gauge", brief: "Key numbers: - 0.01 mm", explicit: true });
    expect(start).toHaveBeenCalledWith({ subject: "a dial indicator gauge", brief: "Key numbers: - 0.01 mm", origin: "chat", explicit: true });
    expect(events).toEqual([
      { id: JOB.id, name: "Visualize", action: "visualize", query: "a dial indicator gauge", jobId: JOB.id, status: "running" },
      { id: JOB.id, status: "done" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/^Started a visualization of a dial indicator gauge; it builds in the background/);
  });

  it("passes explicit: false unless Claude says the user asked, and says when it replaced one", async () => {
    const start = vi.fn(() => ({ status: "started" as const, job: JOB, replaced: "older" }));
    const { handler } = turn(start as never);
    const result = await handler.handler({ subject: "a dial indicator gauge" });
    expect(start).toHaveBeenCalledWith({ subject: "a dial indicator gauge", origin: "chat", explicit: false });
    expect(result.content[0].text).toMatch(/replacing the previous one/);
  });

  it("starts nothing while a figure is building, and leaves a muted 'already building' row", async () => {
    const start = vi.fn(() => ({ status: "busy" as const, job: { ...JOB, subject: "a lock" } }));
    const { events, handler } = turn(start as never);
    const result = await handler.handler({ subject: "EV share as a gauge" });
    expect(events).toEqual([
      { id: expect.any(String), name: "Visualize", action: "visualize", query: "already building a lock", status: "running" },
      { id: expect.any(String), status: "done" },
    ]);
    expect(events[0]).not.toHaveProperty("jobId");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/still building/);
  });

  it("does at most one thing per turn", async () => {
    const { start, handler, events } = turn();
    await handler.handler({ subject: "one" });
    const second = await handler.handler({ subject: "two" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(second.content[0].text).toMatch(/Only one visualization per turn/);
    expect(events).toHaveLength(2);
  });

  it("reports a figure that could not start as a failed row and an error to Claude", async () => {
    const { events, handler } = turn(
      vi.fn(() => {
        throw new Error("Visualize isn't set up on this machine: run `npm run setup:visualize` first.");
      }) as never,
    );
    const result = await handler.handler({ subject: "a lock" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/setup:visualize/);
    expect(events.map((e) => e.status)).toEqual(["running", "error"]);
    expect(events[1].message).toMatch(/Couldn't start/);
  });
});

describe("every research turn ends with one figure", () => {
  it("starts one itself after a research turn Claude did not visualize, with a structured brief", () => {
    const { visualize, start, events } = turn();
    visualize.observe(assistant({ type: "text", text: "Let me look." }, toolUse("t1", SEARCH)));
    visualize.observe(toolResult("t1", "[1] OFV\nURL: https://ofv.no/x\n88.9% of new cars...\n\n[2] Reuters\nURL: https://www.reuters.com/y\n..."));
    visualize.observe(assistant(toolUse("t2", CROSSREF)));
    visualize.observe(toolResult("t2", CROSSREF_TABLE));
    visualize.observe(assistant({ type: "text", text: "Battery EVs took 88.9% of new car sales in 2024 ([OFV](https://ofv.no/x)). Sources disagree on the 2025 target." }));

    visualize.finish("What share of new cars in Norway are electric?");
    expect(start).toHaveBeenCalledTimes(1);
    const input = start.mock.calls[0][0] as { subject: string; brief: string; origin: string; explicit?: boolean };
    expect(input.subject).toBe("What share of new cars in Norway are electric?");
    expect(input.origin).toBe("research");
    expect(input.explicit).toBeUndefined();
    expect(input.brief).toContain("Key numbers:\n- 88.9 % (2024) — ofv.no, reuters.com");
    expect(input.brief).toContain("Parts and relations:\n- Battery EVs were 88.9% of new cars sold in Norway in 2024. (backed by ofv.no, reuters.com)");
    expect(input.brief).toContain("contradicted by reuters.com");
    expect(input.brief).toContain(`Conflicts:\n- ofv.no vs reuters.com on "Norway's EV target for 2025 is 100% of new sales."`);
    expect(input.brief).toContain("Sources: ofv.no, reuters.com");
    expect(input.brief).toMatch(/Object idea: a balance scale/);
    expect(input.brief.length).toBeLessThanOrEqual(2000);
    // the same row as Claude's own call
    expect(events[0]).toMatchObject({ name: "Visualize", action: "visualize", jobId: JOB.id, status: "running" });
  });

  it("adds nothing when Claude already called visualize in that turn", async () => {
    const { visualize, start, handler } = turn();
    visualize.observe(assistant(toolUse("t1", SEARCH)));
    await handler.handler({ subject: "EV share as a tally counter" });
    visualize.finish("What share of new cars in Norway are electric?");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts nothing after a turn without research (a vault read, or a plain answer)", () => {
    const { visualize, start } = turn();
    visualize.observe(assistant(toolUse("t1", "mcp__vault__vault_read"), { type: "text", text: "From your notes: 42." }));
    visualize.finish("What did I write about EVs?");
    expect(start).not.toHaveBeenCalled();
  });

  it("does nothing more than the runner allows: a figure still building is left alone", () => {
    const start = vi.fn(() => ({ status: "busy" as const, job: { ...JOB, subject: "a lock" } }));
    const { visualize, events } = turn(start as never);
    visualize.observe(assistant(toolUse("t1", EXTRACT)));
    visualize.finish("Compare these two reports");
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ origin: "research" }));
    expect(start.mock.calls[0]).not.toContainEqual(expect.objectContaining({ explicit: true }));
    expect(events[0]).toMatchObject({ query: "already building a lock" });
  });

  it("asks the chat Claude to research with figures in mind and to call visualize once, explicit only when asked", () => {
    expect(VISUALIZE_PROMPT).toMatch(/concrete quantities with units and dates/);
    expect(VISUALIZE_PROMPT).toMatch(/comparisons and rankings/);
    expect(VISUALIZE_PROMPT).toMatch(/cause→effect/);
    expect(VISUALIZE_PROMPT).toMatch(/where sources disagree/);
    expect(VISUALIZE_PROMPT).toMatch(/attributable to specific sources/);
    expect(VISUALIZE_PROMPT).toMatch(/Don't make the answer longer/);
    expect(VISUALIZE_PROMPT).toMatch(/After researching \(web_search, web_read or cross_reference\), call visualize once/);
    expect(VISUALIZE_PROMPT).toMatch(/Key numbers: [^]*Parts and relations: [^]*Conflicts: [^]*Object idea:/);
    expect(VISUALIZE_PROMPT).toMatch(/explicitly asks you to visualize, illustrate, diagram or draw something, call visualize with explicit: true/);
    expect(VISUALIZE_PROMPT).toMatch(/At most one visualize call per turn/);
  });
});

describe("the research brief", () => {
  it("reads quantities with their units and dates, and not a bare year", () => {
    expect(quantityOf("EVs were 88.9% of sales in 2024")).toEqual({ value: "88.9", unit: "%", date: "2024" });
    expect(quantityOf("It cost $1,200 million in March 2023")).toEqual({ value: "$1,200", unit: "million", date: "March 2023" });
    expect(quantityOf("It opened in 2019.")).toBeNull();
    expect(quantityOf("No numbers here.")).toBeNull();
  });

  it("parses cross_reference's table back into claims and conflicts", () => {
    const { claims, conflicts } = parseCrossref(CROSSREF_TABLE);
    expect(claims).toEqual([
      { id: "C1", text: "Battery EVs were 88.9% of new cars sold in Norway in 2024.", supports: ["ofv.no", "reuters.com"], contradicts: [] },
      { id: "C2", text: "Norway's EV target for 2025 is 100% of new sales.", supports: ["ofv.no"], contradicts: ["reuters.com"] },
    ]);
    expect(conflicts).toEqual(["ofv.no vs reuters.com on C2"]);
  });

  it("still has every section from an answer alone, numbers attributed by their links", () => {
    const brief = researchBrief({
      question: "How fast is the Shinkansen?",
      answer: "The N700S runs at 285 km/h on the Tokaido line ([JR Central](https://global.jr-central.co.jp/en/)). Tests reached 360 km/h in 2019.",
      pages: [],
      crossrefs: [],
    });
    expect(brief).toContain("Key numbers:\n- 285 km/h — global.jr-central.co.jp: The N700S runs at 285 km/h on the Tokaido line (JR Central).");
    expect(brief).toContain("- 360 km/h (2019) — unattributed");
    expect(brief).toContain("Parts and relations:\n- see the key numbers");
    expect(brief).toContain("Conflicts:\n- none found");
    expect(brief).toMatch(/Object idea: /);
    expect(brief).toContain("Answer (context):");
  });

  it("makes a subject of the question, cut on a word", () => {
    expect(subjectFrom("  What  is X? ")).toBe("What is X?");
    const long = subjectFrom(`${"word ".repeat(60)}end`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
  });
});
