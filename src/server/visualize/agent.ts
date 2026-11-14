import { relative } from "node:path";

import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";

import type { JobRecord } from "@/lib/visualize";

import { BROWSER_SERVER, createBrowserServer, realChromePath, type RunCheck } from "./browser-tool";
import { createInbox, type Inbox } from "./inbox";
import { MESSAGING_RULES } from "./messages";
import { realDir, secretPaths, type JobPaths, type StudioPaths } from "./paths";
import { BROWSER_TOOL_ID, createGuardHooks, guardContext } from "./policy";
import { describeMessage } from "./progress";
import { VISUALIZE_VAULT_SERVER, VISUALIZE_VAULT_TOOL_IDS, createVaultServer } from "./vault-server";

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
 *     too (`blockWritesOutsideWorkingDirectories`);
 *   - the research vault read-only (vault_search, vault_read), in-process.
 *
 * It runs in streaming-input mode (inbox.ts): the chat's messages reach it
 * mid-build, and its session is kept (`persistSession`) so a message after
 * the run ended can `resume` it with these same options.
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
  /** the run's input; the runner keeps it to push the chat's messages in mid-run */
  inbox?: Inbox;
  /** resume this session (a finished build) instead of starting one */
  resume?: string;
  /** the first turn; the build prompt (jobPrompt) when absent */
  prompt?: string;
  /** hears the session id as soon as the session has started */
  onSession?: (sessionId: string) => void;
};

export type AgentRunResult =
  | { outcome: "success"; turns?: number; summary?: string }
  | { outcome: "error"; detail: string; turns?: number }
  | { outcome: "aborted" };

export type RunAgent = (input: AgentRunInput) => Promise<AgentRunResult>;

/**
 * After a result that left a pushed message unconsumed (and nothing queued),
 * how long to wait for the turn that takes it before ending the run anyway;
 * the runner then resumes the session with that message.
 */
export const SETTLE_GRACE_MS = 30_000;

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
    `1. Mode and size: a 3D Figure the reader can orbit, in the skill's optional 3D mode. Read references/3d.md (sections 1-5 and 13-15) and examples/turning-dial (build.mjs, live.js) first. The object stands on a turntable: put the whole object in ONE \`turn\` group named "orbit" (pivot under its centre); only a plain ground plate or shadow stays static. Keep it small: 20-40 live parts, weight at most 50 (section 15): prisms, rounds and fixed pictures; no lathes, no balls with flats, at most a few tube chunks; texture as details, not parts. Don't ask; build it.`,
    `2. Path: a framework-free standalone HTML page, like examples/turning-dial: a Node build script in your folder that imports the kit, audit, turn-build and inline-kit modules from the skill by relative path (e.g. \`import * as k from "${skill}/kit/iso-kit.mjs"\`, \`import { turning } from "${skill}/kit/turn-build.mjs"\`) and writes the page with pageHtml and turnScript() plus your live code. \`poses()\` lists \`follow({ orbit: θ, apart: a })\` for θ every 1° over 0-359 at apart 0 and every 3° at apart 1, plus the apart clip (0 to 1 at 60 fps) at θ = 0, 90, 180 and 270.`,
    "3. Theme and layout: light only, on a pure white background, with no frame. Build with --light and set the page and card to #FFFFFF (the --anatomy-page, --anatomy-card and --anatomy-paper colours). plateHtml draws a 1px frame round the card: add `.iso-plate{box-shadow:none}` after the kit's CSS so there is no border, box or shadow round the drawing. The app shows the card filling the whole window, so the page is only the card: keep its corner texts (title, the interaction hint and the live readout), but nothing below or around it: no legend keys, no caption, no explanatory paragraph or heading (call plateHtml without keys or caption). Explanations belong in each part's data-part-info.",
    "4. Truth: the readout, the motion and the part descriptions must be true to the real object.",
    "5. Figure contract. The app overlays its own controls (Expand, Reset view), hover tooltips, a Parts list (a ~240px panel at the right), wheel zoom and drag-to-orbit on your page, driven only by these hooks. Don't draw your own buttons or parts list, and don't wire your own drag or wheel.",
    '   - Orbit: put `data-ar-orbit` on the stage. On a drag the app dispatches `window` event `ar:orbit` with `e.detail.yaw` (degrees to turn by): call `e.preventDefault()`, add it to the orbit angle and render through `controller.set(follow({ orbit, apart }))` in your own frame loop. On `ar:reset-view` ease the angle back to its rest value. A slow idle spin is fine until the first `ar:orbit`; under prefers-reduced-motion there is none.',
    '   - Parts: mark 8-30 meaningful parts or sub-assemblies (what a reader would name, not every screw) with `<g data-part="Short name" data-part-info="One sentence: what it does.">`. Names are plain words, at most three, unique per part; every node of a part carries the same name and info. In 3D the runtime re-sorts the live part nodes, so never wrap them: after T.build, rewrite the markup of `out.layerSvg(...)` to add both attributes to each live `<g … data-name="…">` of that part (a map from your part-name prefixes). Static art may be wrapped. Only nodes with both attributes count.',
    '   - Exploded view: put each marked part\'s live parts in a `slide` group, a child of `orbit`, along its real assembly axis with enough travel to clear its neighbours; `follow` maps `apart` (0 to 1) onto every slide, staggered. `window.addEventListener("ar:explode", (e) => …)` springs `apart` to 1 when `e.detail.exploded` is true and back to 0 when false (about 0.6-1 s; under prefers-reduced-motion jump straight there). Orbit keeps working while apart. If T.build can\'t separate the apart states after about 10 minutes of trying, drop the explode and put `data-ar-no-explode` on the stage: the app then hides Expand.',
    "6. Checks, quick ones only (the full orbit audit takes 15-20 minutes: never run it, nor turn-check --pops, --order or --perf): `node build.mjs --light` (T.build must succeed), one `node build.mjs --audit --quick` near the end, a desktop capture, a phone capture (--width 390), a drive.mjs orbit sheet `[\"orbit\", \"orbit.png\", 0, 345, 15]` and one capture after `[\"eval\", \"dispatchEvent(new CustomEvent('ar:explode', {detail: {exploded: true}}))\"]`; fix what they show. Aim to finish within about 45 minutes, with a working page in the first 20.",
    "7. Fallback: if after about 25 minutes the 3D scene still won't build, build a 2D Figure instead (40-80 parts, like examples/dial-indicator, no data-ar-orbit) with the same contract: wrap each marked part in its `<g data-part data-part-info>` and move parts apart with translateAlong offsets and staggered springs (setApart/steerSpring in examples/raptor-engine/live.js) on `ar:explode`.",
    "8. Finish: copy the final light page to ./figure.html (one self-contained file, everything inlined), then reply with two or three sentences: what the figure shows and how to interact with it.",
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
    systemPrompt: { type: "preset", preset: "claude_code", append: `${systemRules(paths, studio)}\n\n${MESSAGING_RULES}` },
    settingSources: [],
    plugins: [{ type: "local", path: studio.plugin, skipMcpDiscovery: true }],
    skills: ["studio:anatomy"],
    tools: ["Skill", "Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", BROWSER_TOOL_ID, ...VISUALIZE_VAULT_TOOL_IDS],
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
      [VISUALIZE_VAULT_SERVER]: createVaultServer(),
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
    // kept on disk (~/.claude/projects, which the sandbox cannot read) so a
    // message after the run can resume it; the runner deletes it with the job
    persistSession: true,
    abortController,
    stderr: onStderr,
  };
}

