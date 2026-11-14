#!/usr/bin/env node
/**
 * npm run setup:visualize — set up the Visualize studio, `.visualize/` (git-ignored).
 *
 * The chat's `visualize` tool hands each figure to a background Claude agent.
 * That agent loads the anatomy skill (github.com/wheresryan22/anatomy, MIT) as
 * a local plugin, `.visualize/plugin/`, so it needs no project settings at all:
 *
 *   .visualize/
 *     plugin/.claude-plugin/plugin.json   the plugin "studio"
 *     plugin/skills/anatomy/              the skill: studio:anatomy
 *     bin/chrome                          headless Chrome for the browser checks
 *     jobs/<id>/                          one folder per figure (the runner's)
 *
 * The skill is pinned to the one commit that was reviewed, fetched shallowly at
 * exactly that SHA and checked against it, and then de-fanged:
 *   - `scripts/publish.mjs` (git push + `gh pr create` to the public gallery
 *     with the user's own gh login) and `scripts/session.mjs` (reads Claude
 *     Code session logs, only for publish.mjs) are deleted, with their tests
 *     and `references/publish.md`;
 *   - the clone's `.git` folder and `.github/` are deleted, so the copy has no
 *     remote and nothing to push.
 * Nothing from the skill is committed into this repo.
 *
 * Re-running is safe: a copy already at the pinned commit is re-checked, not
 * fetched again. `--force` fetches it fresh.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/wheresryan22/anatomy.git";
/** the commit the security review covered; never a branch name */
const COMMIT = "1482e8469b0a9e0d8cc18ea2740a01423d29ae80";

/** removed from the copy: everything that can publish, or read session logs to publish */
const REMOVED = [
  ".git",
  ".github",
  "scripts/publish.mjs",
  "scripts/publish.test.mjs",
  "scripts/session.mjs",
  "scripts/session.test.mjs",
  "references/publish.md",
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO = process.env.VISUALIZE_STUDIO_DIR ? resolve(process.env.VISUALIZE_STUDIO_DIR) : join(ROOT, ".visualize");
const PLUGIN = join(STUDIO, "plugin");
const SKILL = join(PLUGIN, "skills", "anatomy");
const MARKER = join(SKILL, ".anatomy-commit");
const CHROME = join(STUDIO, "bin", "chrome");

/**
 * The browser checks run the skill's capture/drive/lines scripts under a macOS
 * seatbelt profile (src/server/visualize/browser-tool.ts): writes only into the
 * job's folder, no network but the one localhost port its DevTools listens on. Chrome cannot start its own sandbox
 * inside another one, so this wrapper turns Chrome's off and the outer profile
 * is the boundary; it also resolves no host names at all.
 */
const CHROME_WRAPPER = `#!/bin/sh
# Headless Chrome for the Visualize studio's browser checks (written by
# scripts/setup-visualize.mjs). Only ever run inside the checks' seatbelt
# profile, which confines it; see src/server/visualize/browser-tool.ts.
# CHROME_DEBUG_PORT pins DevTools to the one localhost port that profile
# allows (a later --remote-debugging-port wins over the script's =0).
port=""
if [ -n "\${CHROME_DEBUG_PORT:-}" ]; then port="--remote-debugging-port=\${CHROME_DEBUG_PORT}"; fi
exec "\${ANATOMY_REAL_CHROME:?ANATOMY_REAL_CHROME is not set}" --no-sandbox --disable-breakpad \\
  --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1" "$@" $port
`;

const force = process.argv.includes("--force");

/** git with no hooks, no prompts, no credential helper and no local-file transport */
function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c", "core.hooksPath=/dev/null",
      "-c", "credential.helper=",
      "-c", "protocol.file.allow=never",
      "-c", "advice.detachedHead=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function check() {
  const problems = [];
  if (!existsSync(join(SKILL, "SKILL.md"))) problems.push("SKILL.md is missing");
  for (const path of REMOVED) if (existsSync(join(SKILL, path))) problems.push(`${path} is still present`);
  const marker = existsSync(MARKER) ? readFileSync(MARKER, "utf8").trim() : "";
  if (marker !== COMMIT) problems.push(`the copy is not at ${COMMIT.slice(0, 12)}`);
  return problems;
}

function install() {
  mkdirSync(STUDIO, { recursive: true });
  // fetch into a scratch folder inside the studio, so the swap is one rename
  const scratch = mkdtempSync(join(STUDIO, ".anatomy-"));
  try {
    git(scratch, "init", "--quiet");
    git(scratch, "fetch", "--quiet", "--depth", "1", REPO_URL, COMMIT);
    git(scratch, "checkout", "--quiet", "FETCH_HEAD");
    const head = git(scratch, "rev-parse", "HEAD");
    if (head !== COMMIT) throw new Error(`fetched ${head}, expected ${COMMIT}`);

    for (const path of REMOVED) rmSync(join(scratch, path), { recursive: true, force: true });
    writeFileSync(join(scratch, ".anatomy-commit"), `${COMMIT}\n`);

    rmSync(SKILL, { recursive: true, force: true });
    mkdirSync(dirname(SKILL), { recursive: true });
    renameSync(scratch, SKILL);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const current = check();
if (force || current.length > 0) {
  console.log(`Installing anatomy @ ${COMMIT.slice(0, 12)} into ${SKILL}`);
  install();
} else {
  console.log(`anatomy @ ${COMMIT.slice(0, 12)} is already installed in ${SKILL}`);
}

mkdirSync(join(PLUGIN, ".claude-plugin"), { recursive: true });
writeFileSync(
  join(PLUGIN, ".claude-plugin", "plugin.json"),
  `${JSON.stringify(
    {
      name: "studio",
      version: "1.0.0",
      description: `The Visualize studio: the anatomy skill @ ${COMMIT.slice(0, 12)}, without its publish script`,
    },
    null,
    2,
  )}\n`,
);
mkdirSync(dirname(CHROME), { recursive: true });
writeFileSync(CHROME, CHROME_WRAPPER);
chmodSync(CHROME, 0o755);
mkdirSync(join(STUDIO, "jobs"), { recursive: true });

const problems = check();
if (problems.length > 0) {
  console.error(`setup:visualize failed: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`Removed from the copy: ${REMOVED.join(", ")}`);
console.log(`Studio ready: ${STUDIO}`);
