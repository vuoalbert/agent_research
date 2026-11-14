import { sourceKey } from "./source-key";

/**
 * Cross-reference results — shared by the chat route (which derives them) and
 * the store / Knowledge base / graph (which merge and draw them). Pure, so it
 * can run on either side.
 *
 * A **claim** is one normalised factual statement, with each source's stance
 * on it. A **relation** is what two sources' stances add up to: they `agree`
 * when both support a claim, they `conflict` when one supports it and the
 * other contradicts it.
 */

export type Stance = "supports" | "contradicts" | "mentions";

export type ClaimSource = { url: string; stance: Stance; quote: string };

export type Claim = { id: string; text: string; sources: ClaimSource[] };

export type RelationKind = "agrees" | "conflicts";

export type Relation = {
  /** for `conflicts`, `a` supports the claim(s) and `b` contradicts them */
  a: string;
  b: string;
  kind: RelationKind;
  claims: string[];
};

export type Crossref = { claims: Claim[]; relations: Relation[] };

/** the same claim worded with different case, spacing or punctuation */
export function claimKey(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Source↔source relations from claims. One entry per (pair, kind), listing
 * every claim behind it in claim order. Sources are compared by `sourceKey`,
 * so `www.` / trailing-slash spellings of one page never relate to themselves.
 */
export function deriveRelations(claims: readonly Claim[]): Relation[] {
  const relations = new Map<string, Relation>();
  const add = (kind: RelationKind, a: string, b: string, claimId: string) => {
    const id = `${kind}\u0000${sourceKey(a)}\u0000${sourceKey(b)}`;
    const existing = relations.get(id);
    if (existing) {
      if (!existing.claims.includes(claimId)) existing.claims.push(claimId);
    } else {
      relations.set(id, { a, b, kind, claims: [claimId] });
    }
  };

  for (const claim of claims) {
    // one stance per page, the first one stated
    const byPage = new Map<string, ClaimSource>();
    for (const source of claim.sources) {
      const key = sourceKey(source.url);
      if (!byPage.has(key)) byPage.set(key, source);
    }
    const pages = [...byPage.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    const supporters = pages.filter(([, s]) => s.stance === "supports");
    const contradicters = pages.filter(([, s]) => s.stance === "contradicts");

    for (let i = 0; i < supporters.length; i++) {
      for (let j = i + 1; j < supporters.length; j++) {
        add("agrees", supporters[i][1].url, supporters[j][1].url, claim.id);
      }
    }
    for (const [, yes] of supporters) {
      for (const [, no] of contradicters) add("conflicts", yes.url, no.url, claim.id);
    }
  }
  return [...relations.values()];
}

/**
 * Several cross-reference runs as one: claims de-duplicated by `claimKey` (the
 * first wording wins), each claim's sources de-duplicated by page (the first
 * stance wins), claims re-numbered `c1…`, and relations derived afresh.
 */
export function mergeCrossrefs(results: readonly (Crossref | undefined)[]): Crossref {
  const merged = new Map<string, { text: string; sources: Map<string, ClaimSource> }>();
  for (const result of results) {
    for (const claim of result?.claims ?? []) {
      if (!claim || typeof claim.text !== "string" || !Array.isArray(claim.sources)) continue;
      const key = claimKey(claim.text);
      if (!key) continue;
      let entry = merged.get(key);
      if (!entry) {
        entry = { text: claim.text, sources: new Map() };
        merged.set(key, entry);
      }
      for (const source of claim.sources) {
        if (!source || typeof source.url !== "string") continue;
        const page = sourceKey(source.url);
        if (!entry.sources.has(page)) entry.sources.set(page, source);
      }
    }
  }
  const claims: Claim[] = [...merged.values()].map((entry, i) => ({
    id: `c${i + 1}`,
    text: entry.text,
    sources: [...entry.sources.values()],
  }));
  return { claims, relations: deriveRelations(claims) };
}
