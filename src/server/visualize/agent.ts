import { relative } from "node:path";

import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";

import type { JobRecord } from "@/lib/visualize";

import { BROWSER_SERVER, createBrowserServer, realChromePath, type RunCheck } from "./browser-tool";
import { realDir, secretPaths, type JobPaths, type StudioPaths } from "./paths";
import { BROWSER_TOOL_ID, createGuardHooks, guardContext } from "./policy";
import { describeMessage } from "./progress";

/**
 * The background agent behind one Visualize job: Claude Opus 5.5 at high
 * effort, working in the job's `work/` folder with the anatomy skill, until
 * it has written `work/figure.html`.
 *
 * Auth is this machine's own Claude login, as in /api/chat: no API key is
 * read or set. What it may do (see policy.ts for the layers):
 *   - tools: Skill (studio:anatomy only), Read, Write, Edit, Glob, Grep, Bash,
 *     and browser_check; WebFetch/WebSearch/agents are disallowed outright;
 *   - no filesystem settings at all (`settingSources: []`): the skill comes in
 *     as the local plugin `.visualize/plugin`, so no CLAUDE.md, project hooks
 *     or settings file can be loaded, and none the agent writes would be read;
 *   - `dontAsk`: anything not pre-approved is denied rather than prompted;
 *   - the PreToolUse guard (policy.ts) on every call;
 *   - Bash inside Claude Code's sandbox: writes only in `work/` (and the
 *     sandbox's temp dir), no network, secret paths unreadable, no escape
 *     hatch (`allowUnsandboxedCommands: false`), and the job fails instead of
 *     running unsandboxed if the sandbox cannot start;
 *   - file-tool writes outside the working directory refused by Claude Code
 *     too (`blockWritesOutsideWorkingDirectories`).
 */

export const MODEL = "claude-opus-5-5";
export const EFFORT = "high" as const;
export const MAX_TURNS = 300;

export type AgentRunInput = {
  job: JobRecord;
  studio: StudioPaths;
  paths: JobPaths;
  signal: AbortSignal;
  log: (line: string) => void;
};

export type AgentRunResult =
  | { outcome: "success"; turns?: number; summary?: string }
  | { outcome: "error"; detail: string; turns?: number }
  | { outcome: "aborted" };

export type RunAgent = (input: AgentRunInput) => Promise<AgentRunResult>;

/** env vars that look like credentials stay out of the agent's process (and so its shell) */
const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
export function agentEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_VAR.test(key) && !/^(ANTHROPIC|CLAUDE)_/.test(key)) continue;
    env[key] = value;
  }
  env.CHROME_PATH = realChromePath();
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "agent-research-visualize/1.0";
  return env;
}

export function systemRules(paths: JobPaths, studio: StudioPaths) {
  const skill = relative(paths.work, studio.skill);
  return [
    "# This studio",
    "You are running unattended, as a background job of the Agent Research app. Nobody can answer questions while you work: make sensible decisions yourself and keep going until the figure is finished.",
    `- Your folder is ${paths.work}. It is the only place you can write. The anatomy skill is at ${studio.skill} (read-only); from your folder it is \`${skill}\`.`,
    "- Bash runs in a sandbox with no network. Nothing needs installing: the skill has no dependencies.",
    "- Never publish, push, upload or share anything; never use git remotes or gh. The figure stays on this machine.",
    "- Chrome cannot start inside the Bash sandbox. Run the skill's capture.mjs, drive.mjs and lines.mjs only through the browser_check tool, with the arguments you would give the script (paths relative to your folder). Read every PNG it writes.",
  ].join("\n");
}

