import type { WorldAssets } from "@/lib/worlds";

/**
 * The World Labs Marble API (https://docs.worldlabs.ai/api), as much of it as
 * a per-chat world needs:
 *
 *   POST /marble/v1/worlds:generate        → an operation  (BILLED: ~1,580–3,080 credits)
 *   GET  /marble/v1/operations/{id}        → the operation (polling is free)
 *   GET  /marble/v1/worlds/{id}            → the world     (a read; only a fallback)
 *
 * Auth is the `WLT-Api-Key` header. An operation is
 *   { operation_id, done, error: {code, message} | null,
 *     metadata: { progress: {status, description}, world_id } | null,
 *     response: World | null, … }
 * and once `done` without an error its `response` is the world:
 *   { id | world_id, world_marble_url,
 *     assets: { caption, thumbnail_url,
 *               splats: { spz_urls: {"100k","500k","full_res"}, semantics_metadata },
 *               mesh: { collider_mesh_url }, imagery: { pano_url } } }
 *
 * `createMockMarbleClient` stands in for all of it (WORLDLABS_MOCK=1, and the
 * tests): nothing is generated and nothing is spent.
 */

export const MARBLE_BASE = "https://api.worldlabs.ai";
export const MARBLE_MODEL = "marble-1.1-plus";

export type MarbleWorld = { worldId: string; marbleUrl: string; assets: WorldAssets };

export type MarbleOperation = {
  operationId: string;
  done: boolean;
  error?: string;
  /** World Labs' own words for where it is */
  progress?: string;
  /** known from the first poll on, before the world is done */
  worldId?: string;
  world?: MarbleWorld;
};

export type GenerateInput = { prompt: string; displayName: string };

export interface MarbleClient {
  generate(input: GenerateInput): Promise<MarbleOperation>;
  getOperation(operationId: string): Promise<MarbleOperation>;
  getWorld(worldId: string): Promise<MarbleWorld | null>;
}

/** an HTTP failure; `transient` ones (network, 429, 5xx) are worth polling again */
export class MarbleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly transient = false,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** a World object — the operation's snapshot or GET world's (bare or wrapped in `world`) */
export function parseWorld(value: unknown, fallbackId?: string): MarbleWorld | null {
  const body = obj(value);
  const world = obj(body?.world) ?? body;
  if (!world) return null;
  const worldId = str(world.world_id) ?? str(world.id) ?? fallbackId;
  if (!worldId) return null;
  const assets = obj(world.assets);
  const splats = obj(assets?.splats);
  const spz: Record<string, string> = {};
  for (const [key, url] of Object.entries(obj(splats?.spz_urls) ?? {})) {
    if (typeof url === "string" && /^https?:\/\//.test(url)) spz[key] = url;
  }
  const semantics = obj(splats?.semantics_metadata);
  return {
    worldId,
    marbleUrl: str(world.world_marble_url) ?? `https://marble.worldlabs.ai/world/${worldId}`,
    assets: {
      spz,
      ...(str(obj(assets?.imagery)?.pano_url) ? { panoramaUrl: str(obj(assets?.imagery)?.pano_url) } : {}),
      ...(str(assets?.thumbnail_url) ? { thumbnailUrl: str(assets?.thumbnail_url) } : {}),
      ...(str(obj(assets?.mesh)?.collider_mesh_url) ? { colliderMeshUrl: str(obj(assets?.mesh)?.collider_mesh_url) } : {}),
      ...(str(assets?.caption) ? { caption: str(assets?.caption) } : {}),
      ...(num(semantics?.metric_scale_factor) !== undefined ? { metricScaleFactor: num(semantics?.metric_scale_factor) } : {}),
      ...(num(semantics?.ground_plane_offset) !== undefined ? { groundPlaneOffset: num(semantics?.ground_plane_offset) } : {}),
    },
  };
}

export function parseOperation(value: unknown): MarbleOperation {
  const body = obj(value);
  const operationId = str(body?.operation_id);
  if (!body || !operationId) throw new MarbleError("World Labs answered without an operation id");
  const metadata = obj(body.metadata);
  const progress = obj(metadata?.progress);
  const error = obj(body.error);
  const worldId = str(metadata?.world_id) ?? str(obj(body.response)?.world_id) ?? str(obj(body.response)?.id);
  const done = body.done === true;
  const failed = error ? str(error.message) ?? `World Labs error ${num(error.code) ?? ""}`.trim() : undefined;
  return {
    operationId,
    done,
    ...(failed ? { error: failed } : {}),
    ...(str(progress?.description) ? { progress: str(progress?.description) } : {}),
    ...(worldId ? { worldId } : {}),
    ...(done && !failed && body.response ? { world: parseWorld(body.response, worldId) ?? undefined } : {}),
  };
}

const detail = async (response: Response) => {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown };
    const d = body.detail ?? body.message;
    return typeof d === "string" ? d : Array.isArray(d) ? JSON.stringify(d).slice(0, 300) : "";
  } catch {
    return "";
  }
};

