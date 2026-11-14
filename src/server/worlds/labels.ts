import type { Claim } from "@/lib/crossref";
import { hostOf, sourceKey } from "@/lib/source-key";
import type { WorldLabel, WorldSource } from "@/lib/worlds";

/**
 * A world's floating labels, from its research: the scene's title first, then
 * the key claims and facts (up to 8 labels in all), each with the topic its
 * six screens search for and the research's own sources for it.
 *
 * The scene's geometry is unknown until it is walked, so labels are placed
 * automatically: the title straight ahead and high, the rest on a gentle arc
 * in front of the starting view at varied heights and distances. Coordinates
 * follow the viewer: -z ahead, +x right, +y up, roughly metres.
 */

export const MAX_WORLD_LABELS = 8;
/** a label is a line of floating text, not a paragraph */
export const LABEL_CHARS = 44;

export type LabelDraft = { text: string; query: string; claim?: number };

const COLORS = ["#ffd84a", "#ff8a8a", "#9fd4ff", "#a8f0c6", "#ffb86b", "#d7b8ff", "#7df9ff"];
const HEIGHTS = [2.3, 0.9, 1.7, 0.5, 2.6, 1.2, 1.9];
const RADII = [7, 8.5, 6.5, 8, 7.5, 9, 6.8];

export function shorten(text: string, max = LABEL_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[.;:,]+$/, "");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** n positions on an arc in front of the start view, left to right */
export function arcPositions(n: number): [number, number, number][] {
  if (n <= 0) return [];
  const spread = Math.min(130, 30 + n * 16); // degrees across, wider for more labels
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const angle = ((t - 0.5) * spread * Math.PI) / 180;
    const r = RADII[i % RADII.length];
    const round = (v: number) => Math.round(v * 100) / 100;
    return [round(r * Math.sin(angle)), HEIGHTS[i % HEIGHTS.length], round(-r * Math.cos(angle))];
  });
}

/** a claim's supporting sources first, titled from the chat's sources where known */
function claimSources(claim: Claim | undefined, titles: Map<string, string>): WorldSource[] {
  if (!claim) return [];
  const order = [...claim.sources].sort((a, b) => Number(b.stance === "supports") - Number(a.stance === "supports"));
  const seen = new Set<string>();
  const out: WorldSource[] = [];
  for (const source of order) {
    const key = sourceKey(source.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: source.url, title: titles.get(key) ?? hostOf(source.url) });
  }
  return out.slice(0, 4);
}

/** a fallback search topic for a claim: its words, minus the numbers and the filler */
export function queryFrom(text: string, topic: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^\d/.test(w))
    .slice(0, 5)
    .join(" ");
  return words || shorten(topic, 80);
}

export function buildLabels({
  title,
  topic,
  drafts = [],
  claims = [],
  sources = [],
}: {
  title: string;
  topic: string;
  /** Claude's labels (scene.ts); without them the claims are used as they are */
  drafts?: LabelDraft[];
  claims?: readonly Claim[];
  sources?: readonly WorldSource[];
}): WorldLabel[] {
  const titles = new Map(sources.map((s) => [sourceKey(s.url), s.title]));
  const rest: Omit<WorldLabel, "id" | "position" | "size" | "color">[] = [];
  const used = new Set<string>();
  const push = (text: string, query: string, from: WorldSource[]) => {
    const short = shorten(text);
    const key = short.toLowerCase();
    if (!short || used.has(key) || rest.length >= MAX_WORLD_LABELS - 1) return;
    used.add(key);
    rest.push({ text: short, query: shorten(query, 120), sources: from });
  };

  for (const draft of drafts) {
    const claim = typeof draft.claim === "number" ? claims[draft.claim - 1] : undefined;
    push(draft.text, draft.query || queryFrom(draft.text, topic), claimSources(claim, titles));
  }
  // no drafts (Claude unavailable): the claims the most sources speak to, then the sources themselves
  if (rest.length === 0) {
    const ranked = [...claims].sort((a, b) => b.sources.length - a.sources.length);
    for (const claim of ranked) push(claim.text, queryFrom(claim.text, topic), claimSources(claim, titles));
    for (const source of sources) {
      if (rest.length >= 4) break;
      push(source.title, source.title, [source]);
    }
  }

  const positions = arcPositions(rest.length);
  return [
    {
      id: "label-1",
      text: shorten(title, 40),
      query: shorten(topic, 120),
      sources: sources.slice(0, 3).map((s) => ({ title: s.title, url: s.url })),
      position: [0, 3.2, -9],
      size: 2,
      color: "#ffffff",
    },
    ...rest.map((label, i) => ({
      ...label,
      id: `label-${i + 2}`,
      position: positions[i],
      size: i < 2 ? 1.4 : 1.2,
      color: COLORS[i % COLORS.length],
    })),
  ];
}
