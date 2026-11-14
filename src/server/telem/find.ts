import { sourceKey } from "@/lib/source-key";

import { createLineage, telemSearch, type TelemSearchResult } from "./client";

/**
 * findMore — a Telem search for sources a chat does not have yet: the graph
 * chat's "find more like this" and the Knowledge base's "Find more". Results
 * the chat already holds (by `sourceKey`) are dropped, the rest kept in
 * Telem's order (agreement across providers, then rank), at most `limit`. A
 * `chatId` files the search under that chat's Telem session; `caller` names
 * the surface that asked.
 */

export const MAX_FOUND = 6;
export const MAX_QUERY = 300;

export type Found = { query: string; sources: TelemSearchResult[] };

export async function findMore(
  query: string,
  {
    known = [],
    isKnown,
    chatId,
    caller = "find-more",
    limit = MAX_FOUND,
    signal,
  }: {
    known?: readonly string[];
    /** another test for "already have it" (the graph knows its pages by node id) */
    isKnown?: (url: string) => boolean;
    chatId?: string;
    caller?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Found> {
  const clean = query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
  if (!clean) return { query: clean, sources: [] };
  const have = new Set(known.map(sourceKey));
  const { results } = await telemSearch(clean, {
    lineage: createLineage({ chatId, question: clean }),
    caller,
    goal: "Find more sources for the user's research",
    maxResults: 20,
    ...(signal ? { signal } : {}),
  });
  const sources: TelemSearchResult[] = [];
  for (const result of results) {
    const key = sourceKey(result.url);
    if (have.has(key) || isKnown?.(result.url)) continue;
    have.add(key);
    sources.push(result);
    if (sources.length >= limit) break;
  }
  return { query: clean, sources };
}