export function createMarbleClient({
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  base = MARBLE_BASE,
  model = MARBLE_MODEL,
}: {
  apiKey: string;
  fetch?: typeof fetch;
  base?: string;
  model?: string;
}): MarbleClient {
  async function call(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { "WLT-Api-Key": apiKey, "content-type": "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new MarbleError(`World Labs could not be reached: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
    }
    if (!response.ok) {
      const why = await detail(response);
      const transient = response.status === 429 || response.status >= 500;
      throw new MarbleError(`World Labs answered ${response.status}${why ? `: ${why}` : ""}`, response.status, transient);
    }
    return response.json();
  }

  return {
    async generate({ prompt, displayName }) {
      const body = {
        display_name: displayName.slice(0, 64),
        model,
        world_prompt: { type: "text", text_prompt: prompt },
        tags: ["agent-research"],
      };
      return parseOperation(await call("/marble/v1/worlds:generate", { method: "POST", body: JSON.stringify(body) }));
    },
    async getOperation(operationId) {
      return parseOperation(await call(`/marble/v1/operations/${encodeURIComponent(operationId)}`));
    },
    async getWorld(worldId) {
      return parseWorld(await call(`/marble/v1/worlds/${encodeURIComponent(worldId)}`), worldId);
    },
  };
}

/**
 * A stand-in World Labs: `generate` hands out an operation that is "done"
 * `readyAfterMs` later, with the splat at `spzUrl`. For WORLDLABS_MOCK=1 (a
 * local walk-through of the whole pipeline at no cost) and the tests.
 */
export function createMockMarbleClient({
  spzUrl = process.env.WORLDLABS_MOCK_SPZ_URL ?? "/dev-worlds/world_500k.spz",
  readyAfterMs = Number(process.env.WORLDLABS_MOCK_READY_MS ?? 20_000),
  now = Date.now,
}: { spzUrl?: string; readyAfterMs?: number; now?: () => number } = {}): MarbleClient {
  const started = new Map<string, number>();
  let n = 0;
  const op = (operationId: string): MarbleOperation => {
    const at = started.get(operationId) ?? Number(operationId.split("-").pop());
    const worldId = `mock-world-${operationId.split("-")[2] ?? "0"}`;
    if (!Number.isFinite(at)) return { operationId, done: true, error: "unknown mock operation" };
    if (now() - at < readyAfterMs) return { operationId, done: false, progress: "World generation in progress", worldId };
    return {
      operationId,
      done: true,
      worldId,
      world: { worldId, marbleUrl: `https://marble.worldlabs.ai/world/${worldId}`, assets: { spz: { "500k": spzUrl } } },
    };
  };
  return {
    async generate() {
      n += 1;
      const at = now();
      // the start time rides in the id, so a restarted server can still answer
      const operationId = `mock-op-${n}-${at}`;
      started.set(operationId, at);
      return { operationId, done: false };
    },
    async getOperation(operationId) {
      return op(operationId);
    },
    async getWorld() {
      return null;
    },
  };
}

/**
 * The client the app uses: the mock under WORLDLABS_MOCK=1, the real API when
 * WORLDLABS_API_KEY is set, otherwise none (no world is started).
 */
export function defaultMarbleClient(): MarbleClient | null {
  if (process.env.WORLDLABS_MOCK === "1") return createMockMarbleClient();
  // never a real, billed call from a test run
  if (process.env.VITEST) return null;
  const apiKey = process.env.WORLDLABS_API_KEY;
  return apiKey ? createMarbleClient({ apiKey }) : null;
}
