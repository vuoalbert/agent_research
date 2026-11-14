import type { Source } from "./tavily";

/** the most chat sources one request may carry */
export const MAX_BODY_SOURCES = 60;

/**
 * The POST body's `sources`: absent → none; otherwise an array of at most 60
 * `{ title, url }` with http(s) URLs. Anything else is `null` (a 400), so a
 * malformed client is caught rather than silently cross-referencing nothing.
 */
export function parseSources(value: unknown): Source[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BODY_SOURCES) return null;
  const sources: Source[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { title, url } = entry as Record<string, unknown>;
    if (typeof url !== "string") return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    sources.push({ url, title: typeof title === "string" && title.trim() ? title : url });
  }
  return sources;
}
