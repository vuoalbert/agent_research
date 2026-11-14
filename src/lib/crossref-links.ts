import type { Claim, Crossref, RelationKind } from "./crossref";
import { hostOf, sourceKey } from "./source-key";

/**
 * Cross-reference relations as force-graph links between page nodes, styled
 * and ready for `3d-force-graph`: wire them with property-name accessors —
 *
 *   graph.linkColor("color").linkWidth("width").linkLabel("label")
 *        .linkDirectionalParticles("particles")
 *        .linkDirectionalParticleWidth("particleWidth")
 *        .linkDirectionalParticleSpeed("particleSpeed")
 *        .linkDirectionalParticleColor("color")
 *
 * - **conflicts** are the only red in the graph: a solid, opaque red link,
 *   a little wider than an agreement, with nothing drifting along it;
 * - **agrees** are solid grey links, wider the more claims the two pages share.
 *
 * Hovering a link shows its claims with the ✓ / ✗ hosts (`label`, HTML).
 */

export const CROSSREF_LINK_STYLE = {
  agrees: {
    color: "#A3A6AB",
    /** one shared claim */
    width: 0.6,
    /** each further shared claim */
    widthPerClaim: 0.5,
    maxWidth: 3,
  },
  conflicts: {
    /* the knowledge base's ✗ red */
    color: "#DC2626",
    width: 1.2,
  },
} as const;

export type CrossrefLink = {
  /** node ids — `nodeId(url)`, `sourceKey(url)` by default */
  source: string;
  target: string;
  kind: RelationKind;
  claims: Claim[];
  color: string;
  width: number;
  particles: number;
  particleWidth: number;
  particleSpeed: number;
  /** hover label: each claim with its ✓ / ✗ hosts, escaped HTML */
  label: string;
};

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** one claim as hover text: the claim, then its ✓ hosts and ✗ hosts */
export function claimLabel(claim: Claim): string {
  const hosts = (stance: "supports" | "contradicts") =>
    [...new Set(claim.sources.filter((s) => s.stance === stance).map((s) => hostOf(s.url)))].join(", ");
  const yes = hosts("supports");
  const no = hosts("contradicts");
  return [escape(claim.text), yes && `✓ ${escape(yes)}`, no && `✗ ${escape(no)}`].filter(Boolean).join("<br>");
}

export function agreeWidth(sharedClaims: number): number {
  const { width, widthPerClaim, maxWidth } = CROSSREF_LINK_STYLE.agrees;
  return Math.min(maxWidth, width + widthPerClaim * Math.max(0, sharedClaims - 1));
}

/**
 * One link per relation. Relations whose pages are not both in the graph
 * (`hasNode`) are dropped, so the links never point at a missing node.
 */
export function crossrefLinks(
  crossref: Crossref,
  {
    nodeId = sourceKey,
    hasNode,
  }: { nodeId?: (url: string) => string; hasNode?: (id: string) => boolean } = {},
): CrossrefLink[] {
  const claimsById = new Map(crossref.claims.map((claim) => [claim.id, claim]));
  const links: CrossrefLink[] = [];
  for (const relation of crossref.relations) {
    const source = nodeId(relation.a);
    const target = nodeId(relation.b);
    if (source === target) continue;
    if (hasNode && !(hasNode(source) && hasNode(target))) continue;
    const claims = relation.claims.flatMap((id) => claimsById.get(id) ?? []);
    if (claims.length === 0) continue;
    const label = claims.map(claimLabel).join("<br><br>");
    if (relation.kind === "conflicts") {
      const style = CROSSREF_LINK_STYLE.conflicts;
      links.push({
        source,
        target,
        kind: "conflicts",
        claims,
        color: style.color,
        width: style.width,
        particles: 0,
        particleWidth: 0,
        particleSpeed: 0,
        label,
      });
    } else {
      links.push({
        source,
        target,
        kind: "agrees",
        claims,
        color: CROSSREF_LINK_STYLE.agrees.color,
        width: agreeWidth(claims.length),
        particles: 0,
        particleWidth: 0,
        particleSpeed: 0,
        label,
      });
    }
  }
  return links;
}
