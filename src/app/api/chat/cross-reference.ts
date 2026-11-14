import { query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { deriveRelations, type Claim, type ClaimSource, type Crossref } from "@/lib/crossref";
import { hostOf, sourceKey } from "@/lib/source-key";
import { telemFetch, type TelemLineage } from "@/server/telem/client";

import type { PageSeen, Source } from "./web-tools";

/**
 * `cross_reference` — checks every source of the chat against every other.
 *
 * The source set is the chat's sources the client sent with the request plus
 * whatever this request's searches and reads turned up, the 20 most recent.
 * Each page's text comes from Telem fetch (cached per page in memory, so a
 * second run over the same pages spends no credits), falling back to the
 * search excerpt. The reads are part of the chat turn's Telem trajectory. One nested, tool-less Claude call reads them all and returns
 * claims with each source's stance and a verbatim quote; the source↔source
 * `agrees` / `conflicts` relations are derived from those in code.
 */

export const CROSSREF_TOOL = "cross_reference";
/** at most this many sources go into one cross-reference */
export const MAX_CROSSREF_SOURCES = 20;
/** how much of each page the analysis reads */
export const CROSSREF_PAGE_CHARS = 4000;
export const MAX_CLAIMS = 25;
export const MAX_QUOTE_CHARS = 200;
/** pages kept in the extracted-text cache */
export const PAGE_CACHE_SIZE = 200;
/** a page shorter than this says too little to be checked */
const MIN_PAGE_CHARS = 80;

export const CROSSREF_MODEL = "claude-opus-5-5";


export type CrossrefActivity =
  | { id: string; name: "Cross-reference"; action: "crossref"; query: string; status: "running" }
  | { id: string; status: "done"; crossref: Crossref }
  | { id: string; status: "error"; message: string };

/** ------------------------------------------------------------ page cache */

type CachedPage = { title: string; text: string };

/** extracted page text by `sourceKey`, least recently used first */
const pageCache = new Map<string, CachedPage>();

function cacheGet(url: string): CachedPage | undefined {
  const key = sourceKey(url);
  const hit = pageCache.get(key);
  if (hit) {
    pageCache.delete(key);
    pageCache.set(key, hit);
  }
  return hit;
}

function cacheSet(url: string, page: CachedPage) {
  const key = sourceKey(url);
  pageCache.delete(key);
  pageCache.set(key, { title: page.title, text: page.text.slice(0, CROSSREF_PAGE_CHARS) });
  while (pageCache.size > PAGE_CACHE_SIZE) {
    pageCache.delete(pageCache.keys().next().value as string);
  }
}

/** test-only */
export function __clearPageCache() {
  pageCache.clear();
}

/** ---------------------------------------------------------- research log */

/**
 * One request's view of the sources: the chat's (oldest first), then each one
 * this request sees, a re-seen page moving to the end. Full page text a read
 * returned goes into the shared cache; search excerpts stay per request.
 *
 * When there are more sources than one cross-reference takes, the pages that
 * were read in full come first: they are the ones a researcher (the chat
 * Claude or one of its subagents) picked as worth reading, and their text is
 * already cached, so they cost no further fetch credits.
 */
export function createResearchLog(chatSources: readonly Source[] = []) {
  const sources = new Map<string, Source>();
  const excerpts = new Map<string, string>();
  /** pages this request read in full, by sourceKey */
  const read = new Set<string>();
  const touch = (source: Source) => {
    const key = sourceKey(source.url);
    const previous = sources.get(key);
    sources.delete(key);
    sources.set(key, { url: source.url, title: source.title || previous?.title || source.url });
  };
  for (const source of chatSources) touch(source);

  return {
    recordPages(pages: readonly PageSeen[]) {
      for (const page of pages) {
        touch({ url: page.url, title: page.title });
        if (page.full && page.text) read.add(sourceKey(page.url));
        if (!page.text) continue;
        if (page.full) cacheSet(page.url, { title: page.title, text: page.text });
        else if (!excerpts.has(sourceKey(page.url))) excerpts.set(sourceKey(page.url), page.text);
      }
    },
    /** up to `limit` sources — the most recently read in full, then the most recently seen — oldest first */
    recent(limit = MAX_CROSSREF_SOURCES): Source[] {
      const keys = [...sources.keys()];
      const full = keys.filter((key) => read.has(key)).slice(-limit);
      const rest = keys.filter((key) => !read.has(key));
      const chosen = new Set([...full, ...(full.length < limit ? rest.slice(-(limit - full.length)) : [])]);
      return keys.filter((key) => chosen.has(key)).map((key) => sources.get(key)!);
    },
    excerpt(url: string): string | undefined {
      return excerpts.get(sourceKey(url));
    },
  };
}

export type ResearchLog = ReturnType<typeof createResearchLog>;

/** -------------------------------------------------------------- analysis */

export type LabelledPage = { label: string; url: string; title: string; text: string };

const stance = z.enum(["supports", "contradicts", "mentions"]);

/** what the nested call returns: sources named by their `S` label */
export const AnalysisSchema = z.object({
  claims: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        sources: z.array(z.object({ source: z.string(), stance, quote: z.string() })),
      }),
    ),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export type Analyse = (topic: string, pages: LabelledPage[], signal?: AbortSignal) => Promise<Analysis>;

