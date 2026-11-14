/**
 * The brief a research turn's figure is built from, when the chat queues it
 * itself (Claude did not call visualize). It hands the anatomy agent the
 * turn's FACTS in a fixed structure rather than the prose answer:
 *
 *   Key numbers:          value unit (date) — source host: the claim
 *   Parts and relations:  each cross-referenced claim and which sources back or contradict it
 *   Conflicts:            source vs source on which claim
 *   Sources:              the hosts the turn searched and read
 *   Object idea:          one line on a physical object that could encode it
 *
 * Built deterministically from what the turn's tools returned (search and
 * read results, the cross_reference table) and the answer's own sentences.
 */

export type ResearchMaterial = {
  question: string;
  answer: string;
  /** text results of tavily_search / tavily_extract */
  pages: string[];
  /** text results of cross_reference */
  crossrefs: string[];
};

const MAX_BRIEF = 2000;
const MAX_NUMBERS = 8;
const MAX_CLAIMS = 6;

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

const URL_RE = /https?:\/\/[^\s)"'<>\]]+/g;
const hostsIn = (text: string) =>
  [...new Set((text.match(URL_RE) ?? []).map(host).filter((h): h is string => !!h))];

const UNIT =
  "%|percent|per cent|million|billion|trillion|thousand|bn|kWh|MWh|GWh|TWh|kW|MW|GW|km/h|mph|km|cm|mm|kg|tonnes?|tons?|miles?|°C|°F|years?|months?|days?|hours?|people|users|units|copies|cars|vehicles|times|x";
/** a number standing on its own (not the 700 in "N700S"), with the unit after it */
const QUANTITY = new RegExp(
  `(?<![\\w.,])((?:[$€£¥]\\s?)?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|(?:[$€£¥]\\s?)?\\d+(?:\\.\\d+)?)(?![\\w])(?:\\s?(${UNIT})(?![a-z]))?|(?<![\\w.,])((?:[$€£¥]\\s?)?\\d+(?:\\.\\d+)?)(${UNIT})(?![a-z])`,
  "i",
);
const DATE = /\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\b/;
const YEAR_ONLY = /^(?:19|20)\d{2}$/;

/** the first quantity in a sentence that is not just a year, and the date beside it */
export function quantityOf(sentence: string): { value: string; unit?: string; date?: string } | null {
  const text = sentence.replace(DATE, (match) => " ".repeat(match.length));
  const found = QUANTITY.exec(text);
  if (!found) return null;
  // either "285 km/h" / "88.9%" (number, then unit) or "285km/h" (unit attached)
  const value = found[1] ?? found[3];
  const unit = found[1] ? found[2] : found[4];
  if (!unit && YEAR_ONLY.test(value)) return null;
  const date = DATE.exec(sentence)?.[0];
  return { value: value.trim(), ...(unit ? { unit } : {}), ...(date ? { date } : {}) };
}

type Claim = { id: string; text: string; supports: string[]; contradicts: string[] };

