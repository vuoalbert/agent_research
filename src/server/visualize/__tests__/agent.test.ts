// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentEnv, agentOptions, createAgentRunner, jobPrompt } from "../agent";
import { browserCheck, browserProfile, checkBrowserArgs } from "../browser-tool";
import { jobPaths, secretPaths, studioPaths, type JobPaths, type StudioPaths } from "../paths";
import { BROWSER_TOOL_ID } from "../policy";
import { describeMessage } from "../progress";

/**
 * The background agent's configuration (tools, sandbox, hooks, plugin), the
 * progress lines it leaves, and the browser_check tool's own argument checks
 * — all without a model.
 */

let root: string;
let studio: StudioPaths;
let paths: JobPaths;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "visualize-agent-")));
  studio = studioPaths(join(root, ".visualize"));
  paths = jobPaths(studio, "20261114-1200-a-lock-0000");
  mkdirSync(paths.work, { recursive: true });
  mkdirSync(join(studio.skill, "scripts"), { recursive: true });
  writeFileSync(join(paths.work, "figure.html"), "<p>x</p>");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const job = { id: "20261114-1200-a-lock-0000", subject: "a pin-tumbler lock", status: "running" as const, createdAt: 1 };

describe("the agent's options", () => {
  it("is Opus 5.5 at high effort with only the studio's tools, the anatomy plugin and no filesystem settings", () => {
    const options = agentOptions({ studio, paths, log: () => {} }, new AbortController());
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.effort).toBe("high");
    expect(options.cwd).toBe(paths.work);
    expect(options.settingSources).toEqual([]);
    expect(options.plugins).toEqual([{ type: "local", path: studio.plugin, skipMcpDiscovery: true }]);
    expect(options.skills).toEqual(["studio:anatomy"]);
    expect(options.tools).toEqual(["Skill", "Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    expect(options.allowedTools).toContain(BROWSER_TOOL_ID);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Agent", "Task"]));
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.maxTurns).toBe(300);
    // kept, so a message after the run can resume it
    expect(options.persistSession).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["studio", "vault"]);
    expect(options.allowedTools).toEqual(expect.arrayContaining(["mcp__vault__vault_search", "mcp__vault__vault_read"]));
    expect(options.allowedTools).not.toContain("mcp__vault__vault_write");
    expect(options.hooks?.PreToolUse?.[0].onFailure).toBe("block");
  });

  it("runs Bash sandboxed: no escape hatch, no network, secrets unreadable, fail rather than run bare", () => {
    const { sandbox, settings } = agentOptions({ studio, paths, log: () => {} }, new AbortController());
    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
    });
    expect(sandbox?.filesystem?.denyRead).toEqual(secretPaths(studio));
    expect(sandbox?.filesystem?.denyRead).toEqual(expect.arrayContaining([join(studio.repo, ".env.local")]));
    expect(settings).toEqual({ permissions: { blockWritesOutsideWorkingDirectories: true } });
  });

  it("keeps credential-looking env vars out, and points CHROME_PATH at Chrome", () => {
    const env = agentEnv({ PATH: "/usr/bin", TAVILY_API_KEY: "t", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "a", CLAUDE_CONFIG_DIR: "/c" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
    expect(env).not.toHaveProperty("TAVILY_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env.CHROME_PATH).toMatch(/Chrome/);
  });

  it("asks for one light, framework-free Figure ending in figure.html, and never to publish", () => {
    const prompt = jobPrompt({ ...job, brief: "show the shear line" }, paths, studio);
    expect(prompt).toContain("Subject: a pin-tumbler lock");
    expect(prompt).toContain("Brief: show the shear line");
    expect(prompt).toMatch(/40-80 parts/);
    expect(prompt).toMatch(/--light/);
    expect(prompt).toMatch(/framework-free standalone HTML/);
    expect(prompt).toMatch(/\.\/figure\.html/);
    expect(prompt).toMatch(/no frame/);
    expect(prompt).toMatch(/\.iso-plate\{box-shadow:none\}/);
    const { systemPrompt } = agentOptions({ studio, paths, log: () => {} }, new AbortController());
    expect(JSON.stringify(systemPrompt)).toMatch(/Never publish, push, upload or share/);
    expect(JSON.stringify(systemPrompt)).toMatch(/browser_check/);
  });

  it("spells out the figure contract: marked parts and the ar:explode event", () => {
    const prompt = jobPrompt(job, paths, studio);
    expect(prompt).toMatch(/8-30 meaningful parts/);
    expect(prompt).toContain('<g data-part="Short name" data-part-info="One sentence: what it does.">');
    expect(prompt).toContain('window.addEventListener("ar:explode"');
    expect(prompt).toMatch(/e\.detail\.exploded/);
    expect(prompt).toMatch(/prefers-reduced-motion/);
    expect(prompt).toMatch(/Don't draw your own buttons or parts list/);
    // the card fills the window: its hint and readout stay, nothing below it
    expect(prompt).toMatch(/keep its corner texts \(title, the interaction hint and the live readout\)/);
    expect(prompt).toMatch(/no legend keys, no caption, no explanatory paragraph/);
    expect(prompt).toMatch(/wheel zoom and drag-to-orbit/);
  });

  it("builds in 3D for orbit, with the quick checks only and a 2D fallback", () => {
    const prompt = jobPrompt(job, paths, studio);
    expect(prompt).toMatch(/3D Figure the reader can orbit/);
    expect(prompt).toMatch(/ONE `turn` group named "orbit"/);
    expect(prompt).toContain("`data-ar-orbit`");
    expect(prompt).toContain("`ar:orbit`");
    expect(prompt).toContain("`ar:reset-view`");
    expect(prompt).toMatch(/never wrap them/);
    expect(prompt).toContain("`data-ar-no-explode`");
    expect(prompt).toMatch(/never run it, nor turn-check --pops, --order or --perf/);
    expect(prompt).toMatch(/--audit --quick/);
    expect(prompt).toMatch(/Fallback: .* 2D Figure/);
  });
});

describe("the agent runner", () => {
  async function* messages(...items: unknown[]) {
    for (const item of items) yield item;
  }

  it("turns the agent's messages into progress lines and reports success", async () => {
    const query = vi.fn(() =>
      messages(
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Sizing it as a Figure:\n 60 parts." },
              { type: "tool_use", name: "Bash", input: { command: `cd ${paths.work} && node build.mjs --light\nls` } },
              { type: "tool_use", name: "Read", input: { file_path: join(studio.skill, "SKILL.md") } },
              { type: "tool_use", name: BROWSER_TOOL_ID, input: { script: "capture", args: ["figure.html", "--out", "shots/desk.png"] } },
            ],
          },
        },
        { type: "result", subtype: "success", num_turns: 12, result: "A lock." },
      ),
    );
    const log: string[] = [];
    const run = createAgentRunner(query as never);
    const result = await run({ job, studio, paths, signal: new AbortController().signal, log: (line) => log.push(line) });
    expect(result).toEqual({ outcome: "success", turns: 12, summary: "A lock." });
    expect(log).toEqual([
      "Sizing it as a Figure: 60 parts.",
      "Bash: cd . && node build.mjs --light",
      "Read: anatomy/SKILL.md",
      "Browser: capture figure.html --out shots/desk.png",
      "Agent finished after 12 turns",
    ]);
  });

  it("reports an unsuccessful result, a thrown error, and an abort", async () => {
    const signal = new AbortController().signal;
    const failing = createAgentRunner((() => messages({ type: "result", subtype: "error_max_turns", num_turns: 300 })) as never);
    expect(await failing({ job, studio, paths, signal, log: () => {} })).toEqual({
      outcome: "error",
      detail: "the agent stopped: error_max_turns",
      turns: 300,
    });

    const throwing = createAgentRunner((() => {
      throw new Error("Claude Code is not logged in");
    }) as never);
    expect(await throwing({ job, studio, paths, signal, log: () => {} })).toMatchObject({ outcome: "error", detail: "Claude Code is not logged in" });

    const abort = new AbortController();
    abort.abort();
    expect(await failing({ job, studio, paths, signal: abort.signal, log: () => {} })).toEqual({ outcome: "aborted" });
  });

  it("describes nothing for messages it has no line for", () => {
    expect(describeMessage({ type: "stream_event" }, { work: paths.work, skill: studio.skill })).toEqual([]);
    expect(describeMessage({ type: "user", message: "x" }, { work: paths.work, skill: studio.skill })).toEqual([]);
  });
});