const ANALYST_PROMPT = [
  "You cross-reference web sources against each other. You get a topic and a set of pages, each labelled S1, S2, ….",
  "List the factual claims (numbers, dates, names, events) the pages make about the topic, and for each claim every page's stance:",
  '- "supports": the page states the claim (or an equivalent figure),',
  '- "contradicts": the page states something incompatible (a different number for the same thing at the same time, an opposite fact),',
  '- "mentions": the page touches the claim without confirming or denying it.',
  "Rules:",
  "- Normalise equivalent claims into one (\"300M copies sold\" and \"over 300 million sales\" are one claim). Word each claim as one short neutral sentence.",
  "- A newer figure is not a contradiction of an older dated figure unless the page presents it as the current value at the same time; when two pages give different current values for the same thing, that is a contradiction.",
  "- Keep only claims that at least two pages address, or that any page contradicts.",
  `- Each quote is copied verbatim from that page, short (at most ${MAX_QUOTE_CHARS} characters).`,
  `- At most ${MAX_CLAIMS} claims, most important first. Claim ids C1, C2, ….`,
  "- Refer to pages only by their label (S1, S2, …).",
].join("\n");

function analysisPrompt(topic: string, pages: LabelledPage[]): string {
  const body = pages
    .map((page) => `[${page.label}] ${page.title}\nURL: ${page.url}\n${page.text}`)
    .join("\n\n---\n\n");
  return `Topic: ${topic}\n\n${body}`;
}

/**
 * The analysis schema as plain JSON Schema for `--json-schema`. Draft-07 and no
 * `$schema` key: the CLI's validator rejects zod 4's default draft-2020-12 URI.
 */
export function analysisJsonSchema(): Record<string, unknown> {
  const { $schema: _uri, ...schema } = z.toJSONSchema(AnalysisSchema, { target: "draft-7" }) as Record<string, unknown>;
  return schema;
}

/** the default analyser: one structured, tool-less Claude call */
export const analyseWithClaude: Analyse = async (topic, pages, signal) => {
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort());
  const run = query({
    prompt: analysisPrompt(topic, pages),
    options: {
      model: CROSSREF_MODEL,
      effort: "medium",
      systemPrompt: ANALYST_PROMPT,
      tools: [],
      settingSources: [],
      permissionMode: "dontAsk",
      outputFormat: { type: "json_schema", schema: analysisJsonSchema() },
      maxTurns: 4,
      abortController,
    },
  });
  for await (const message of run) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(`cross-reference analysis stopped: ${message.subtype}`);
    const raw =
      message.structured_output ??
      JSON.parse(/\{[\s\S]*\}/.exec(message.result ?? "")?.[0] ?? "null");
    return AnalysisSchema.parse(raw);
  }
  throw new Error("cross-reference analysis returned no result");
};

/**
 * The analysis in URLs instead of labels: unknown labels dropped, one stance
 * per page, quotes cut to 200 chars, only claims two pages address (or one
 * contradicts), at most 25, re-numbered C1….
 */
