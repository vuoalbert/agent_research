// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTLE_GRACE_MS, agentOptions, createAgentRunner, type AgentRunInput, type AgentRunResult, type RunAgent } from "../agent";
import { createInbox } from "../inbox";
import { MAX_REPLY, liveMessage, replyFrom, resumeMessage } from "../messages";
import { jobPaths, studioPaths, type StudioPaths } from "../paths";
import { checkToolUse, guardContext } from "../policy";
import { createRunner, type StartResult } from "../runner";
import { VISUALIZE_VAULT_TOOLS, VISUALIZE_VAULT_TOOL_IDS, vaultRead, vaultSearch } from "../vault-server";

/**
 * Agents talking to each other: the chat's messages reach the Visualize agent
 * mid-build (its streaming input, inbox.ts), a finished one is resumed with
 * its saved session, and the agent can read the research vault — with the
 * SDK and the agent mocked.
 */

let root: string;
let paths: StudioPaths;

function studio() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "visualize-messaging-")));
  const p = studioPaths(join(root, ".visualize"));
  mkdirSync(p.skill, { recursive: true });
  writeFileSync(join(p.skill, "SKILL.md"), "# anatomy");
  mkdirSync(join(p.plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(p.studio, "bin"), { recursive: true });
  writeFileSync(p.chrome, "#!/bin/sh\n");
  mkdirSync(p.jobs, { recursive: true });
  return p;
}

