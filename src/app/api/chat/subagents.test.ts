// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installTelemFakeFrom } from "@/test/telem-fake";

/**
 * deploy_subagents with the Agent SDK mocked: the input it accepts, that the
 * subagents run in parallel (at most 4 at a time), what each one may call, and
 * the `tool` frames the chat sees — the group row and each subagent's own
 * calls, tagged.
 */
type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<Result>;
type Options = {
  model: string;
  effort: string;
  systemPrompt: string;
  tools: unknown[];
  settingSources: unknown[];
  allowedTools: string[];
  maxTurns: number;
  permissionMode: string;
  abortController: AbortController;
  mcpServers: Record<string, { tools: { name: string; handler: Handler }[] }>;
};
type Args = { prompt: string; options: Options };

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => query(args),
  tool: (name: string, description: string, schema: unknown, handler: Handler) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => ({ type: "sdk", ...options }),
}));
const search = vi.fn();
const extract = vi.fn();
vi.mock("@tavily/core", () => ({ tavily: () => ({ search, extract }) }));

const {
  SUBAGENT_PROMPT,
  createSubagentsTool,
  formatResults,
  headlineOf,
  validateSubagents,
} = await import("./subagents");

const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Angle ${i + 1}`, task: `Find out thing ${i + 1}` }));
const finished = (headline: string) => ({
  type: "result",
  subtype: "success",
  result: `Headline: ${headline}\nSummary:\n- one\nKey claims:\n- x — https://example.com\nDisagreements:\n- none found`,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Frame = Record<string, unknown> & { id: string; status: string };
function setup(options: Partial<Parameters<typeof createSubagentsTool>[0]> = {}) {
  const frames: Frame[] = [];
  const onPages = vi.fn();
  const definition = createSubagentsTool({
    onActivity: (activity) => frames.push(JSON.parse(JSON.stringify(activity))),
    onPages,
    question: "What's the state of solid-state batteries?",
    ...options,
  }) as unknown as { name: string; handler: Handler };
  return { frames, onPages, run: (args: Record<string, unknown>) => definition.handler(args), name: definition.name };
}
const groups = (frames: Frame[]) => frames.filter((f) => f.action === "subagents") as (Frame & {
  subagents: { id: string; title: string; shape: string; status: string; line: string; startedAt?: number; finishedAt?: number }[];
})[];

beforeEach(() => {
  query.mockReset();
  search.mockReset();
  extract.mockReset();
  vi.stubEnv("TAVILY_API_KEY", "");
  installTelemFakeFrom({ search, extract });
});