export function toCrossref(analysis: Analysis, pages: readonly LabelledPage[]): Crossref {
  const byLabel = new Map(pages.map((page) => [page.label.toUpperCase(), page]));
  const claims: Claim[] = [];
  for (const raw of analysis.claims) {
    const text = raw.text.trim();
    if (!text) continue;
    const seen = new Set<string>();
    const sources: ClaimSource[] = [];
    for (const entry of raw.sources) {
      const page = byLabel.get(entry.source.trim().replace(/^\[|\]$/g, "").toUpperCase());
      if (!page) continue;
      const key = sourceKey(page.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const quote = entry.quote.trim();
      sources.push({
        url: page.url,
        stance: entry.stance,
        quote: quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS - 1)}…` : quote,
      });
    }
    const addressed = sources.length >= 2;
    const contradicted = sources.some((source) => source.stance === "contradicts");
    if (!addressed && !contradicted) continue;
    claims.push({ id: `C${claims.length + 1}`, text, sources });
    if (claims.length === MAX_CLAIMS) break;
  }
  return { claims, relations: deriveRelations(claims) };
}

/** host labels for the table, `host (2)` where two pages share a host */
function labelsFor(urls: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const used = new Map<string, number>();
  for (const url of urls) {
    const key = sourceKey(url);
    if (labels.has(key)) continue;
    const host = hostOf(url);
    const n = (used.get(host) ?? 0) + 1;
    used.set(host, n);
    labels.set(key, n === 1 ? host : `${host} (${n})`);
  }
  return labels;
}

/** what goes back to Claude: claim → ✓ / ✗ / ~ hosts with quotes, then the conflicts */
export function formatCrossref(topic: string, crossref: Crossref, pages: readonly LabelledPage[]): string {
  const labels = labelsFor(pages.map((page) => page.url));
  const label = (url: string) => labels.get(sourceKey(url)) ?? hostOf(url);
  if (crossref.claims.length === 0) {
    return `Cross-reference on "${topic}": no claim was addressed by two or more sources.`;
  }
  const lines = [`Cross-reference on "${topic}"`, "", "Sources:"];
  for (const page of pages) lines.push(`- ${label(page.url)}: ${page.title} — ${page.url}`);
  lines.push("", "Claims (✓ supports, ✗ contradicts, ~ mentions):");
  const marks = { supports: "✓", contradicts: "✗", mentions: "~" } as const;
  for (const claim of crossref.claims) {
    lines.push(`${claim.id}. ${claim.text}`);
    for (const kind of ["supports", "contradicts", "mentions"] as const) {
      const of = claim.sources.filter((source) => source.stance === kind);
      if (of.length === 0) continue;
      lines.push(`   ${marks[kind]} ${of.map((s) => `${label(s.url)} ("${s.quote}")`).join("; ")}`);
    }
  }
  const conflicts = crossref.relations.filter((relation) => relation.kind === "conflicts");
  lines.push("", conflicts.length ? "Conflicts:" : "Conflicts: none — the sources agree on every shared claim.");
  for (const relation of conflicts) {
    lines.push(`- ${label(relation.a)} vs ${label(relation.b)} on ${relation.claims.join(", ")}`);
  }
  return lines.join("\n");
}

/** ------------------------------------------------------------------ tool */

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

/** fetch page text for the sources: cache, then Telem fetch (5 URLs a call, in parallel), then excerpts */
async function pageTexts(
  sources: readonly Source[],
  log: ResearchLog,
  { lineage, signal }: { lineage?: TelemLineage; signal?: AbortSignal } = {},
): Promise<LabelledPage[]> {
  const missing = sources.filter((source) => !cacheGet(source.url));
  if (missing.length > 0) {
    try {
      const { pages: read, failed } = await telemFetch(
        missing.slice(0, MAX_CROSSREF_SOURCES).map((source) => source.url),
        { lineage, caller: "crossref", goal: "Cross-reference the sources' claims", signal },
      );
      for (const page of read) cacheSet(page.url, { title: page.title || page.url, text: page.text });
      console.info(
        `[cross_reference] fetched ${read.length} of ${missing.length} uncached pages via Telem ` +
          `(${failed.length} failed, ${sources.length - missing.length} cached)`,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("[cross_reference] fetch failed; falling back to excerpts:", error);
    }
  }

  const pages: LabelledPage[] = [];
  for (const source of sources) {
    const cached = cacheGet(source.url);
    const body = cached?.text ?? log.excerpt(source.url) ?? "";
    if (body.trim().length < MIN_PAGE_CHARS) continue;
    pages.push({
      label: `S${pages.length + 1}`,
      url: source.url,
      title: source.title || cached?.title || source.url,
      text: body.slice(0, CROSSREF_PAGE_CHARS),
    });
  }
  return pages;
}

export function createCrossReferenceTool({
  log,
  onActivity,
  signal,
  lineage,
  analyse = analyseWithClaude,
}: {
  log: ResearchLog;
  onActivity: (activity: CrossrefActivity) => void;
  signal?: AbortSignal;
  /** the chat turn's Telem lineage, for the page reads */
  lineage?: TelemLineage;
  analyse?: Analyse;
}) {
  return tool(
    CROSSREF_TOOL,
    "Cross-reference all of the chat's sources against each other: every page found or read so far " +
      "(including earlier turns) is checked for which claims it supports or contradicts. Returns a table of " +
      "claims with ✓/✗ sources and quotes, and the conflicts between sources. Call it once, after searching " +
      "and reading, before writing the answer.",
    { topic: z.string().min(1).describe("What the sources should be checked on, e.g. the user's question") },
    async ({ topic }) => {
      const id = crypto.randomUUID();
      onActivity({ id, name: "Cross-reference", action: "crossref", query: topic, status: "running" });
      const fail = (message: string) => {
        console.warn(`[cross_reference] ${message}`);
        onActivity({ id, status: "error", message });
        return text(message, true);
      };

      try {
        const sources = log.recent(MAX_CROSSREF_SOURCES);
        if (sources.length < 2) return fail("Cross-referencing needs at least two sources: search or read first.");
        const pages = await pageTexts(sources, log, { lineage, signal });
        if (pages.length < 2) return fail("Fewer than two sources had readable text to cross-reference.");

        const crossref = toCrossref(await analyse(topic, pages, signal), pages);
        onActivity({ id, status: "done", crossref });
        return text(formatCrossref(topic, crossref, pages));
      } catch (error) {
        return fail(`Cross-reference failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