beforeEach(() => {
  paths = studio();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const job = { id: "20261114-1200-a-bicycle-bell-0000", subject: "a bicycle bell", status: "running" as const, createdAt: 1 };

/* ------------------------------------------------ the agent's streaming run */

type Wire = SDKUserMessage & { uuid: string };
type Io = { next: () => Promise<Wire | null> };

/**
 * A stand-in for Claude Code in streaming-input mode: it reads the prompt
 * stream as it comes (as the CLI reads stdin), and the scenario decides what
 * the session says and when it takes the next message. `next()` is null once
 * the input has ended.
 */
function fakeCli(scenario: (io: Io) => AsyncGenerator<unknown>) {
  const calls: { options: Record<string, unknown>; received: Wire[]; ended: () => boolean }[] = [];
  const query = vi.fn(({ prompt, options }: { prompt: AsyncIterable<Wire>; options: Record<string, unknown> }) => {
    const received: Wire[] = [];
    let ended = false;
    const waiting: (() => void)[] = [];
    const wake = () => waiting.splice(0).forEach((resolve) => resolve());
    void (async () => {
      for await (const message of prompt) {
        received.push(message);
        wake();
      }
      ended = true;
      wake();
    })();
    let taken = 0;
    const next = async () => {
      while (received.length <= taken && !ended) await new Promise<void>((resolve) => waiting.push(resolve));
      return received[taken++] ?? null;
    };
    calls.push({ options, received, ended: () => ended });
    return scenario({ next });
  });
  return { query, calls };
}

const assistant = (content: unknown[], uuids?: string[]) => ({
  type: "assistant",
  message: { content },
  ...(uuids ? { user_message_uuids: uuids } : {}),
});
const result = (text: string, uuids: string[], extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  num_turns: 9,
  result: text,
  user_message_uuids: uuids,
  queued_turn_count: 0,
  ...extra,
});

function agentPaths() {
  const p = jobPaths(paths, job.id);
  mkdirSync(p.work, { recursive: true });
  return p;
}

describe("the agent's live session", () => {
  it("takes a message from the chat mid-build, as a user turn folded in between tool calls, then ends", async () => {
    const inbox = createInbox();
    let midRun: Wire | null = null;
    const { query, calls } = fakeCli(async function* ({ next }) {
      const build = (await next())!;
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      yield assistant([{ type: "text", text: "Sizing it as a Figure." }], [build.uuid]);
      yield assistant([{ type: "tool_use", name: "Bash", input: { command: "node build.mjs --light" } }]);
      // Claude Code folds the queued message into the turn at the next tool boundary
      midRun = await next();
      yield assistant([{ type: "text", text: "Making the dome blue and labelling the striker." }]);
      yield result("A bicycle bell; the dome is blue and the striker labelled.", [build.uuid, midRun!.uuid]);
      // the run is over once the input ends
      expect(await next()).toBeNull();
    });
    const log: string[] = [];
    const sessions: string[] = [];
    const run = createAgentRunner(query as never);
    const outcome = await run({
      job,
      studio: paths,
      paths: agentPaths(),
      signal: new AbortController().signal,
      inbox,
      onSession: (id) => sessions.push(id),
      log: (line) => {
        log.push(line);
        // the chat sends its message while the build is under way
        if (line.startsWith("Bash:")) inbox.push(liveMessage("make the bell dome blue and label the striker"));
      },
    });

    expect(outcome).toEqual({ outcome: "success", turns: 9, summary: "A bicycle bell; the dome is blue and the striker labelled." });
    expect(sessions).toEqual(["sess-1"]);
    const [{ received, ended }] = calls;
    expect(received).toHaveLength(2);
    expect(received[0].message.content).toMatch(/Use the anatomy skill to build ONE interactive isometric figure/);
    expect(received[1]).toMatchObject({ type: "user", priority: "next", parent_tool_use_id: null, uuid: expect.any(String) });
    expect(received[1].message.content).toMatch(
      /^Message from the chat, sent while you are building: make the bell dome blue and label the striker/,
    );
    expect(midRun).toBe(received[1]);
    expect(ended()).toBe(true);
    expect(inbox.closed).toBe(true);
    expect(log).toContain("Making the dome blue and labelling the striker.");
  });

  it("stays open past a result until the turn that takes a late message has run", async () => {
    const inbox = createInbox();
    const { query } = fakeCli(async function* ({ next }) {
      const build = (await next())!;
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      inbox.push(liveMessage("add a caption"));
      // the build's result came before the message was taken
      yield result("A bell.", [build.uuid]);
      const late = (await next())!;
      yield assistant([{ type: "text", text: "Adding the caption." }]);
      yield result("Added the caption.", [late.uuid]);
      expect(await next()).toBeNull();
    });
    const outcome = await createAgentRunner(query as never)({
      job,
      studio: paths,
      paths: agentPaths(),
      signal: new AbortController().signal,
      inbox,
      log: () => {},
    });
    expect(outcome).toMatchObject({ outcome: "success", summary: "Added the caption." });
  });

  it("ends anyway when no turn takes a pushed message, leaving it pending for the runner", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const inbox = createInbox();
    let pushed: string | null = null;
    const { query } = fakeCli(async function* ({ next }) {
      const build = (await next())!;
      pushed = inbox.push(liveMessage("add a caption"));
      await next();
      // Claude Code never echoes it, and starts no turn for it
      yield result("A bell.", [build.uuid]);
      expect(await next()).toBeNull();
    });
    const running = createAgentRunner(query as never)({
      job,
      studio: paths,
      paths: agentPaths(),
      signal: new AbortController().signal,
      inbox,
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(SETTLE_GRACE_MS - 1);
    expect(inbox.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await running).toMatchObject({ outcome: "success", summary: "A bell." });
    expect(inbox.isPending(pushed!)).toBe(true);
  });

  it("resumes a saved session with its message as the first turn, under the very same options", async () => {
    const { query, calls } = fakeCli(async function* ({ next }) {
      const first = (await next())!;
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      yield result("Added the caption 'ring ring'.", [first.uuid]);
      expect(await next()).toBeNull();
    });
    const p = agentPaths();
    const outcome = await createAgentRunner(query as never)({
      job,
      studio: paths,
      paths: p,
      signal: new AbortController().signal,
      resume: "sess-1",
      prompt: resumeMessage(["add a caption saying 'ring ring'"]),
      log: () => {},
    });
    expect(outcome).toMatchObject({ outcome: "success", summary: "Added the caption 'ring ring'." });
    const [{ options, received }] = calls;
    expect(options.resume).toBe("sess-1");
    expect(received[0].message.content).toMatch(/^Message from the chat about the figure you built: add a caption saying 'ring ring'/);
    expect(received[0].message.content).toMatch(/don't start over/);

    // everything but the resume (and the per-run abort and stderr hooks) is the build's own
    const build = agentOptions({ studio: paths, paths: p, log: () => {} }, new AbortController());
    const comparable = (o: Record<string, unknown>) => {
      const { abortController: _a, stderr: _s, resume: _r, hooks, mcpServers, ...rest } = o;
      return { ...rest, hooks: Object.keys(hooks as object), mcpServers: Object.keys(mcpServers as object) };
    };
    expect(comparable(options)).toEqual(comparable(build as Record<string, unknown>));
    expect(options).toMatchObject({ cwd: p.work, persistSession: true, sandbox: { enabled: true, allowUnsandboxedCommands: false } });
  });

  it("closes its input on a failed result", async () => {
    const inbox = createInbox();
    const { query } = fakeCli(async function* ({ next }) {
      await next();
      yield { type: "result", subtype: "error_max_turns", num_turns: 300 };
    });
    const outcome = await createAgentRunner(query as never)({
      job,
      studio: paths,
      paths: agentPaths(),
      signal: new AbortController().signal,
      inbox,
      log: () => {},
    });
    expect(outcome).toMatchObject({ outcome: "error", detail: "the agent stopped: error_max_turns" });
    expect(inbox.closed).toBe(true);
    expect(inbox.push("too late")).toBeNull();
  });
});

/* ------------------------------------------------------------ the runner */

type Run = { input: AgentRunInput; received: string[]; finish: (result: AgentRunResult) => void };

/** an agent the test finishes by hand; it takes the chat's messages as Claude Code would (unless `takes` is false) */
function talkingAgent({ takes = true } = {}) {
  const runs: Run[] = [];
  const runAgent: RunAgent = (input) =>
    new Promise((resolve) => {
      const run: Run = { input, received: [], finish: resolve };
      runs.push(run);
      void (async () => {
        for await (const message of input.inbox!) {
          run.received.push(String(message.message.content));
          if (takes) input.inbox!.consumed([(message as Wire).uuid]);
        }
      })();
      input.signal.addEventListener("abort", () => resolve({ outcome: "aborted" }), { once: true });
    });
  return { runs, runAgent };
}

const started = (result: StartResult) => {
  if (result.status !== "started") throw new Error(`expected a start, got ${result.status}`);
  return result.job;
};
const figure = (run: Run, html: string) => writeFileSync(run.input.paths.workFigure, html);
const lines = (runner: ReturnType<typeof createRunner>, id: string) => runner.getJob(id, 200)!.log.map((l) => l.text);

describe("messaging the current visualization", () => {
  it("says there is nothing to message before the first visualization", () => {
    const runner = createRunner({ paths, runAgent: talkingAgent().runAgent, pid: 1 });
    expect(runner.sendMessage("make it blue")).toEqual({ status: "none" });
  });

  it("delivers into the live build, logs it, saves the session, and keeps the agent's reply", async () => {
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    expect(runner.getJob(id)?.sessionId).toBe("sess-1");

    const sent = runner.sendMessage("make the bell dome blue and label the striker");
    expect(sent).toMatchObject({ status: "live", job: { id, status: "running", messages: 1 } });
    await tick();
    expect(runs).toHaveLength(1);
    expect(runs[0].received).toEqual([liveMessage("make the bell dome blue and label the striker")]);
    expect(lines(runner, id)).toContain("Message from chat: make the bell dome blue and label the striker");

    figure(runs[0], "<p>blue dome</p>");
    runs[0].finish({ outcome: "success", summary: "A bicycle bell.\n\n**Changed:** the dome is now blue and the striker is labelled." });
    await runner.whenSettled();
    expect(runner.getJob(id)).toMatchObject({
      status: "done",
      sessionId: "sess-1",
      lastReply: "the dome is now blue and the striker is labelled.",
    });
    expect(runs).toHaveLength(1);
  });

  it("keeps no reply for a build that no message went into", async () => {
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    figure(runs[0], "<p>bell</p>");
    runs[0].finish({ outcome: "success", summary: "A bicycle bell." });
    await runner.whenSettled();
    expect(runner.getJob(id)?.lastReply).toBeUndefined();
  });

  it("resumes a finished one in the same job — status running, its session, a fresh timeout — then serves the new page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.UTC(2026, 10, 14, 12, 0) });
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1, timeoutMs: 1000 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    figure(runs[0], "<p>old</p>");
    await vi.advanceTimersByTimeAsync(600);
    runs[0].finish({ outcome: "success", summary: "A bell." });
    await runner.whenSettled();
    expect(runner.getJob(id)?.status).toBe("done");

    const sent = runner.sendMessage("add a caption saying 'ring ring'");
    expect(sent).toMatchObject({ status: "resumed", job: { id, status: "running", messages: 1 } });
    const resumed = runner.getJob(id)!;
    expect(resumed).toMatchObject({ status: "running", startedAt: Date.now(), figure: "figure.html" });
    expect(resumed.endedAt).toBeUndefined();
    expect(runs).toHaveLength(2);
    expect(runs[1].input.resume).toBe("sess-1");
    expect(runs[1].input.prompt).toBe(resumeMessage(["add a caption saying 'ring ring'"]));
    expect(runs[1].input.job.id).toBe(id);
    expect(runner.currentJob()?.id).toBe(id);
    expect(lines(runner, id).slice(-2)).toEqual([
      "Message from chat: add a caption saying 'ring ring'",
      "Resumed the background agent's session to apply it",
    ]);

    // still one visualization at a time: an automatic start finds it building
    expect(runner.startJob({ subject: "something else", origin: "research" })).toMatchObject({ status: "busy", job: { id } });

    // its own 60 minutes (here 1s), counted from the resume: 600ms into the
    // first run's timer, it would have run out already
    await vi.advanceTimersByTimeAsync(700);
    expect(runner.getJob(id)?.status).toBe("running");

    figure(runs[1], "<p>ring ring</p>");
    runs[1].finish({ outcome: "success", summary: "Added the caption 'ring ring' under the bell." });
    await runner.whenSettled();
    expect(runner.getJob(id)).toMatchObject({ status: "done", lastReply: "Added the caption 'ring ring' under the bell." });
    expect(readFileSync(runner.figureFile(id)!, "utf8")).toBe("<p>ring ring</p>");
    expect(readdirSync(paths.jobs)).toEqual([id]);
  });

  it("times a resumed run out on its own limit, keeping the page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1, timeoutMs: 1000 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    figure(runs[0], "<p>old</p>");
    runs[0].finish({ outcome: "success" });
    await runner.whenSettled();
    runner.sendMessage("add a caption");
    await vi.advanceTimersByTimeAsync(1001);
    await runner.whenSettled();
    expect(runner.getJob(id)).toMatchObject({ status: "done", note: expect.stringMatching(/60-minute limit/) });
  });

  it("resumes a stopped, failed or interrupted one too", async () => {
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    await runner.stopJob(id);
    expect(runner.getJob(id)?.status).toBe("stopped");
    expect(runner.sendMessage("carry on, and make it blue")).toMatchObject({ status: "resumed" });
    expect(runner.getJob(id)).toMatchObject({ status: "running" });
    expect(runner.getJob(id)?.error).toBeUndefined();
    runs[1].finish({ outcome: "error", detail: "boom" });
    await runner.whenSettled();
    expect(runner.getJob(id)?.status).toBe("error");

    // a new server process: it was interrupted, and can still be picked back up
    const later = talkingAgent();
    runner.sendMessage("again");
    const next = createRunner({ paths, runAgent: later.runAgent, pid: 2 });
    expect(next.getJob(id)).toMatchObject({ status: "interrupted", sessionId: "sess-1" });
    expect(next.sendMessage("make it blue")).toMatchObject({ status: "resumed", job: { id, pid: 2 } });
    expect(later.runs[0].input.resume).toBe("sess-1");
  });

  it("leaves a resume alone when the run a Stop gave up on winds down later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runs: Run[] = [];
    // the first run ignores its abort for a while, as a slow agent can
    const runAgent: RunAgent = (input) =>
      new Promise((resolve) => {
        runs.push({ input, received: [], finish: resolve });
        if (runs.length > 1) input.signal.addEventListener("abort", () => resolve({ outcome: "aborted" }), { once: true });
      });
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    const stopping = runner.stopJob(id);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await stopping)?.status).toBe("stopped");

    expect(runner.sendMessage("carry on")).toMatchObject({ status: "resumed" });
    runs[0].finish({ outcome: "aborted" });
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.getJob(id)?.status).toBe("running");
    figure(runs[1], "<p>bell</p>");
    runs[1].finish({ outcome: "success", summary: "Carried on." });
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.getJob(id)).toMatchObject({ status: "done", lastReply: "Carried on." });
  });

  it("can't change one whose session was never saved", async () => {
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].finish({ outcome: "error", detail: "Claude Code is not logged in" });
    await runner.whenSettled();
    expect(runner.sendMessage("make it blue")).toMatchObject({ status: "unavailable", job: { id }, reason: expect.stringMatching(/session wasn't saved/) });
    expect(runs).toHaveLength(1);
  });

  it("carries a message that came as the run was closing into a resume once it has settled", async () => {
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    // the build's last result is in: its input has closed
    runs[0].input.inbox!.close();
    expect(runner.sendMessage("add a caption")).toMatchObject({ status: "live" });
    expect(runs[0].received).toEqual([]);

    figure(runs[0], "<p>bell</p>");
    runs[0].finish({ outcome: "success", summary: "A bell." });
    await runner.whenSettled();
    expect(runs).toHaveLength(2);
    expect(runs[1].input).toMatchObject({ resume: "sess-1", prompt: resumeMessage(["add a caption"]) });
    expect(runner.getJob(id)?.status).toBe("running");
  });

  it("resumes with a message no turn took — unless the user stopped it", async () => {
    const { runs, runAgent } = talkingAgent({ takes: false });
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const { id } = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    runner.sendMessage("add a caption");
    await tick();
    figure(runs[0], "<p>bell</p>");
    runs[0].finish({ outcome: "success", summary: "A bell." });
    await runner.whenSettled();
    expect(runs).toHaveLength(2);
    expect(runs[1].input.prompt).toBe(resumeMessage(["add a caption"]));

    runner.sendMessage("and make it blue");
    await tick();
    await runner.stopJob(id);
    expect(runs).toHaveLength(2);
    expect(runner.getJob(id)?.status).toBe("stopped");
    expect(lines(runner, id)).toContain("The chat's last message wasn't applied: the agent was stopped first");
  });

  it("forgets a replaced visualization's session along with its folder", async () => {
    const forgetSession = vi.fn();
    const { runs, runAgent } = talkingAgent();
    const runner = createRunner({ paths, runAgent, pid: 1, forgetSession });
    const first = started(runner.startJob({ subject: "a bicycle bell" }));
    runs[0].input.onSession?.("sess-1");
    figure(runs[0], "<p>bell</p>");
    runs[0].finish({ outcome: "success" });
    await runner.whenSettled();

    const second = started(runner.startJob({ subject: "a doorbell", explicit: true }));
    expect(forgetSession).toHaveBeenCalledWith("sess-1");
    expect(existsSync(jobPaths(paths, first.id).dir)).toBe(false);

    // one still building is forgotten once it has wound down
    runs[1].input.onSession?.("sess-2");
    started(runner.startJob({ subject: "a gong", explicit: true }));
    await tick();
    expect(forgetSession).toHaveBeenLastCalledWith("sess-2");
    expect(runner.getJob(second.id)).toBeNull();
  });
});

