// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  BROWSER_TOOL_ID,
  checkToolUse,
  createGuardHooks,
  guardContext,
  splitCommands,
  type GuardContext,
} from "../policy";

/**
 * The background agent's PreToolUse guard: publishing, pushing, gh, network
 * tools and installs are refused; writes land only in the job's work folder;
 * reads stay in the work folder and the skill.
 */

let root: string;
let ctx: GuardContext;
let work: string;
let skill: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "visualize-policy-")));
  work = join(root, "jobs", "job-1", "work");
  skill = join(root, "plugin", "skills", "anatomy");
  mkdirSync(join(work, "shots"), { recursive: true });
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# anatomy");
  writeFileSync(join(root, ".env.local"), "SECRET=1");
  // a link inside the work folder that points out of it
  symlinkSync(root, join(work, "escape"));
  ctx = guardContext(work, skill, "/usr/local/bin/node");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const bash = (command: string) => checkToolUse("Bash", { command }, ctx);
const denied = (verdict: ReturnType<typeof checkToolUse>) => !verdict.ok;

describe("Bash", () => {
  it.each([
    "node build.mjs --light",
    "node build.mjs --light && ls -la",
    "mkdir -p shots && cp page-light.html figure.html",
    "cat ../../../plugin/skills/anatomy/SKILL.md | head -40",
    `ls ${skill}/examples`,
    "rm -rf shots/*",
    "node build.mjs > build.log 2>&1",
    "date",
    "sed -n 1,40p ../../../plugin/skills/anatomy/kit/iso-kit.mjs",
    "node --check build.mjs",
    `node -e "console.log(Object.keys(require('../../../plugin/skills/anatomy/kit/x.mjs')))"`,
    "node drive-steps.mjs shots/a.png kit/iso-kit.mjs",
    'echo "$TMPDIR" > /dev/null',
  ])("allows %s", (command) => {
    // the skill sits at ../../../plugin/skills/anatomy from work in the real layout
    expect(bash(command)).toEqual({ ok: true });
  });

  it.each([
    ["node ../../../plugin/skills/anatomy/scripts/publish.mjs figure --submit", /publishing is off/],
    ["npm publish", /publishing is off/],
    ["git push origin main", /git remotes/],
    ["git -C . push", /git remotes/],
    ["git remote add origin https://example.com/x.git", /git remotes/],
    ["gh pr create --title x", /^gh:/],
    ["ls && gh repo fork", /^gh:/],
    ["curl https://example.com", /^curl:/],
    ["wget https://example.com", /^wget:/],
    ["ssh user@host", /^ssh:/],
    ["scp figure.html user@host:", /^scp:/],
    ["xargs -n1 curl < urls.txt", /^curl:/],
    ["env FOO=1 curl https://example.com", /^curl:/],
    ["npm install left-pad", /^npm:/],
    ["npx some-tool", /^npx:/],
    ["open figure.html", /^open:/],
    ["pkill node", /^pkill:/],
    ["ln -s / root", /^ln:/],
    ['echo "$(curl https://example.com)"', /^curl:/],
    ['bash -c "curl https://example.com"', /^curl:/],
    ["sh -lc 'gh repo list'", /^gh:/],
    ['eval "ssh host"', /^ssh:/],
    ['bash -c "touch ../planted.txt"', /writable/],
    ["echo \"`gh auth token`\"", /^gh:/],
    ['x="$(echo "$(wget -qO- https://example.com)")"', /^wget:/],
  ])("refuses %s", (command, reason) => {
    const verdict = bash(command);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(reason);
  });

  it.each([
    "touch ../outside.txt",
    "echo x > ../../job-2/work/figure.html",
    "cp figure.html ../../../plugin/skills/anatomy/SKILL.md",
    "echo x >> ROOT/notes.txt",
    "mkdir /tmp/elsewhere",
    "rm -rf ..",
    "tee ../log.txt < build.log",
    "node build.mjs --out ../page.html",
    "node build.mjs --out=../page.html",
    "sed -i '' s/a/b/ ../../../plugin/skills/anatomy/SKILL.md",
    "touch escape/planted.txt",
    "echo x > $HOME/planted.txt",
    "cd .. && touch planted.txt",
    "cd $HOME",
  ])("refuses a write outside the job folder: %s", (command) => {
    expect(denied(bash(command.replace("ROOT", root)))).toBe(true);
  });

  it.each([
    "cat ../../../.env.local",
    "cat ROOT/.env.local",
    "cat ~/.ssh/id_ed25519",
    "cat escape/.env.local",
    "ls /Users",
  ])("refuses a read outside the studio: %s", (command) => {
    expect(denied(bash(command.replace("ROOT", root)))).toBe(true);
  });

  it("refuses Claude Code settings, and sends the Chrome scripts to browser_check", () => {
    expect(bash("echo '{}' > .claude/settings.json")).toMatchObject({ ok: false });
    expect(bash("cat ~/.claude/settings.json")).toMatchObject({ ok: false });
    const chrome = bash("node ../../../plugin/skills/anatomy/scripts/capture.mjs figure.html --out shots/a.png");
    expect(chrome).toMatchObject({ ok: false, reason: expect.stringMatching(/browser_check/) });
    // reading the script's source is fine
    expect(bash("sed -n 1,30p ../../../plugin/skills/anatomy/scripts/capture.mjs")).toEqual({ ok: true });
  });

  it("lets the shell cd into the skill to look around, but not write from there", () => {
    expect(bash("cd ../../../plugin/skills/anatomy && ls examples && wc -l references/*.md")).toEqual({ ok: true });
    expect(bash("cd ../../../plugin/skills/anatomy && touch planted.txt")).toMatchObject({ ok: false });
    expect(bash("cd ../../../plugin/skills/anatomy && node examples/x/build.mjs > out.html")).toMatchObject({ ok: false });
    expect(bash("cd ../../../plugin && ls")).toMatchObject({ ok: false });
  });

  it("refuses a request to run unsandboxed", () => {
    expect(checkToolUse("Bash", { command: "ls", dangerouslyDisableSandbox: true }, ctx)).toMatchObject({ ok: false });
  });

  it("resolves relative paths from the shell's cwd while it is inside the work folder", () => {
    const shots = join(work, "shots");
    expect(checkToolUse("Bash", { command: "touch ../figure.html" }, ctx, shots)).toEqual({ ok: true });
    expect(checkToolUse("Bash", { command: "touch ../../x" }, ctx, shots)).toMatchObject({ ok: false });
    // a cwd outside the work folder does not count: paths resolve from work
    expect(checkToolUse("Bash", { command: "touch x" }, ctx, root)).toEqual({ ok: true });
  });

  it("splits a command line into simple commands and words, honouring quotes", () => {
    const words = splitCommands(`node -e "a; b" && echo 'x y' > out.txt | tee log; ls`).map((c) => c.map((w) => w.text));
    expect(words).toEqual([["node", "-e", "a; b"], ["echo", "x y", ">", "out.txt"], ["tee", "log"], ["ls"]]);
  });
});