/**
 * Run the agent to the end; never throws. The first turn is `prompt` (the
 * build, or a resumed session's message); the inbox stays open for the chat's
 * messages until a result leaves none of them unconsumed, then it closes and
 * the run ends.
 */
export function createAgentRunner(query: typeof sdkQuery = sdkQuery, runCheck?: RunCheck): RunAgent {
  return async ({ job, studio, paths, signal, log, inbox = createInbox(), resume, prompt, onSession }) => {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (signal.aborted) {
      inbox.close();
      return { outcome: "aborted" };
    }
    signal.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    let turns: number | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const places = { work: realDir(paths.work), skill: realDir(studio.skill) };
    try {
      inbox.push(prompt ?? jobPrompt(job, paths, studio));
      const run = query({
        prompt: inbox,
        options: {
          ...agentOptions({ studio, paths, log }, abort, runCheck, (data) => {
            stderr = (stderr + data).slice(-4000);
          }),
          ...(resume ? { resume } : {}),
        },
      });
      let summary: string | undefined;
      let session: string | undefined;
      for await (const message of run) {
        if (abort.signal.aborted) break;
        // anything from the agent means the turn that takes the message has begun
        clearTimeout(grace);
        if (message.type === "system" && message.subtype === "init" && message.session_id && message.session_id !== session) {
          session = message.session_id;
          onSession?.(session);
        }
        if (message.type === "assistant" || message.type === "result") inbox.consumed(message.user_message_uuids);
        for (const line of describeMessage(message, places)) log(line);
        if (message.type === "result") {
          turns = message.num_turns;
          if (message.subtype !== "success") return { outcome: "error", detail: `the agent stopped: ${message.subtype}`, turns };
          summary = message.result;
          // more turns follow on their own while a message is queued or still on its way
          if ((message.queued_turn_count ?? 0) > 0) continue;
          if (inbox.settled()) inbox.close();
          else grace = setTimeout(() => inbox.close(), SETTLE_GRACE_MS);
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
      clearTimeout(grace);
      inbox.close();
      signal.removeEventListener("abort", onAbort);
    }
  };
}