describe("the agent's reply", () => {
  it("is the Changed: line it ends with, as plain text", () => {
    const summary = [
      "The figure is finished and saved as `./figure.html`. It shows a 55 mm steel bell.",
      "",
      "**How to use it:** press and hold, then let go.",
      "",
      "**Changed:** I painted the dome in **blue enamel** and added a `STRIKER` label",
      "that follows the hammer head.",
    ].join("\n");
    expect(replyFrom(summary)).toBe("I painted the dome in blue enamel and added a STRIKER label that follows the hammer head.");
    expect(replyFrom("Changed: added the caption 'ring ring' under the bell.")).toBe("added the caption 'ring ring' under the bell.");
  });

  it("is the start of the reply when there is no Changed: line, cut to a few lines", () => {
    expect(replyFrom("A bell.\n\nPress **and** hold.")).toBe("A bell. Press and hold.");
    expect(replyFrom("x".repeat(2000))).toHaveLength(MAX_REPLY);
    expect(replyFrom("  ")).toBeUndefined();
    expect(replyFrom(undefined)).toBeUndefined();
  });

  it("is asked for in both kinds of message", () => {
    expect(liveMessage("make it blue")).toMatch(/end your final reply with one line that starts with "Changed:"/);
    expect(resumeMessage(["make it blue"])).toMatch(/reply with one line that starts with "Changed:"/);
  });
});