export function jobPrompt(job: JobRecord, paths: JobPaths, studio: StudioPaths) {
  const skill = relative(paths.work, studio.skill);
  const ask =
    job.origin === "research"
      ? [
          "Use the anatomy skill to build ONE interactive isometric figure that explains these research findings as a real physical object: invent a gauge, counter, balance, machine or cutaway whose parts, motion and readout encode the key numbers and claims (and shows where sources conflict).",
          "",
          `Research question: ${job.subject}`,
          ...(job.brief ? ["", job.brief] : []),
        ]
      : [
          "Use the anatomy skill to build ONE interactive isometric figure that explains how this works.",
          "",
          `Subject: ${job.subject}`,
          ...(job.brief ? [`Brief: ${job.brief}`] : []),
        ];
  return [
    ...ask,
    "",
    "How to build it:",
    "1. Size: a Figure: one mechanism, 40-80 parts, SVG with at most one WebGL layer. Don't ask; build it.",
    `2. Path: a framework-free standalone HTML page, like examples/dial-indicator: a Node build script in your folder that imports the kit from the skill by relative path (e.g. \`import * as k from "${skill}/kit/iso-kit.mjs"\`) and writes the page with pageHtml and kitScript().`,
    "3. Theme and layout: light only, on a pure white background, with no frame. Build with --light and set the page and card to #FFFFFF (the --anatomy-page, --anatomy-card and --anatomy-paper colours). plateHtml draws a 1px frame round the card: add `.iso-plate{box-shadow:none}` after the kit's CSS so there is no border, box or shadow round the drawing. The app shows the card filling the whole window, so the page is only the card: keep its corner texts (title, the interaction hint and the live readout), but nothing below or around it: no legend keys, no caption, no explanatory paragraph or heading (call plateHtml without keys or caption). Explanations belong in each part's data-part-info.",
    "4. Truth: the readout, the motion and the part descriptions must be true to the real object.",
    "5. Figure contract. The app overlays its own Expand button (top left), hover tooltips, a Parts list (a ~240px panel at the right) and pan/zoom (wheel to zoom, drag on empty space to pan, double-click to reset) on your page, driven only by these hooks. Don't draw your own explode button or parts list, and don't use the wheel, or a drag on empty space, for your own controls.",
    '   - Parts: mark 8-30 meaningful parts or sub-assemblies (what a reader would name, not every screw) by wrapping each one\'s SVG in `<g data-part="Short name" data-part-info="One sentence: what it does.">`. Names are plain words, at most three, unique per part; a part drawn as several groups (back and front halves) puts the same name and info on each. Don\'t nest marked parts. Only groups with both attributes count, so your own `data-part` hooks without `data-part-info` are ignored.',
    '   - Exploded view: `window.addEventListener("ar:explode", (e) => …)` with `e.detail.exploded` true moves the marked parts apart along their real assembly axes (a world offset per part through translateAlong, eased with staggered springs like setApart/steerSpring in examples/raptor-engine/live.js, about 0.6-1 s) far enough that each one reads on its own, keeping the painter\'s order right while apart; false brings them home. Under prefers-reduced-motion jump straight to the pose. The figure\'s own motion keeps working in either pose, and the parts keep their attributes. Check it: drive.mjs `["eval", "dispatchEvent(new CustomEvent(\'ar:explode\', {detail: {exploded: true}}))"]`, wait, then capture the apart pose too.',
    "6. Checks, in proportion to a Figure: a desktop capture, a phone capture (--width 390), the apart pose, the line check (lines.mjs) down to zero, and one or two 4x close-ups of the mechanism; fix what they show. Aim to finish within about 45 minutes, with a working page in the first 15.",
    "7. Finish: copy the final light page to ./figure.html (one self-contained file, everything inlined), then reply with two or three sentences: what the figure shows and how to interact with it.",
  ].join("\n");
}

export function agentOptions(
  input: Pick<AgentRunInput, "studio" | "paths" | "log">,
  abortController: AbortController,
  runCheck?: RunCheck,
  onStderr: (data: string) => void = () => {},
): Options {
  const { studio, paths, log } = input;
  const work = realDir(paths.work);
  const secrets = secretPaths(studio);
  return {
    cwd: work,
    model: MODEL,
    effort: EFFORT,
    thinking: { type: "adaptive" },
    systemPrompt: { type: "preset", preset: "claude_code", append: systemRules(paths, studio) },
    settingSources: [],
    plugins: [{ type: "local", path: studio.plugin, skipMcpDiscovery: true }],
    skills: ["studio:anatomy"],
    tools: ["Skill", "Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", BROWSER_TOOL_ID],
    disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit", "EnterWorktree", "ExitWorktree"],
    permissionMode: "dontAsk",
    mcpServers: {
      [BROWSER_SERVER]: createBrowserServer({
        studio,
        job: paths,
        secrets,
        signal: abortController.signal,
        ...(runCheck ? { run: runCheck } : {}),
      }),
    },
    hooks: {
      PreToolUse: createGuardHooks(guardContext(work, realDir(studio.skill)), (tool, reason) =>
        log(`Blocked ${tool}: ${reason}`),
      ),
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
      filesystem: { denyRead: secrets },
    },
    settings: { permissions: { blockWritesOutsideWorkingDirectories: true } },
    env: agentEnv(),
    maxTurns: MAX_TURNS,
    persistSession: false,
    abortController,
    stderr: onStderr,
  };
}

/** run the agent to the end; never throws */
export function createAgentRunner(query: typeof sdkQuery = sdkQuery, runCheck?: RunCheck): RunAgent {
  return async ({ job, studio, paths, signal, log }) => {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (signal.aborted) return { outcome: "aborted" };
    signal.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    let turns: number | undefined;
    const places = { work: realDir(paths.work), skill: realDir(studio.skill) };
    try {
      const run = query({
        prompt: jobPrompt(job, paths, studio),
        options: agentOptions({ studio, paths, log }, abort, runCheck, (data) => {
          stderr = (stderr + data).slice(-4000);
        }),
      });
      let summary: string | undefined;
      for await (const message of run) {
        if (abort.signal.aborted) break;
        for (const line of describeMessage(message, places)) log(line);
        if (message.type === "result") {
          turns = message.num_turns;
          if (message.subtype === "success") summary = message.result;
          else return { outcome: "error", detail: `the agent stopped: ${message.subtype}`, turns };
        }
      }
      if (abort.signal.aborted) return { outcome: "aborted" };
      return { outcome: "success", turns, summary };
    } catch (error) {
      if (abort.signal.aborted) return { outcome: "aborted" };
      const message = error instanceof Error ? error.message : String(error);
      const tail = stderr.trim().split("\n").slice(-3).join(" ");
      return { outcome: "error", detail: tail ? `${message} (${tail})` : message, turns };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
}
