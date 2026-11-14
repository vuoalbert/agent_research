// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentRunInput, AgentRunResult, RunAgent } from "@/server/visualize/agent";
import { studioPaths, type StudioPaths } from "@/server/visualize/paths";
import { createRunner, type Runner } from "@/server/visualize/runner";

import { GET as getCurrent } from "../current/route";
import { GET as getFigure } from "../jobs/[id]/figure/route";
import { GET as getJob } from "../jobs/[id]/route";
import { POST as stopJob } from "../jobs/[id]/stop/route";

/**
 * /api/visualize/* against a runner on a temp studio (the agent mocked): the
 * current visualization, one job (gone once replaced), Stop, and the figure
 * route — which serves one file only, and locked down.
 */

const KEY = Symbol.for("agent_research.visualize.runner");
type Holder = { [KEY]?: Runner };

let paths: StudioPaths;
let runner: Runner;
let runs: { input: AgentRunInput; finish: (result: AgentRunResult) => void }[];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "visualize-routes-"));
  paths = studioPaths(join(root, ".visualize"));
  mkdirSync(join(paths.plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(paths.skill, { recursive: true });
  writeFileSync(join(paths.skill, "SKILL.md"), "#");
  mkdirSync(join(paths.studio, "bin"), { recursive: true });
  writeFileSync(paths.chrome, "#!/bin/sh\n");
  runs = [];
  const runAgent: RunAgent = (input) =>
    new Promise((resolve) => {
      runs.push({ input, finish: resolve });
      input.signal.addEventListener("abort", () => resolve({ outcome: "aborted" }), { once: true });
    });
  runner = createRunner({ paths, runAgent, pid: process.pid });
  (globalThis as Holder)[KEY] = runner;
});

afterEach(() => {
  delete (globalThis as Holder)[KEY];
  rmSync(join(paths.studio, ".."), { recursive: true, force: true });
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const start = (subject: string, explicit = false) => {
  const result = runner.startJob({ subject, explicit });
  if (result.status !== "started") throw new Error("expected a start");
  return result;
};
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

async function finishWithFigure(html = "<!doctype html><title>Dial</title><script>1</script>") {
  writeFileSync(runs[0].input.paths.workFigure, html);
  runs[0].finish({ outcome: "success" });
  await runner.whenSettled();
}

describe("/api/visualize", () => {
  it("answers the one current visualization, with status, elapsed time and log lines", async () => {
    const empty = await (await getCurrent(request("/api/visualize/current"))).json();
    expect(empty).toEqual({ job: null });

    const { job } = start("a dial indicator");
    runs[0].input.log("Bash: node build.mjs --light");
    const current = (await (await getCurrent(request("/api/visualize/current"))).json()).job;
    expect(current).toMatchObject({ id: job.id, subject: "a dial indicator", status: "running", lastLine: "Bash: node build.mjs --light" });
    expect(typeof current.elapsedMs).toBe("number");
    expect(current.log.map((l: { text: string }) => l.text)).toContain("Bash: node build.mjs --light");
    const bare = (await (await getCurrent(request("/api/visualize/current?lines=0"))).json()).job;
    expect(bare.log).toEqual([]);
  });

  it("returns one job with its log lines, and 404 for anything else — or once it was replaced", async () => {
    const { job } = start("a lock");
    const detail = await (await getJob(request(`/api/visualize/jobs/${job.id}`), ctx(job.id))).json();
    expect(detail.job.id).toBe(job.id);
    expect(detail.job.log.map((l: { text: string }) => l.text)).toContain("Started the background agent (Claude Opus 5.5, anatomy skill)");

    const bare = await (await getJob(request(`/api/visualize/jobs/${job.id}?lines=0`), ctx(job.id))).json();
    expect(bare.job.log).toEqual([]);

    for (const id of ["nope", "../../etc", "..", "a/b"])
      expect((await getJob(request(`/api/visualize/jobs/x`), ctx(id))).status).toBe(404);

    // an explicit request replaces it: the old one is gone
    start("a pin-tumbler lock", true);
    expect((await getJob(request(`/api/visualize/jobs/${job.id}`), ctx(job.id))).status).toBe(404);
  });

  it("stops a job", async () => {
    const { job } = start("a lock");
    const response = await stopJob(request(`/api/visualize/jobs/${job.id}/stop`, { method: "POST" }), ctx(job.id));
    expect(response.status).toBe(200);
    expect((await response.json()).job.status).toBe("stopped");
    expect((await stopJob(request("/x", { method: "POST" }), ctx("missing"))).status).toBe(404);
  });

  it("serves a finished job's figure, and only that, as locked-down HTML", async () => {
    const { job } = start("a dial indicator");
    // nothing to serve while it builds
    expect((await getFigure(request("/f"), ctx(job.id))).status).toBe(404);

    await finishWithFigure();
    const response = await getFigure(request("/f"), ctx(job.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("allow-same-origin");
    const served = await response.text();
    expect(served).toContain("<title>Dial</title>");
    // on white, frameless, with the parts chrome
    expect(served).toContain('data-agent-research="white"');
    expect(served.match(/data-agent-research="chrome"/g)).toHaveLength(2);

    for (const id of ["../../../.env.local", "..", "%2e%2e", `${job.id}/../x`, "", "missing-job"])
      expect((await getFigure(request("/f"), ctx(id))).status, id).toBe(404);
  });
});