describe("file tools", () => {
  it("lets Write and Edit work only inside the job folder", () => {
    expect(checkToolUse("Write", { file_path: join(work, "build.mjs"), content: "" }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("Write", { file_path: "shots/notes.md", content: "" }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("Edit", { file_path: "figure.html", old_string: "a", new_string: "b" }, ctx)).toEqual({ ok: true });
    for (const file_path of [
      "../outside.txt",
      join(root, "jobs", "job-1", "job.json"),
      join(skill, "SKILL.md"),
      join(root, ".env.local"),
      "escape/planted.txt",
      ".claude/settings.json",
      "/etc/hosts",
    ]) {
      expect(checkToolUse("Write", { file_path, content: "x" }, ctx), file_path).toMatchObject({ ok: false });
      expect(checkToolUse("Edit", { file_path, old_string: "a", new_string: "b" }, ctx), file_path).toMatchObject({ ok: false });
    }
  });

  it("lets Read, Glob and Grep look only in the job folder and the skill", () => {
    expect(checkToolUse("Read", { file_path: join(skill, "SKILL.md") }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("Read", { file_path: "shots/desk.png" }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("Glob", { pattern: "**/*.mjs", path: skill }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("Grep", { pattern: "fitProjection", path: skill }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("Read", { file_path: join(root, ".env.local") }, ctx)).toMatchObject({ ok: false });
    expect(checkToolUse("Read", { file_path: "escape/.env.local" }, ctx)).toMatchObject({ ok: false });
    expect(checkToolUse("Read", { file_path: "~/.ssh/id_rsa" }, ctx)).toMatchObject({ ok: false });
    expect(checkToolUse("Glob", { pattern: "../../../**/.env*" }, ctx)).toMatchObject({ ok: false });
    expect(checkToolUse("Glob", { pattern: "*", path: root }, ctx)).toMatchObject({ ok: false });
    expect(checkToolUse("Grep", { pattern: "KEY", path: "/Users" }, ctx)).toMatchObject({ ok: false });
  });

  it("allows only the anatomy skill, the browser tool, and nothing unknown", () => {
    expect(checkToolUse("Skill", { skill: "studio:anatomy" }, ctx)).toEqual({ ok: true });
    expect(checkToolUse("Skill", { skill: "publish" }, ctx)).toMatchObject({ ok: false });
    expect(checkToolUse(BROWSER_TOOL_ID, { script: "capture", args: [] }, ctx)).toEqual({ ok: true });
    for (const tool of ["WebFetch", "WebSearch", "Agent", "Task", "mcp__other__x"])
      expect(checkToolUse(tool, {}, ctx), tool).toMatchObject({ ok: false });
  });
});

describe("the SDK hook", () => {
  const input = (tool_name: string, tool_input: unknown) => ({
    hook_event_name: "PreToolUse" as const,
    tool_name,
    tool_input,
    tool_use_id: "t1",
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: work,
  });

  it("denies with a reason, tells onDeny, blocks if it ever throws, and stays out of the way otherwise", async () => {
    const onDeny = vi.fn();
    const [matcher] = createGuardHooks(ctx, onDeny);
    expect(matcher.onFailure).toBe("block");
    const hook = matcher.hooks[0];
    const options = { signal: new AbortController().signal };

    const refused = await hook(input("Bash", { command: "git push" }), "t1", options);
    expect(refused).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/git remotes/),
      },
    });
    expect(onDeny).toHaveBeenCalledWith("Bash", expect.stringMatching(/git remotes/));

    expect(await hook(input("Bash", { command: "node build.mjs --light" }), "t2", options)).toEqual({});
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});
