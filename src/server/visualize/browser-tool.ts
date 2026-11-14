import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { isInside, realTarget, type JobPaths, type StudioPaths } from "./paths";

/**
 * browser_check — the anatomy skill's Chrome scripts, for the background agent.
 *
 * The agent's Bash runs in Claude Code's sandbox, and Chrome cannot start
 * there (it aborts setting up its own macOS sandbox inside another one). So
 * the three reviewed scripts that drive headless Chrome — `capture.mjs`,
 * `drive.mjs` and `lines.mjs` — run through this tool instead, from the
 * server, never from the agent's shell:
 *
 * - only those three scripts, from the pinned skill copy, by name;
 * - the page, `--out`, `--actions` and `--preload` must be files in the job's
 *   `work/` folder; no URLs;
 * - the whole process tree (node and Chrome) runs under a seatbelt profile
 *   (`/usr/bin/sandbox-exec`): file writes only inside `work/`; no network
 *   but ONE localhost port, the DevTools port picked for this check (so the
 *   page cannot reach this app's own routes on localhost, or anything else);
 *   Unix sockets only inside `work/` (so no DNS resolver either); and the
 *   secret paths in `secretPaths()` unreadable. Chrome's own sandbox is off
 *   (`.visualize/bin/chrome`) because it cannot nest; this profile is the
 *   boundary, so even the agent's page JS cannot reach the network.
 * - a minimal environment (no API keys), a 6-minute limit per check, and the
 *   job's abort signal kills the whole process group.
 */

export const BROWSER_SERVER = "studio";
export const BROWSER_TOOL = "browser_check";

export const BROWSER_SCRIPTS = ["capture", "drive", "lines"] as const;
export type BrowserScript = (typeof BROWSER_SCRIPTS)[number];

/** where the real Chrome is: `CHROME_PATH`, else the standard macOS install */
export const realChromePath = () =>
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CHECK_TIMEOUT_MS = 6 * 60 * 1000;
const OUTPUT_CHARS = 8000;
/** options whose value is a file the script reads or writes */
const FILE_OPTIONS = new Set(["--out", "--actions", "--preload"]);
/** options that take a value, so it is not mistaken for the page */
const VALUE_OPTIONS = new Set([
  "--out", "--actions", "--preload", "--width", "--height", "--scale", "--wait", "--select",
  "--zoom", "--zoom-scale", "--hover", "--key", "--times", "--theme", "--tolerance",
]);

