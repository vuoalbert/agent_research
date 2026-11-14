import type { Claim } from "@/lib/crossref";
import type { WorldLabel, WorldRecord, WorldSource } from "@/lib/worlds";

import { buildLabels, shorten } from "./labels";
import { MARBLE_MODEL, MarbleError, defaultMarbleClient, type MarbleClient, type MarbleWorld } from "./marble";
import { fallbackScene, writeSceneWithClaude, type WriteScene } from "./scene";
import { createWorldStore, type WorldStore } from "./store";

/**
 * The world service: at most ONE World Labs world per chat.
 *
 * `startWorld` is synchronous about the one thing that matters — it writes the
 * chat's record (status `generating`) before it returns, so a second call for
 * the same chat, however close behind, finds it and does nothing. The rest
 * runs in the background, on the server, whoever is or isn't watching:
 *
 *   writing     Claude writes the scene prompt and the labels (scene.ts)
 *   submitting  POST worlds:generate (the billed call — sent once, never retried
 *               unless World Labs said 429, which means it was not accepted)
 *   generating  GET operations/{id} every `pollMs` until done → `ready` with
 *               the splat URLs (streamed from the World Labs CDN, never saved)
 *
 * `resume()` (once per server process) picks up every record a restart left
 * `generating`: polling again from its stored operation id, or rewriting its
 * scene if it never got as far as submitting. A record that died *while*
 * submitting is marked failed rather than resubmitted — it may already have
 * been accepted, and a second world would be paid for twice.
 */

export const POLL_MS = 10_000;
/** World Labs says about five minutes; past this the world is called failed */
export const MAX_GENERATING_MS = 45 * 60_000;
/** consecutive transient polling failures before giving up */
export const MAX_POLL_FAILURES = 30;
const MAX_429_RETRIES = 3;

export type StartWorldInput = {
  topic: string;
  answer?: string;
  claims?: readonly Claim[];
  sources?: readonly WorldSource[];
};

export type StartWorldResult =
  | { status: "started"; record: WorldRecord }
  | { status: "exists"; record: WorldRecord }
  | { status: "unavailable"; reason: string };

type Timer = (fn: () => void, ms: number) => unknown;

