/**
 * World Labs worlds — shared by the server (src/server/worlds/) and the World
 * Labs tab (src/components/worlds/). Every chat gets at most ONE Marble world,
 * generated in the background after the chat's first research turn, with
 * floating labels for the research's key claims and facts.
 */

export type WorldStatus = "generating" | "ready" | "error";

/**
 * Where a world that is still `generating` has got to:
 *   writing     Claude is writing the scene prompt and the labels
 *   submitting  the generate request is in flight (never retried on restart:
 *               it may already have been accepted, and a world costs money)
 *   generating  World Labs accepted it; the operation is being polled
 */
export type WorldPhase = "writing" | "submitting" | "generating";

export type WorldSource = { title: string; url: string };

/** a floating label: a fact from the research, and the topic its six screens are about */
export type WorldLabel = {
  id: string;
  text: string;
  /** what its screens search for (Wikipedia + OpenAlex) */
  query: string;
  /** the research's own sources for it, shown first on its screens */
  sources: WorldSource[];
  /** [x, y, z] from the starting viewpoint: -z ahead, +x right, +y up (≈ metres) */
  position: [number, number, number];
  size: number;
  color: string;
};

export type WorldAssets = {
  /** splat files by resolution as World Labs names them: "100k", "500k", "full_res" */
  spz: Record<string, string>;
  panoramaUrl?: string;
  thumbnailUrl?: string;
  colliderMeshUrl?: string;
  caption?: string;
  /** World Labs' metric alignment for the splats, when it reports one */
  metricScaleFactor?: number;
  groundPlaneOffset?: number;
};

export type WorldRecord = {
  chatId: string;
  status: WorldStatus;
  phase?: WorldPhase;
  /** the scene's short name */
  title: string;
  /** what the research was about (the chat's first research question) */
  topic: string;
  /** the text prompt sent to World Labs */
  prompt?: string;
  model: string;
  operationId?: string;
  worldId?: string;
  marbleUrl?: string;
  assets?: WorldAssets;
  labels: WorldLabel[];
  /** World Labs' own progress line while it builds */
  progress?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  readyAt?: number;
};

export const WORLD_TOOL_NAME = "World Labs";

export const worldEndpoint = (chatId: string) => `/api/world/chat/${encodeURIComponent(chatId)}`;
export const worldLabelsEndpoint = (chatId: string) => `${worldEndpoint(chatId)}/labels`;
export const WORLD_PAGE_ENDPOINT = "/api/world/page";
export const WORLD_ASK_ENDPOINT = "/api/world/ask";

/** how often the tab and the tool row ask after a world that is still generating */
export const WORLD_POLL_MS = 4000;

/** the splat the viewer streams by default (~500k splats), and the full one */
export function splatUrl(assets: WorldAssets | undefined, quality: "default" | "full" = "default"): string | null {
  const spz = assets?.spz ?? {};
  if (quality === "full" && spz.full_res) return spz.full_res;
  return spz["500k"] ?? spz.full_res ?? spz["100k"] ?? Object.values(spz)[0] ?? null;
}

export const MAX_LABELS = 40;

const isHttp = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const finite = (n: unknown, limit: number) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit;

/** shape-check labels from a client (the viewer's T/U edits); null when malformed */
export function parseLabels(value: unknown): WorldLabel[] | null {
  if (!Array.isArray(value) || value.length > MAX_LABELS) return null;
  const labels: WorldLabel[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return null;
    const label = raw as Record<string, unknown>;
    const text = typeof label.text === "string" ? label.text.trim().slice(0, 80) : "";
    if (!text) return null;
    const position = label.position;
    if (!Array.isArray(position) || position.length !== 3 || !position.every((n) => finite(n, 500))) return null;
    const sources = Array.isArray(label.sources)
      ? label.sources
          .filter((s): s is { title?: unknown; url: string } => !!s && typeof s === "object" && isHttp((s as { url?: unknown }).url))
          .slice(0, 8)
          .map((s) => ({ url: s.url, title: typeof s.title === "string" && s.title.trim() ? s.title.slice(0, 200) : s.url }))
      : [];
    labels.push({
      id: typeof label.id === "string" && label.id.length <= 80 ? label.id : `label-${index + 1}`,
      text,
      query: typeof label.query === "string" && label.query.trim() ? label.query.trim().slice(0, 200) : text,
      sources,
      position: position as [number, number, number],
      size: finite(label.size, 4) && (label.size as number) >= 0.2 ? (label.size as number) : 1,
      color: typeof label.color === "string" && /^#[0-9a-f]{3,8}$/i.test(label.color) ? label.color : "#ffffff",
    });
  }
  return labels;
}