describe("validateSubagents", () => {
  it("takes 2 to 5 subagents, each with a title and a task", () => {
    expect(validateSubagents(tasks(1))).toMatchObject({ ok: false, message: expect.stringMatching(/2 to 5/) });
    expect(validateSubagents(tasks(6))).toMatchObject({ ok: false });
    expect(validateSubagents([{ title: " ", task: "x" }, { title: "b", task: "y" }])).toMatchObject({ ok: false });
    expect(validateSubagents("nope")).toMatchObject({ ok: false });
    expect(validateSubagents(tasks(2))).toEqual({ ok: true, subagents: tasks(2) });
    expect(validateSubagents(tasks(5))).toMatchObject({ ok: true });
  });

  it("the tool refuses 1 or 6 without starting anything", async () => {
    const { run, frames, name } = setup();
    expect(name).toBe("deploy_subagents");
    expect((await run({ subagents: tasks(1) })).isError).toBe(true);
    expect((await run({ subagents: tasks(6) })).isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
  });
});

describe("headlineOf", () => {
  it("is the Headline line, else the first line of prose, on one line", () => {
    expect(headlineOf("Headline: Toyota targets 2027-28.\nSummary:\n- a")).toBe("Toyota targets 2027-28.");
    expect(headlineOf("**Headline:** QuantumScape ships B-samples")).toBe("QuantumScape ships B-samples");
    expect(headlineOf("## Summary\nSamsung SDI is piloting cells.\n- b")).toBe("Samsung SDI is piloting cells.");
    expect(headlineOf(`Headline: ${"x".repeat(300)}`).length).toBeLessThanOrEqual(140);
  });
});

describe("deploy_subagents", () => {
  it("runs each subagent as an Opus query with only search, read and the read-only vault — nothing to recurse with", async () => {
    query.mockImplementation((args: Args) =>
      (async function* () {
        yield finished(`done ${args.prompt.match(/Angle \d/)?.[0]}`);
      })(),
    );
    await setup().run({ subagents: tasks(3) });

    expect(query).toHaveBeenCalledTimes(3);
    for (const [{ prompt, options }] of query.mock.calls as [Args][]) {
      expect(options.model).toBe("claude-opus-5-5");
      expect(options.effort).toBe("medium");
      expect(options.tools).toEqual([]);
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe("dontAsk");
      expect(options.maxTurns).toBe(8);
      expect(options.systemPrompt).toBe(SUBAGENT_PROMPT);
      expect(options.abortController).toBeInstanceOf(AbortController);
      expect(Object.keys(options.mcpServers)).toEqual(["research"]);
      expect(options.mcpServers.research.tools.map((t) => t.name)).toEqual([
        "web_search",
        "web_read",
        "vault_search",
        "vault_read",
      ]);
      expect(options.allowedTools).toEqual([
        "mcp__research__web_search",
        "mcp__research__web_read",
        "mcp__research__vault_search",
        "mcp__research__vault_read",
      ]);
      expect(options.allowedTools.join()).not.toMatch(/deploy_subagents|cross_reference|visualize|vault_write/);
      expect(prompt).toContain("What's the state of solid-state batteries?");
    }
    expect(SUBAGENT_PROMPT).toMatch(/Headline:/);
    expect(SUBAGENT_PROMPT).toMatch(/Key claims/);
    expect(SUBAGENT_PROMPT).toMatch(/Disagreements/);
  });

  it("runs them in parallel, at most 4 at a time, and returns every result in order", async () => {
    let active = 0;
    let most = 0;
    query.mockImplementation((args: Args) =>
      (async function* () {
        active += 1;
        most = Math.max(most, active);
        await sleep(30);
        active -= 1;
        yield finished(`found ${args.prompt.match(/Angle \d/)?.[0]}`);
      })(),
    );
    const started = Date.now();
    const result = await setup().run({ subagents: tasks(5) });
    expect(query).toHaveBeenCalledTimes(5);
    expect(most).toBe(4);
    // two waves of 30ms, not five
    expect(Date.now() - started).toBeLessThan(140);
    const text = result.content[0].text;
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/5 of 5 finished/);
    const order = [1, 2, 3, 4, 5].map((i) => text.indexOf(`### Subagent ${i}: Angle ${i} (finished)`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Headline: found Angle 5");
  });

  it("reports one group row with a shape per subagent, re-sent as each moves on, then done with its headline", async () => {
    search.mockResolvedValue({
      results: [{ title: "QuantumScape Q3", url: "https://ir.quantumscape.com/q3", content: "B-sample cells shipped." }],
    });
    query.mockImplementation((args: Args) =>
      (async function* () {
        const angle = args.prompt.match(/Angle \d/)![0];
        await args.options.mcpServers.research.tools[0].handler({ query: `${angle} news` });
        yield { type: "assistant", message: { content: [{ type: "text", text: "Looking." }] } };
        yield finished(`${angle} headline`);
      })(),
    );
    const { frames, run, onPages } = setup();
    await run({ subagents: tasks(2) });

    const group = groups(frames);
    expect(new Set(group.map((f) => f.id)).size).toBe(1);
    const groupId = group[0].id;
    expect(group[0]).toMatchObject({ name: "Subagents", action: "subagents", query: "Angle 1 · Angle 2", status: "running" });
    expect(group[0].subagents.map(({ title, shape, status, line }) => ({ title, shape, status, line }))).toEqual([
      { title: "Angle 1", shape: "square", status: "running", line: "Waiting to start" },
      { title: "Angle 2", shape: "circle", status: "running", line: "Waiting to start" },
    ]);
    // the latest activity becomes the line
    expect(group.some((f) => f.subagents[0].line === "Searching “Angle 1 news”")).toBe(true);
    const last = group.at(-1)!;
    expect(last.status).toBe("done");
    expect(last.subagents.map((s) => [s.status, s.line])).toEqual([
      ["done", "Angle 1 headline"],
      ["done", "Angle 2 headline"],
    ]);
    for (const sub of last.subagents) {
      expect(sub.startedAt).toEqual(expect.any(Number));
      expect(sub.finishedAt).toBeGreaterThanOrEqual(sub.startedAt!);
    }

    // each subagent's own search goes out as a normal row, tagged
    const own = frames.filter((f) => f.parentId === groupId);
    const agents = last.subagents.map((s) => s.id);
    expect(own.filter((f) => f.status === "running")).toEqual([
      expect.objectContaining({ name: "Telem", query: "Angle 1 news", parentId: groupId, agentId: agents[0] }),
      expect.objectContaining({ name: "Telem", query: "Angle 2 news", parentId: groupId, agentId: agents[1] }),
    ]);
    expect(own.filter((f) => f.status === "done")).toHaveLength(2);
    expect(own.find((f) => f.status === "done")!.sources).toEqual([{ title: "QuantumScape Q3", url: "https://ir.quantumscape.com/q3" }]);
    // and its pages reach the request's research log and vault recorder
    expect(onPages).toHaveBeenCalledTimes(2);
    expect(onPages.mock.calls[0][0][0]).toMatchObject({ url: "https://ir.quantumscape.com/q3", full: false });
  });

  it("times a subagent out, keeps the others, and says so", async () => {
    query.mockImplementation((args: Args) =>
      (async function* () {
        if (args.prompt.includes("Angle 2")) {
          yield { type: "assistant", message: { content: [{ type: "text", text: "Half way: Samsung SDI pilot line." }] } };
          await new Promise((_, reject) =>
            args.options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        }
        yield finished("quick");
      })(),
    );
    const { frames, run } = setup({ timeoutMs: 40 });
    const result = await run({ subagents: tasks(2) });
    const last = groups(frames).at(-1)!;
    expect(last.status).toBe("done");
    expect(last.subagents.map((s) => s.status)).toEqual(["done", "error"]);
    expect(last.subagents[1].line).toMatch(/^Timed out/);
    expect(result.content[0].text).toMatch(/1 of 2 finished/);
    expect(result.content[0].text).toContain("Half way: Samsung SDI pilot line.");
  });

  it("stops every subagent when the request is aborted", async () => {
    const abort = new AbortController();
    query.mockImplementation((args: Args) =>
      (async function* () {
        await new Promise((_, reject) =>
          args.options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
        yield finished("never");
      })(),
    );
    const { frames, run } = setup({ signal: abort.signal });
    const pending = run({ subagents: tasks(3) });
    await sleep(10);
    abort.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(groups(frames).at(-1)!.subagents.map((s) => [s.status, s.line])).toEqual([
      ["error", "Stopped"],
      ["error", "Stopped"],
      ["error", "Stopped"],
    ]);
  });

  it("deploys once per turn", async () => {
    query.mockImplementation(() =>
      (async function* () {
        yield finished("x");
      })(),
    );
    const { run } = setup();
    expect((await run({ subagents: tasks(2) })).isError).toBeUndefined();
    const again = await run({ subagents: tasks(2) });
    expect(again.isError).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("formats results for the chat Claude to compare", () => {
    const text = formatResults([
      { title: "Chemistry", status: "done", text: "Headline: sulfides lead" },
      { title: "Makers", status: "error", text: "Timed out after 3 min" },
    ]);
    expect(text).toMatch(/^Subagent findings \(1 of 2 finished\)\. Compare them/);
    expect(text).toContain("### Subagent 1: Chemistry (finished)\nHeadline: sulfides lead");
    expect(text).toContain("### Subagent 2: Makers (did not finish)\nTimed out after 3 min");
  });

  it("gives each subagent its own Telem child trajectory and a different provider family", async () => {
    const { createLineage } = await import("@/server/telem/client");
    const telem = installTelemFakeFrom({
      search: async () => ({ results: [{ title: "A", url: "https://a.example.com/x", content: "a" }] }),
    });
    query.mockImplementation((args: Args) =>
      (async function* () {
        const angle = args.prompt.match(/Your angle: (.+)/)![1];
        await args.options.mcpServers.research.tools[0].handler({ query: `${angle} news` });
        yield finished(`${angle} headline`);
      })(),
    );
    const lineage = createLineage({ chatId: "chat-1", turnId: "turn-1", question: "solid-state batteries" });
    await setup({ lineage }).run({
      subagents: [...tasks(3), { title: "Chatter", task: "What do people post?", focus: "social" }],
    });

    const calls = telem.search.mock.calls.map(([q, options]) => ({ q: q as string, options: options as Record<string | symbol, unknown> }));
    const byAngle = (angle: string) => calls.find((c) => c.q.startsWith(angle))!.options;
    // deep, news, web in turn; "social" when the lead asked for it — routing off for the pin-only platforms
    expect(byAngle("Angle 1")).toMatchObject({ providersInclude: ["exa", "parallel", "seltz"], autoRouting: "accuracy" });
    expect(byAngle("Angle 2")).toMatchObject({ providersInclude: ["perplexity", "linkup", "tavily"] });
    expect(byAngle("Angle 3")).toMatchObject({ providersInclude: ["brave", "you", "ceramic"] });
    expect(byAngle("Chatter")).toMatchObject({
      providersInclude: ["fetchlayer_x", "socialdatax_youtube", "apify_substack", "brave"],
      autoRouting: "off",
    });
    // every subagent's call carries lineage: its own conversation, one shared parent (the turn that deployed them)
    const envelopes = calls.map(({ options }) => {
      const key = Object.getOwnPropertySymbols(options)[0];
      return options[key] as { parent_node_key: string | null; session_key: string; ancestors: unknown[] };
    });
    expect(envelopes).toHaveLength(4);
    expect(envelopes.every((e) => e.parent_node_key && e.ancestors.length === 1)).toBe(true);
    expect(new Set(envelopes.map((e) => e.parent_node_key)).size).toBe(1);
    expect(new Set(envelopes.map((e) => e.session_key)).size).toBe(4);
  });
});