/** cross_reference's table back into claims and conflicts (see formatCrossref) */
export function parseCrossref(text: string): { claims: Claim[]; conflicts: string[] } {
  const claims: Claim[] = [];
  const conflicts: string[] = [];
  let inConflicts = false;
  const hostsOf = (line: string) =>
    line
      .replace(/^\s*[✓✗~]\s*/, "")
      .split(/;\s*/)
      .map((part) => part.replace(/\s*\(".*$/, "").trim())
      .filter(Boolean);
  for (const line of text.split("\n")) {
    const claim = /^(C\d+)\.\s+(.+)$/.exec(line.trim());
    if (claim) {
      claims.push({ id: claim[1], text: claim[2], supports: [], contradicts: [] });
      continue;
    }
    if (/^Conflicts:/.test(line)) {
      inConflicts = true;
      continue;
    }
    const last = claims[claims.length - 1];
    if (!inConflicts && last && /^\s*✓/.test(line)) last.supports.push(...hostsOf(line));
    else if (!inConflicts && last && /^\s*✗/.test(line)) last.contradicts.push(...hostsOf(line));
    else if (inConflicts && /^\s*-\s+/.test(line)) conflicts.push(line.replace(/^\s*-\s+/, "").trim());
  }
  return { claims, conflicts };
}

const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 12);

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** a sentence without its markdown links' URLs, so a host is not read as a number */
const plain = (sentence: string) => sentence.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1").replace(URL_RE, "");

function objectIdea(numbers: { date?: string }[], conflicts: number): string {
  const years = new Set(numbers.map((n) => n.date).filter(Boolean));
  if (years.size >= 3) return "a chart recorder: a pen tracing each figure on a dated paper roll, one notch per year";
  if (conflicts > 0) return "a balance scale: each source's figure as a weight, the beam tipping where they disagree";
  if (numbers.length >= 2) return "a bank of gauges, one dial per key number, side by side for comparison";
  if (numbers.length === 1) return "a single dial gauge whose needle reads the key figure";
  return "a cutaway machine whose parts stand for the main entities and how they drive each other";
}

export function researchBrief({ question, answer, pages, crossrefs }: ResearchMaterial): string {
  const { claims, conflicts } = crossrefs
    .map(parseCrossref)
    .reduce((all, next) => ({ claims: [...all.claims, ...next.claims], conflicts: [...all.conflicts, ...next.conflicts] }), {
      claims: [] as Claim[],
      conflicts: [] as string[],
    });

  // numbers: the cross-referenced claims first (they name their sources), then the answer
  const numbers: { value: string; unit?: string; date?: string; source: string; claim: string }[] = [];
  const seen = new Set<string>();
  const add = (sentence: string, sources: string[]) => {
    if (numbers.length >= MAX_NUMBERS) return;
    const quantity = quantityOf(plain(sentence));
    if (!quantity) return;
    const key = `${quantity.value} ${quantity.unit ?? ""}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    numbers.push({ ...quantity, source: sources.join(", ") || "unattributed", claim: cut(plain(sentence), 140) });
  };
  for (const claim of claims) add(claim.text, claim.supports);
  for (const sentence of sentencesOf(answer)) add(sentence, hostsIn(sentence));

  const conflictLines = conflicts.length
    ? conflicts.map((line) =>
        line.replace(/\b(C\d+)\b/g, (id) => {
          const claim = claims.find((c) => c.id === id);
          return claim ? `"${cut(claim.text, 80)}"` : id;
        }),
      )
    : sentencesOf(answer)
        .filter((s) => /disagree|conflict|contradict|whereas|differ|dispute/i.test(s))
        .slice(0, 3)
        .map((s) => cut(plain(s), 160));

  const sources = [...new Set([...pages.flatMap(hostsIn), ...hostsIn(answer)])].slice(0, 10);

  const lines = [
    `Question: ${cut(question.replace(/\s+/g, " ").trim(), 300)}`,
    "",
    "Key numbers:",
    ...(numbers.length
      ? numbers.map((n) => `- ${n.value}${n.unit ? ` ${n.unit}` : ""}${n.date ? ` (${n.date})` : ""} — ${n.source}: ${n.claim}`)
      : ["- none stated"]),
    "Parts and relations:",
    ...(claims.length
      ? claims.slice(0, MAX_CLAIMS).map((c) => {
          const backed = c.supports.length ? `backed by ${c.supports.join(", ")}` : "";
          const against = c.contradicts.length ? `contradicted by ${c.contradicts.join(", ")}` : "";
          return `- ${cut(c.text, 140)}${backed || against ? ` (${[backed, against].filter(Boolean).join("; ")})` : ""}`;
        })
      : ["- see the key numbers and the answer below"]),
    "Conflicts:",
    ...(conflictLines.length ? conflictLines.map((line) => `- ${line}`) : ["- none found"]),
    `Sources: ${sources.join(", ") || "none recorded"}`,
    `Object idea: ${objectIdea(numbers, conflictLines.length)}`,
  ];
  const structured = lines.join("\n");
  const room = MAX_BRIEF - structured.length - 20;
  const context = answer.trim() && room > 200 ? `\n\nAnswer (context):\n${cut(answer.trim(), room)}` : "";
  return `${structured}${context}`.slice(0, MAX_BRIEF);
}