/* ------------------------------------------------------- the vault, read-only */

describe("the Visualize agent's vault", () => {
  let vault: string;
  beforeEach(() => {
    vault = join(root, "vault");
    mkdirSync(join(vault, "Research"), { recursive: true });
    writeFileSync(
      join(vault, "Research", "Bicycle bells.md"),
      "---\ntype: research\nupdated: 2026-11-01\n---\n# Bicycle bells\n\nA rotary bell's striker hits the dome about 12 times per lever pull.\n",
    );
    writeFileSync(join(root, "secret.md"), "TOP SECRET");
  });

  it("is two tools, search and read — no write — and the guard lets only those through", () => {
    expect(VISUALIZE_VAULT_TOOLS).toEqual(["vault_search", "vault_read"]);
    const ctx = guardContext(paths.jobs, paths.skill);
    for (const id of VISUALIZE_VAULT_TOOL_IDS) expect(checkToolUse(id, { query: "bell" }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("mcp__vault__vault_write", { title: "x" }, ctx)).toMatchObject({ ok: false });
    expect(checkToolUse("mcp__research__vault_write", { title: "x" }, ctx)).toMatchObject({ ok: false });
  });

  it("finds and reads notes, never anything outside the vault, and writes nothing", async () => {
    const before = readdirSync(vault, { recursive: true });
    const found = await vaultSearch("bell striker", vault);
    expect(found.content[0].text).toContain("Bicycle bells (research) — Research/Bicycle bells.md");

    const read = await vaultRead("Bicycle bells", vault);
    expect(read.content[0].text).toContain("12 times per lever pull");

    const outside = await vaultRead("../secret.md", vault);
    expect(outside).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Refused/) }] });
    expect(JSON.stringify(outside)).not.toContain("TOP SECRET");
    expect((await vaultRead("Nothing here", vault)).isError).toBe(true);
    expect(readdirSync(vault, { recursive: true })).toEqual(before);
  });
});
