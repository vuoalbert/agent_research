import { describe, expect, it } from "vitest";

import { claimKey, deriveRelations, mergeCrossrefs, type Claim } from "./crossref";
import { CROSSREF_LINK_STYLE, agreeWidth, crossrefLinks } from "./crossref-links";

const A = "https://a.com/x";
const B = "https://www.b.com/y/";
const C = "https://c.com";

const claim = (id: string, text: string, stances: [string, "supports" | "contradicts" | "mentions"][]): Claim => ({
  id,
  text,
  sources: stances.map(([url, stance]) => ({ url, stance, quote: `${stance} ${id}` })),
});

describe("deriveRelations", () => {
  it("pairs supporters as agrees and supporter↔contradicter as conflicts, mentions as nothing", () => {
    const relations = deriveRelations([
      claim("C1", "x", [[A, "supports"], [B, "supports"], [C, "contradicts"]]),
      claim("C2", "y", [[A, "supports"], [B, "supports"], [C, "mentions"]]),
    ]);
    expect(relations).toEqual([
      { a: A, b: B, kind: "agrees", claims: ["C1", "C2"] },
      { a: A, b: C, kind: "conflicts", claims: ["C1"] },
      { a: B, b: C, kind: "conflicts", claims: ["C1"] },
    ]);
  });

  it("never relates a page to itself under another spelling", () => {
    expect(deriveRelations([claim("C1", "x", [[B, "supports"], ["http://b.com/y", "contradicts"]])])).toEqual([]);
  });
});

describe("mergeCrossrefs", () => {
  it("de-duplicates claims by normalised text and re-derives the relations", () => {
    const merged = mergeCrossrefs([
      { claims: [claim("C1", "Minecraft sold 300 million copies.", [[A, "supports"]])], relations: [] },
      undefined,
      {
        claims: [
          claim("C1", "minecraft  sold 300 million copies", [["https://a.com/x/", "contradicts"], [C, "contradicts"]]),
          claim("C2", "Something else", [[A, "supports"], [B, "supports"]]),
        ],
        relations: [],
      },
    ]);
    expect(merged.claims.map((c) => [c.id, c.text])).toEqual([
      ["c1", "Minecraft sold 300 million copies."],
      ["c2", "Something else"],
    ]);
    // A's first stance stands; C joins
    expect(merged.claims[0].sources.map((s) => [s.url, s.stance])).toEqual([[A, "supports"], [C, "contradicts"]]);
    expect(merged.relations).toEqual([
      { a: A, b: C, kind: "conflicts", claims: ["c1"] },
      { a: A, b: B, kind: "agrees", claims: ["c2"] },
    ]);
    expect(claimKey("It's 300M!")).toBe("it s 300m");
  });
});

describe("crossrefLinks", () => {
  const crossref = mergeCrossrefs([
    {
      claims: [
        claim("C1", "Sold <300M>", [[A, "supports"], [B, "supports"], [C, "contradicts"]]),
        claim("C2", "Players", [[A, "supports"], [B, "supports"]]),
        claim("C3", "Price", [[A, "supports"], [B, "supports"]]),
      ],
      relations: [],
    },
  ]);

  it("makes agrees grey and wider per shared claim, conflicts red with slow particles", () => {
    const links = crossrefLinks(crossref);
    const agree = links.find((l) => l.kind === "agrees")!;
    expect(agree).toMatchObject({ source: "a.com/x", target: "b.com/y", color: CROSSREF_LINK_STYLE.agrees.color, particles: 0 });
    expect(agree.width).toBe(agreeWidth(3));
    expect(agreeWidth(1)).toBeLessThan(agreeWidth(3));
    expect(agreeWidth(100)).toBe(CROSSREF_LINK_STYLE.agrees.maxWidth);

    const conflicts = links.filter((l) => l.kind === "conflicts");
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatchObject({ color: "#DC2626", particles: 3, particleWidth: 2, particleSpeed: 0.004 });
    // red is for conflicts only
    expect(links.filter((l) => l.color === "#DC2626").every((l) => l.kind === "conflicts")).toBe(true);
    // hover label: the claim, escaped, with ✓ and ✗ hosts
    expect(conflicts[0].label).toBe("Sold &lt;300M&gt;<br>✓ a.com, b.com<br>✗ c.com");
  });

  it("stills the particles under reduced motion and drops links to missing nodes", () => {
    expect(crossrefLinks(crossref, { reducedMotion: true }).every((l) => l.particles === 0)).toBe(true);
    const onlyAB = crossrefLinks(crossref, { hasNode: (id) => id !== "c.com" });
    expect(onlyAB.map((l) => l.kind)).toEqual(["agrees"]);
  });
});
