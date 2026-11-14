// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunInput, AgentRunResult, RunAgent } from "../agent";
import { jobPaths, studioPaths, type StudioPaths } from "../paths";
import { StudioNotReadyError, createRunner, type StartResult } from "../runner";

/**
 * The runner with the agent mocked. There is only ever one visualization:
 * automatic starts leave a running one alone and replace a finished one;
 * explicit starts stop and discard whatever is there; replaced folders are
 * deleted. Plus done / error / stopped / timed out, and what a restart does.
 */

let paths: StudioPaths;

/** a set-up studio in a temp folder */
function studio() {
  const root = mkdtempSync(join(tmpdir(), "visualize-runner-"));
  const p = studioPaths(join(root, ".visualize"));
  mkdirSync(p.skill, { recursive: true });
  writeFileSync(join(p.skill, "SKILL.md"), "# anatomy");
  mkdirSync(join(p.plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(p.studio, "bin"), { recursive: true });
  writeFileSync(p.chrome, "#!/bin/sh\n");
  mkdirSync(p.jobs, { recursive: true });
  return p;
}

/** an agent whose runs the test finishes by hand */
function controllableAgent() {
  const runs: { input: AgentRunInput; finish: (result: AgentRunResult) => void }[] = [];
  const runAgent: RunAgent = (input) =>
    new Promise((resolve) => {
      runs.push({ input, finish: resolve });
      input.signal.addEventListener("abort", () => resolve({ outcome: "aborted" }), { once: true });
    });
  return { runs, runAgent };
}

const writeFigure = (input: AgentRunInput, html = "<!doctype html><title>fig</title>") =>
  writeFileSync(input.paths.workFigure, html);

const started = (result: StartResult) => {
  if (result.status !== "started") throw new Error(`expected a start, got ${result.status}`);
  return result;
};

const jobFolders = () => readdirSync(paths.jobs);

beforeEach(() => {
  paths = studio();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(join(paths.studio, ".."), { recursive: true, force: true });
});

describe("the Visualize runner", () => {
  it("starts at once, runs to done, and keeps a copy of the figure beside the work folder", async () => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });

    const { job } = started(runner.startJob({ subject: "  a dial   indicator ", brief: "show the rack and pinion" }));
    expect(job.subject).toBe("a dial indicator");
    expect(job.status).toBe("running");
    expect(job.id).toMatch(/^\d{8}-\d{4}-a-dial-indicator-[0-9a-f]{4}$/);
    expect(runs).toHaveLength(1);
    expect(runs[0].input.job.brief).toBe("show the rack and pinion");
    runs[0].input.log("Bash: node build.mjs --light");

    writeFigure(runs[0].input);
    runs[0].finish({ outcome: "success", turns: 42 });
    await runner.whenSettled();

    const done = runner.currentJob()!;
    expect(done).toMatchObject({ id: job.id, status: "done", figure: "figure.html", turns: 42 });
    expect(done.log.map((line) => line.text)).toEqual([
      "Started the background agent (Claude Opus 5.5, anatomy skill)",
      "Bash: node build.mjs --light",
      "Figure ready",
    ]);
    const served = runner.figureFile(job.id)!;
    expect(served).toBe(jobPaths(paths, job.id).figure);
    expect(readFileSync(served, "utf8")).toContain("<title>fig</title>");
    expect(JSON.parse(readFileSync(jobPaths(paths, job.id).record, "utf8")).status).toBe("done");
  });

  it("does nothing on an automatic start while the current one is still building", () => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const first = started(runner.startJob({ subject: "first", origin: "research" })).job;

    const again = runner.startJob({ subject: "second", origin: "research" });
    expect(again).toEqual({ status: "busy", job: expect.objectContaining({ id: first.id, subject: "first" }) });
    expect(runs).toHaveLength(1);
    expect(runs[0].input.signal.aborted).toBe(false);
    expect(jobFolders()).toEqual([first.id]);
    expect(runner.currentJob()?.id).toBe(first.id);
  });

  it("replaces a finished one on an automatic start, deleting its folder", async () => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const first = started(runner.startJob({ subject: "first" })).job;
    writeFigure(runs[0].input);
    runs[0].finish({ outcome: "success" });
    await runner.whenSettled();

    const second = started(runner.startJob({ subject: "second", origin: "research" }));
    expect(second.replaced).toBe(first.id);
    expect(runs).toHaveLength(2);
    expect(jobFolders()).toEqual([second.job.id]);
    expect(existsSync(jobPaths(paths, first.id).dir)).toBe(false);
    expect(runner.getJob(first.id)).toBeNull();
    expect(runner.figureFile(first.id)).toBeNull();
    expect(runner.currentJob()?.lastLine).toBe('Started the background agent (Claude Opus 5.5, anatomy skill), replacing "first"');
  });

  it.each(["error", "stopped"] as const)("replaces one that %s on an automatic start too", async (how) => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const first = started(runner.startJob({ subject: "first" })).job;
    if (how === "error") runs[0].finish({ outcome: "error", detail: "boom" });
    else await runner.stopJob(first.id);
    await runner.whenSettled();
    expect(runner.currentJob()?.status).toBe(how);

    expect(runner.startJob({ subject: "second" }).status).toBe("started");
    expect(jobFolders()).toHaveLength(1);
  });

  it("stops, discards and replaces a running one on an explicit start", async () => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const first = started(runner.startJob({ subject: "first", origin: "research" })).job;
    runs[0].input.log("Bash: node build.mjs");

    const second = started(runner.startJob({ subject: "what the user asked for", explicit: true }));
    expect(runs[0].input.signal.aborted).toBe(true);
    expect(second.replaced).toBe(first.id);
    expect(existsSync(jobPaths(paths, first.id).dir)).toBe(false);
    expect(runs).toHaveLength(2);

    // the discarded run winding down afterwards brings nothing back
    runs[0].input.log("a late line");
    await Promise.resolve();
    await Promise.resolve();
    expect(existsSync(jobPaths(paths, first.id).dir)).toBe(false);
    expect(jobFolders()).toEqual([second.job.id]);
    expect(runner.currentJob()).toMatchObject({ id: second.job.id, status: "running", subject: "what the user asked for" });
  });

  it("fails a job that ends without a figure, or with an error", async () => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });

    const a = started(runner.startJob({ subject: "no figure" })).job;
    runs[0].finish({ outcome: "success" });
    await runner.whenSettled();
    expect(runner.getJob(a.id)).toMatchObject({ status: "error", error: expect.stringMatching(/without writing figure\.html/) });
    expect(runner.figureFile(a.id)).toBeNull();

    const b = started(runner.startJob({ subject: "broken" })).job;
    runs[1].finish({ outcome: "error", detail: "the agent stopped: error_max_turns" });
    await runner.whenSettled();
    expect(runner.getJob(b.id)).toMatchObject({ status: "error", error: "the agent stopped: error_max_turns" });
    expect(runner.getJob(b.id)?.lastLine).toBe("Failed: the agent stopped: error_max_turns");
  });

  it("stops a running job; stopping a finished or unknown one changes nothing", async () => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const job = started(runner.startJob({ subject: "running" })).job;

    expect(await runner.stopJob(job.id)).toMatchObject({ status: "stopped", error: "Stopped before it finished." });
    expect(runs[0].input.signal.aborted).toBe(true);
    expect(await runner.stopJob(job.id)).toMatchObject({ status: "stopped" });
    expect(await runner.stopJob("no-such-job")).toBeNull();
  });

  it("gives a job 60 minutes: a figure written by then counts, otherwise it failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });

    const late = started(runner.startJob({ subject: "late but drawn" })).job;
    writeFigure(runs[0].input);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await runner.whenSettled();
    expect(runs[0].input.signal.aborted).toBe(true);
    expect(runner.getJob(late.id)).toMatchObject({ status: "done", figure: "figure.html", note: expect.stringMatching(/60-minute limit/) });

    const empty = started(runner.startJob({ subject: "never drawn" })).job;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await runner.whenSettled();
    expect(runner.getJob(empty.id)).toMatchObject({ status: "error", error: expect.stringMatching(/Ran out of time/) });
  });

  it("marks what an earlier server process was running as interrupted, and clears out older folders", () => {
    const { runs, runAgent } = controllableAgent();
    const before = createRunner({ paths, runAgent, pid: 1 });
    const job = started(before.startJob({ subject: "mid-run" })).job;
    writeFigure(runs[0].input, "<p>partial</p>");
    // a stray folder from long ago
    mkdirSync(join(paths.jobs, "20200101-0000-old-0000", "work"), { recursive: true });

    // the same process making a runner again (a dev reload) leaves it running
    createRunner({ paths, runAgent: controllableAgent().runAgent, pid: 1 });
    expect(before.getJob(job.id)?.status).toBe("running");

    // a new process does not
    const after = createRunner({ paths, runAgent: controllableAgent().runAgent, pid: 2 });
    expect(after.currentJob()).toMatchObject({
      id: job.id,
      status: "interrupted",
      error: expect.stringMatching(/restarted while/),
      figure: "figure.html",
      lastLine: "Interrupted: the server restarted",
    });
    expect(jobFolders()).toEqual([job.id]);
    // and the next automatic start replaces it
    expect(after.startJob({ subject: "next" }).status).toBe("started");
  });

  it("refuses to start without a set-up studio, or without a subject", () => {
    const runner = createRunner({ paths, runAgent: controllableAgent().runAgent, pid: 1 });
    expect(runner.currentJob()).toBeNull();
    expect(() => runner.startJob({ subject: "   " })).toThrow(/subject/);
    rmSync(paths.skill, { recursive: true, force: true });
    expect(runner.ready()).toBe(false);
    expect(() => runner.startJob({ subject: "a lock" })).toThrow(StudioNotReadyError);
    expect(runner.currentJob()).toBeNull();
  });

  it("serves only a finished job's own figure", async () => {
    const { runs, runAgent } = controllableAgent();
    const runner = createRunner({ paths, runAgent, pid: 1 });
    const job = started(runner.startJob({ subject: "a lock" })).job;
    writeFigure(runs[0].input);
    // not before the job is done, even though the agent wrote one
    expect(runner.figureFile(job.id)).toBeNull();
    runs[0].finish({ outcome: "success" });
    await runner.whenSettled();
    expect(runner.figureFile(job.id)).toBe(jobPaths(paths, job.id).figure);
    for (const id of ["../etc", "..", "a/b", "", `${job.id}/../x`]) expect(runner.figureFile(id)).toBeNull();
  });
});