/** `"`-quoted for a seatbelt profile string */
const sb = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** the seatbelt profile one check runs under; `port` is its Chrome's DevTools port */
export function browserProfile(work: string, secrets: string[], port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad port ${port}`);
  return [
    "(version 1)",
    "(allow default)",
    // network: nothing, except the script talking to its own Chrome on one localhost port
    "(deny network*)",
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    `(allow network-inbound (local ip "localhost:${port}"))`,
    `(allow network-bind (local ip "localhost:${port}"))`,
    `(allow network* (local unix-socket (subpath ${sb(work)})))`,
    `(allow network-outbound (remote unix-socket (subpath ${sb(work)})))`,
    // files: written only inside the job's work folder
    "(deny file-write*)",
    `(allow file-write* (subpath ${sb(work)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/tty"))`,
    // and never read where secrets live
    `(deny file-read* ${secrets.map((path) => `(subpath ${sb(path)})`).join(" ")})`,
  ].join("\n");
}

export type CheckArgs = { script: BrowserScript; args: string[] };
export type Checked = { ok: true; args: string[] } | { ok: false; reason: string };

/** the page and every file option must be a file in `work/`; nothing else is touched */
export function checkBrowserArgs({ script, args }: CheckArgs, work: string): Checked {
  if (!BROWSER_SCRIPTS.includes(script)) return { ok: false, reason: `unknown script ${script}` };
  let page: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    if (flag.startsWith("--")) {
      const value = inline ?? (VALUE_OPTIONS.has(flag) ? args[++i] : null);
      if (FILE_OPTIONS.has(flag)) {
        if (!value) return { ok: false, reason: `${flag} needs a file` };
        if (!isInside(realTarget(value, work), work)) return { ok: false, reason: `${flag} ${value} is outside the job folder` };
      }
      continue;
    }
    if (page === null) {
      page = arg;
      if (/^[a-z][a-z0-9+.-]*:/i.test(arg)) return { ok: false, reason: "pass a file in the job folder, not a URL" };
      const real = realTarget(arg, work);
      if (!isInside(real, work)) return { ok: false, reason: `${arg} is outside the job folder` };
      if (!existsSync(real)) return { ok: false, reason: `${arg} does not exist yet: build the page first` };
    }
    // a further operand: drive.mjs's inline JSON actions
  }
  if (page === null) return { ok: false, reason: "name the page to check, e.g. figure.html" };
  return { ok: true, args };
}

export type CheckResult = { code: number | null; output: string; timedOut: boolean };

export type RunCheck = (input: {
  script: BrowserScript;
  args: string[];
  studio: StudioPaths;
  job: JobPaths;
  secrets: string[];
  signal: AbortSignal;
}) => Promise<CheckResult>;

/** a localhost port nothing is listening on, for one check's DevTools */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** run one check under the seatbelt profile */
export const runCheck: RunCheck = async ({ script, args, studio, job, secrets, signal }) => {
  // a job stopped or discarded meanwhile: don't recreate its folder
  if (signal.aborted || !existsSync(job.work)) return { code: null, output: "aborted", timedOut: false };
  const port = await freePort();
  return new Promise((resolve) => {
    mkdirSync(job.tmp, { recursive: true });
    const work = realTarget(job.work, job.work);
    const scriptPath = join(studio.skill, "scripts", `${script}.mjs`);
    const env: Record<string, string> = {
      PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      HOME: homedir(),
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TMPDIR: job.tmp,
      // Chrome on macOS takes its temp dir (the profile lock socket) from here
      MAC_CHROMIUM_TMPDIR: job.tmp,
      CHROME_PATH: studio.chrome,
      ANATOMY_REAL_CHROME: realChromePath(),
      CHROME_DEBUG_PORT: String(port),
    };
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", browserProfile(work, secrets, port), process.execPath, scriptPath, ...args],
      { cwd: job.work, env: env as unknown as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_CHARS * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, CHECK_TIMEOUT_MS);
    const onAbort = () => killTree();
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const short = output.split(job.work).join(".").slice(-OUTPUT_CHARS);
      resolve({ code, output: short, timedOut });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
};

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

export type BrowserContext = {
  studio: StudioPaths;
  job: JobPaths;
  secrets: string[];
  signal: AbortSignal;
  run?: RunCheck;
  /** for tests: the platform, and whether Chrome is there */
  platform?: NodeJS.Platform;
  chromeAvailable?: () => boolean;
};

/** one browser_check call: checked, run, and answered as tool text */
export async function browserCheck({ script, args }: CheckArgs, context: BrowserContext) {
  const { studio, job, secrets, signal, run = runCheck } = context;
  const platform = context.platform ?? process.platform;
  const chromeAvailable = context.chromeAvailable ?? (() => existsSync(studio.chrome) && existsSync(realChromePath()));
  if (platform !== "darwin")
    return text("Browser checks need macOS (sandbox-exec); skip them and finish the figure.", true);
  if (!chromeAvailable())
    return text("Chrome is not available for browser checks; skip them and finish the figure.", true);
  const checked = checkBrowserArgs({ script, args }, realTarget(job.work, job.work));
  if (!checked.ok) return text(`browser_check refused: ${checked.reason}`, true);
  const result = await run({ script, args: checked.args, studio, job, secrets, signal });
  const head = result.timedOut ? "Timed out after 6 minutes." : `exit ${result.code ?? "killed"}`;
  return text(`${head}\n${result.output.trim()}`, result.code !== 0);
}

export function createBrowserServer(context: BrowserContext) {
  return createSdkMcpServer({
    name: BROWSER_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        BROWSER_TOOL,
        "Run one of the anatomy skill's headless-Chrome scripts (capture.mjs, drive.mjs or lines.mjs) on a page in the job folder. " +
          "`args` are exactly what you would pass after `node scripts/<script>.mjs`, e.g. " +
          '{"script":"capture","args":["figure.html","--out","shots/desk.png"]}. ' +
          "Paths are relative to the job folder; the page and every --out/--actions/--preload file must be inside it. " +
          "Returns the script's output; read the PNGs it writes with the Read tool.",
        {
          script: z.enum(BROWSER_SCRIPTS).describe("capture, drive or lines"),
          args: z.array(z.string()).max(60).describe("the script's arguments, the page first"),
        },
        (input) => browserCheck(input, context),
      ),
    ],
  });
}