describe("browser_check", () => {
  it("takes a page in the work folder, and file options inside it, never a URL", () => {
    const work = paths.work;
    expect(checkBrowserArgs({ script: "capture", args: ["figure.html", "--out", "shots/desk.png", "--width", "390"] }, work)).toMatchObject({ ok: true });
    expect(checkBrowserArgs({ script: "drive", args: ["figure.html", '[["wait",500],["shot","shots/a.png"]]'] }, work)).toMatchObject({ ok: true });
    expect(checkBrowserArgs({ script: "lines", args: ["--out=shots/lines.png", "figure.html"] }, work)).toMatchObject({ ok: true });

    expect(checkBrowserArgs({ script: "capture", args: ["https://example.com"] }, work)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a URL/) });
    expect(checkBrowserArgs({ script: "capture", args: ["file:///etc/hosts"] }, work)).toMatchObject({ ok: false });
    expect(checkBrowserArgs({ script: "capture", args: ["../../../../.env.local"] }, work)).toMatchObject({ ok: false });
    expect(checkBrowserArgs({ script: "capture", args: ["missing.html"] }, work)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) });
    expect(checkBrowserArgs({ script: "capture", args: ["figure.html", "--out", "../x.png"] }, work)).toMatchObject({ ok: false });
    expect(checkBrowserArgs({ script: "drive", args: ["figure.html", "--preload", "/etc/hosts"] }, work)).toMatchObject({ ok: false });
    expect(checkBrowserArgs({ script: "capture", args: ["--width", "390"] }, work)).toMatchObject({ ok: false, reason: expect.stringMatching(/name the page/) });
    expect(checkBrowserArgs({ script: "publish" as never, args: ["figure.html"] }, work)).toMatchObject({ ok: false });
  });

  it("runs under a profile with no network past localhost and writes only in the work folder", () => {
    const profile = browserProfile("/w/work", ["/home/u/.ssh"], 9333);
    expect(profile).toContain("(deny network*)");
    // one localhost port only: its own DevTools, not this app's routes
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:9333"))');
    expect(profile).not.toContain("localhost:*");
    expect(() => browserProfile("/w/work", [], 0)).toThrow();
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/w/work")');
    expect(profile).toContain('(deny file-read* (subpath "/home/u/.ssh"))');
    expect(profile).not.toMatch(/allow network-outbound \(remote ip "\*/);
  });

  it("refuses bad arguments before anything runs, and returns the script's output", async () => {
    const run = vi.fn(async () => ({ code: 0, output: "saved ./shots/desk.png", timedOut: false }));
    const context = { studio, job: paths, secrets: [], signal: new AbortController().signal, run, platform: "darwin" as const, chromeAvailable: () => true };

    const refused = await browserCheck({ script: "capture", args: ["https://example.com"] }, context);
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/refused/) }] });
    expect(run).not.toHaveBeenCalled();

    const ok = await browserCheck({ script: "capture", args: ["figure.html", "--out", "shots/desk.png"] }, context);
    expect(ok).toEqual({ content: [{ type: "text", text: "exit 0\nsaved ./shots/desk.png" }] });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ script: "capture", args: ["figure.html", "--out", "shots/desk.png"] }));

    expect(await browserCheck({ script: "capture", args: ["figure.html"] }, { ...context, platform: "linux" })).toMatchObject({ isError: true });
    expect(await browserCheck({ script: "capture", args: ["figure.html"] }, { ...context, chromeAvailable: () => false })).toMatchObject({ isError: true });
  });
});