export function createWorldService({
  store = createWorldStore(),
  client = defaultMarbleClient(),
  writeScene = writeSceneWithClaude,
  now = Date.now,
  pollMs = POLL_MS,
  maxGeneratingMs = MAX_GENERATING_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref?.(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console,
}: {
  store?: WorldStore;
  client?: MarbleClient | null;
  writeScene?: WriteScene;
  now?: () => number;
  pollMs?: number;
  maxGeneratingMs?: number;
  setTimer?: Timer;
  sleep?: (ms: number) => Promise<void>;
  log?: Pick<Console, "info" | "warn">;
} = {}) {
  /** chats with a pipeline or a poll loop running in this process */
  const running = new Set<string>();

  const update = (chatId: string, change: Partial<WorldRecord>) => store.update(chatId, change, now());
  const fail = (chatId: string, error: string) => {
    running.delete(chatId);
    log.warn(`[worlds] ${chatId}: ${error}`);
    return update(chatId, { status: "error", error, phase: undefined });
  };

  async function writeAndSubmit(chatId: string, input: StartWorldInput) {
    if (!client) return fail(chatId, "World Labs is not configured (WORLDLABS_API_KEY)");
    const scene = await writeScene(input).catch((error: unknown) => {
      log.warn(`[worlds] ${chatId}: scene writing failed, using a plain scene:`, error);
      return fallbackScene(input);
    });
    const title = shorten(scene.title, 64);
    const labels = buildLabels({ title, topic: input.topic, drafts: scene.labels, claims: input.claims, sources: input.sources });
    if (!update(chatId, { title, prompt: scene.prompt, labels, phase: "submitting" })) return;

    let operation;
    for (let attempt = 0; ; attempt++) {
      try {
        operation = await client.generate({ prompt: scene.prompt, displayName: title });
        break;
      } catch (error) {
        // a 429 was not accepted: waiting and asking again cannot make two worlds
        if (error instanceof MarbleError && error.status === 429 && attempt < MAX_429_RETRIES) {
          await sleep(20_000 * (attempt + 1));
          continue;
        }
        return fail(chatId, error instanceof Error ? error.message : String(error));
      }
    }
    log.info(`[worlds] ${chatId}: generating "${title}" (operation ${operation.operationId})`);
    update(chatId, {
      operationId: operation.operationId,
      phase: "generating",
      ...(operation.worldId ? { worldId: operation.worldId } : {}),
    });
    poll(chatId, 0);
  }

  async function finishWith(chatId: string, world: MarbleWorld | undefined, worldId: string | undefined) {
    let done = world;
    // the operation's snapshot may be partial; the world itself has every asset
    if ((!done || Object.keys(done.assets.spz).length === 0) && (worldId ?? done?.worldId) && client) {
      done = (await client.getWorld((worldId ?? done?.worldId) as string).catch(() => null)) ?? done;
    }
    if (!done || Object.keys(done.assets.spz).length === 0) return fail(chatId, "World Labs finished without any splat files");
    running.delete(chatId);
    log.info(`[worlds] ${chatId}: ready (${done.worldId})`);
    return update(chatId, {
      status: "ready",
      phase: undefined,
      worldId: done.worldId,
      marbleUrl: done.marbleUrl,
      assets: done.assets,
      progress: undefined,
      readyAt: now(),
    });
  }

  function poll(chatId: string, failures: number) {
    setTimer(() => void tick(chatId, failures), pollMs);
  }

  async function tick(chatId: string, failures: number) {
    const record = store.read(chatId);
    if (!record || record.status !== "generating" || !record.operationId || !client) {
      running.delete(chatId);
      return;
    }
    if (now() - record.createdAt > maxGeneratingMs) return fail(chatId, "World Labs took too long; the world was given up on");
    try {
      const operation = await client.getOperation(record.operationId);
      if (operation.error) return fail(chatId, operation.error);
      if (operation.done) return finishWith(chatId, operation.world, operation.worldId ?? record.worldId);
      update(chatId, {
        ...(operation.progress ? { progress: operation.progress } : {}),
        ...(operation.worldId ? { worldId: operation.worldId } : {}),
      });
      poll(chatId, 0);
    } catch (error) {
      const transient = !(error instanceof MarbleError) || error.transient;
      if (!transient || failures + 1 >= MAX_POLL_FAILURES) {
        return fail(chatId, error instanceof Error ? error.message : String(error));
      }
      poll(chatId, failures + 1);
    }
  }

  return {
    /** the chat's world, if it has one */
    getWorld(chatId: string): WorldRecord | null {
      return store.read(chatId);
    },

    hasWorld(chatId: string): boolean {
      return store.read(chatId) !== null;
    },

    /** start the chat's one world, or do nothing if it has one (any status) */
    startWorld(chatId: string, input: StartWorldInput): StartWorldResult {
      const existing = store.read(chatId);
      if (existing) return { status: "exists", record: existing };
      if (!client) return { status: "unavailable", reason: "World Labs is not configured" };
      const at = now();
      const title = shorten(input.topic, 40) || "Research world";
      const record = store.write({
        chatId,
        status: "generating",
        phase: "writing",
        title,
        topic: input.topic,
        model: MARBLE_MODEL,
        labels: buildLabels({ title, topic: input.topic, claims: input.claims, sources: input.sources }),
        createdAt: at,
        updatedAt: at,
      });
      running.add(chatId);
      void writeAndSubmit(chatId, input).catch((error) => fail(chatId, String(error)));
      return { status: "started", record };
    },

    /** the viewer's label edits (T adds, U undoes) */
    setLabels(chatId: string, labels: WorldLabel[]): WorldRecord | null {
      return update(chatId, { labels });
    },

    /** after a restart: carry on with every world that was mid-way */
    resume() {
      for (const record of store.list()) {
        if (record.status !== "generating" || running.has(record.chatId)) continue;
        if (record.operationId) {
          running.add(record.chatId);
          log.info(`[worlds] ${record.chatId}: resuming operation ${record.operationId}`);
          poll(record.chatId, 0);
        } else if (record.phase === "writing" && client) {
          running.add(record.chatId);
          void writeAndSubmit(record.chatId, { topic: record.topic }).catch((error) => fail(record.chatId, String(error)));
        } else {
          fail(record.chatId, "The server restarted while the world was being submitted; it was not resubmitted");
        }
      }
    },

    /** test-only */
    get running(): ReadonlySet<string> {
      return running;
    },
  };
}

export type WorldService = ReturnType<typeof createWorldService>;

const KEY = Symbol.for("agent_research.worlds.service");
type Holder = { [KEY]?: WorldService | null };

/**
 * The process's one service (kept on globalThis so a dev-server module reload
 * does not start a second poller), resumed on first use. Null when worlds are
 * switched off (WORLDS_DISABLED=1, as in the tests) unless one was injected.
 */
export function getWorldService(): WorldService | null {
  const holder = globalThis as Holder;
  if (holder[KEY] !== undefined) return holder[KEY];
  if (process.env.WORLDS_DISABLED === "1") return null;
  const service = createWorldService();
  holder[KEY] = service;
  service.resume();
  return service;
}
