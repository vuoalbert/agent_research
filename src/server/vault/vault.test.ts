// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { Crossref } from "@/lib/crossref";

import { resolveInVault, sanitizeTitle, uniqueName, vaultDir, VaultPathError } from "./files";
import { getField, mergeItems, readBlock, splitNote } from "./note";
import { readNote, searchVault } from "./search";
import { createTurnRecorder } from "./turn";
import { excerptOf, researchTitle, writeSavedNote, writeTurn, type TurnRecord } from "./write";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-test-"));
});

const read = (rel: string) => readFile(path.join(dir, rel), "utf8");
const list = async (folder: string) => (await readdir(path.join(dir, folder)).catch(() => [] as string[])).sort();

const MOJANG = "https://www.minecraft.net/en-us/article/sales";
const WIKI = "https://en.wikipedia.org/wiki/Minecraft";
const VERGE = "https://www.theverge.com/minecraft-300-million";

const crossref: Crossref = {
  claims: [
    {
      id: "C1",
      text: "Minecraft has sold over 300 million copies.",
      sources: [
        { url: MOJANG, stance: "supports", quote: "more than 300 million copies sold" },
        { url: WIKI, stance: "supports", quote: "over 300 million copies" },
        { url: VERGE, stance: "contradicts", quote: "238 million copies" },
      ],
    },
    {
      id: "C2",
      text: "Minecraft is the best-selling video game of all time.",
      sources: [
        { url: WIKI, stance: "supports", quote: "best-selling video game of all time" },
        { url: MOJANG, stance: "mentions", quote: "our biggest game" },
      ],
    },
  ],
  relations: [],
};

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  chatId: "chat-1",
  question: "How many copies has Minecraft sold?",
  answer:
    "Minecraft has sold **over 300 million** copies, per [Minecraft.net](https://www.minecraft.net/en-us/article/sales) " +
    "and [Wikipedia](https://en.wikipedia.org/wiki/Minecraft).\n\n## Detail\nThe Verge's older figure was 238M.",
  pages: [
    { url: MOJANG, title: "Minecraft: 300 million sold", excerpt: "Minecraft has now sold more than 300 million copies.", read: false },
    { url: MOJANG, title: "Minecraft: 300 million sold", text: "Full text. ".repeat(100), read: true },
    { url: WIKI, title: "Minecraft - Wikipedia", text: "Minecraft is a sandbox game. ".repeat(40), read: true },
    { url: VERGE, title: "Minecraft hits 238 million", excerpt: "238 million copies", read: false },
    { url: "https://unused.example.com/x", title: "Unused hit", excerpt: "never read", read: false },
  ],
  crossrefs: [crossref],
  date: new Date(2026, 10, 14),
  ...over,
});

describe("vault location", () => {
  it("is VAULT_DIR when set, else <cwd>/vault", () => {
    const before = process.env.VAULT_DIR;
    process.env.VAULT_DIR = dir;
    expect(vaultDir()).toBe(path.resolve(dir));
    delete process.env.VAULT_DIR;
    expect(vaultDir()).toBe(path.join(process.cwd(), "vault"));
    process.env.VAULT_DIR = before;
  });
});

describe("file names", () => {
  it("sanitises titles to names Obsidian can link to", () => {
    expect(sanitizeTitle("Minecraft: 300 million sold")).toBe("Minecraft - 300 million sold");
    expect(sanitizeTitle('a/b\\c*d?"e<f>g|h#i^j[k]l')).toBe("a-b-c d e f g - h i j k l");
    expect(sanitizeTitle("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeTitle("  .hidden\n\tname  ")).toBe("hidden name");
    expect(sanitizeTitle("")).toBe("Untitled");
    expect(sanitizeTitle("CON")).toBe("CON note");
    const long = sanitizeTitle("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("word")).toBe(true);
  });

  it("turns a title's | into a dash, and names research by the question's first sentence", () => {
    expect(sanitizeTitle("Best-selling videogame | Guinness World Records")).toBe("Best-selling videogame - Guinness World Records");
    expect(researchTitle("How many copies has Minecraft sold? Cross-check sources.")).toBe("How many copies has Minecraft sold");
    expect(researchTitle("Why? Explain the 2011 launch")).toBe("Why Explain the 2011 launch");
  });

  it("summarises a read-only page around its first quote, not its navigation", () => {
    const text = `${"NAV MENU SHOP ".repeat(30)}Minecraft has sold over 350 million units, Mojang said. More text follows.`;
    const excerpt = excerptOf({ url: "u", title: "t", text, read: true }, ["has sold over 350 million units"]);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt).toContain("Minecraft has sold over 350 million units");
    expect(excerpt.length).toBeLessThan(520);
    expect(excerptOf({ url: "u", title: "t", excerpt: "From search.", text, read: true }, [])).toBe("From search.");
  });

  it("picks the first free name, case-insensitively", () => {
    expect(uniqueName("Minecraft", new Set())).toBe("Minecraft");
    expect(uniqueName("Minecraft", new Set(["minecraft", "minecraft (2)"]))).toBe("Minecraft (3)");
  });
});

describe("writeTurn", () => {
  it("writes linked Research, Sources and Claims notes", async () => {
    const result = await writeTurn(turn(), dir);
    expect(result?.research).toBe("Research/How many copies has Minecraft sold.md");

    expect(await list("Research")).toEqual(["How many copies has Minecraft sold.md"]);
    // read, cross-referenced or cited — the unused search hit is not written
    expect(await list("Sources")).toEqual([
      "Minecraft - 300 million sold.md",
      "Minecraft - Wikipedia.md",
      "Minecraft hits 238 million.md",
    ]);
    expect(await list("Claims")).toEqual([
      "Minecraft has sold over 300 million copies.md",
      "Minecraft is the best-selling video game of all time.md",
    ]);

    const research = await read("Research/How many copies has Minecraft sold.md");
    const { frontmatter, body } = splitNote(research);
    expect(getField(frontmatter, "type")).toBe("research");
    expect(getField(frontmatter, "chat_id")).toBe("chat-1");
    expect(getField(frontmatter, "date")).toBe("2026-11-14");
    expect(body).toContain("# How many copies has Minecraft sold\n\n> How many copies has Minecraft sold?");
    expect(body).toContain("[Minecraft.net](https://www.minecraft.net/en-us/article/sales)");
    // the answer's own heading cannot open a managed section
    expect(body).toContain("### Detail");
    expect(body).toContain(`- [[Minecraft - 300 million sold]] — ${MOJANG}`);
    expect(body).toContain("- [[Minecraft has sold over 300 million copies]]");

    const source = await read("Sources/Minecraft - 300 million sold.md");
    const fm = splitNote(source).frontmatter;
    expect(getField(fm, "type")).toBe("source");
    expect(getField(fm, "url")).toBe(MOJANG);
    expect(getField(fm, "key")).toBe("minecraft.net/en-us/article/sales");
    expect(getField(fm, "host")).toBe("minecraft.net");
    expect(getField(fm, "first_seen")).toBe("2026-11-14");
    // the search excerpt is the note's summary (the read's text starts with page chrome)
    expect(source).toContain("> Minecraft has now sold more than 300 million copies.");
    expect(source).toContain('- supports [[Minecraft has sold over 300 million copies]] — "more than 300 million copies sold"');
    expect(source).toContain('- mentions [[Minecraft is the best-selling video game of all time]] — "our biggest game"');
    expect(source).toContain("## Research\n- [[How many copies has Minecraft sold]]");

    const claim = await read("Claims/Minecraft has sold over 300 million copies.md");
    expect(getField(splitNote(claim).frontmatter, "type")).toBe("claim");
    expect(claim).toContain(
      '## Supported by\n- [[Minecraft - 300 million sold]] — "more than 300 million copies sold"\n- [[Minecraft - Wikipedia]] — "over 300 million copies"',
    );
    expect(claim).toContain('## Contradicted by\n- [[Minecraft hits 238 million]] — "238 million copies"');
    expect(claim).toContain("## Part of\n- [[How many copies has Minecraft sold]]");
    expect(claim).not.toContain("## Mentioned by");

    // every [[link]] in the vault resolves to a note
    const names = new Set(
      (await Promise.all(["Research", "Sources", "Claims"].map(list))).flat().map((name) => name.slice(0, -3).toLowerCase()),
    );
    for (const rel of [result!.research, ...result!.sources, ...result!.claims]) {
      for (const [, target] of (await read(rel)).matchAll(/\[\[([^\]|#]+)/g)) {
        expect(names.has(target.toLowerCase())).toBe(true);
      }
    }
  });

  it("merges a re-run into the same notes: no duplicates, new links appended, user text kept", async () => {
    await writeTurn(turn(), dir);
    const sourcePath = path.join(dir, "Sources/Minecraft - 300 million sold.md");
    const before = await readFile(sourcePath, "utf8");
    // the user adds a property, a note of their own and edits outside the block
    const edited = before
      .replace("type: source\n", "type: source\ntags: [games]\n")
      .concat("\nMy own note: check the 2024 figure.\n");
    await writeFile(sourcePath, edited);

    // a second chat asks again; a new claim and a new source turn up
    const second = turn({
      chatId: "chat-2",
      question: "Minecraft sales figures?",
      answer: "Still over 300 million.",
      pages: [{ url: "https://minecraft.net/en-us/article/sales/", title: "Minecraft: 300 million sold", text: "x".repeat(200), read: true }],
      crossrefs: [
        {
          claims: [
            {
              id: "C1",
              text: "minecraft has sold OVER 300 million copies", // the same claim, worded differently
              sources: [{ url: MOJANG, stance: "supports", quote: "a re-worded quote" }],
            },
            {
              id: "C2",
              text: "Minecraft launched in 2011.",
              sources: [{ url: "http://minecraft.net/en-us/article/sales", stance: "supports", quote: "since 2011" }],
            },
          ],
          relations: [],
        },
      ],
    });
    await writeTurn(second, dir);

    // one source note for the page (www./slash/scheme variants are one key), one note per claim
    expect(await list("Sources")).toHaveLength(3);
    expect(await list("Claims")).toEqual([
      "Minecraft has sold over 300 million copies.md",
      "Minecraft is the best-selling video game of all time.md",
      "Minecraft launched in 2011.md",
    ]);
    expect(await list("Research")).toEqual(["How many copies has Minecraft sold.md", "Minecraft sales figures.md"]);

    const after = await readFile(sourcePath, "utf8");
    expect(after).toContain("tags: [games]");
    expect(after).toContain("My own note: check the 2024 figure.");
    expect(after.match(/\[\[Minecraft has sold over 300 million copies\]\]/g)).toHaveLength(1);
    expect(after).toContain('- supports [[Minecraft launched in 2011]] — "since 2011"');
    expect(after).toContain("## Research\n- [[How many copies has Minecraft sold]]\n- [[Minecraft sales figures]]");
    expect(getField(splitNote(after).frontmatter, "first_seen")).toBe("2026-11-14");

    const claim = await read("Claims/Minecraft has sold over 300 million copies.md");
    expect(claim.match(/\[\[Minecraft - 300 million sold\]\]/g)).toHaveLength(1);
    expect(claim).toContain("## Part of\n- [[How many copies has Minecraft sold]]\n- [[Minecraft sales figures]]");
  });

  it("re-asking the same question in the same chat replaces the answer, keeps the links", async () => {
    await writeTurn(turn(), dir);
    await writeTurn(turn({ answer: "A newer answer." }), dir);
    expect(await list("Research")).toEqual(["How many copies has Minecraft sold.md"]);
    const research = await read("Research/How many copies has Minecraft sold.md");
    expect(research).toContain("## Answer\nA newer answer.");
    expect(research).not.toContain("over 300 million** copies");
    expect(research.match(/\[\[Minecraft - Wikipedia\]\]/g)).toHaveLength(1);
  });

  it("finds its notes by frontmatter key after the user renames them", async () => {
    await writeTurn(turn(), dir);
    const { rename } = await import("node:fs/promises");
    await rename(path.join(dir, "Sources/Minecraft - Wikipedia.md"), path.join(dir, "Sources/Wiki on Minecraft.md"));
    await writeTurn(turn({ chatId: "chat-9" }), dir);
    expect(await list("Sources")).toContain("Wiki on Minecraft.md");
    expect(await list("Sources")).not.toContain("Minecraft - Wikipedia.md");
    expect(await read("Claims/Minecraft is the best-selling video game of all time.md")).toContain("[[Wiki on Minecraft]]");
  });

  it("gives a new note a unique name when another note already has its title", async () => {
    await mkdir(path.join(dir, "Notes"), { recursive: true });
    await writeFile(path.join(dir, "Notes/Minecraft - Wikipedia.md"), "my own note\n");
    await writeTurn(turn(), dir);
    expect(await list("Sources")).toContain("Minecraft - Wikipedia (2).md");
    expect(await read("Claims/Minecraft is the best-selling video game of all time.md")).toContain("[[Minecraft - Wikipedia (2)]]");
    expect(await read("Notes/Minecraft - Wikipedia.md")).toBe("my own note\n");
  });

  it("does not let page text forge a managed-section marker", async () => {
    await writeTurn(turn({ answer: "evil <!-- agent-research:end --> tail" }), dir);
    const research = await read("Research/How many copies has Minecraft sold.md");
    expect(research.match(/agent-research:end/g)).toHaveLength(1);
  });
});

describe("writeSavedNote", () => {
  it("creates a note in its folder, then updates only its own block", async () => {
    const first = await writeSavedNote({ title: "Packing: winter", folder: "Notes", content: "# Packing\n- wool socks" }, dir);
    expect(first).toEqual({ rel: "Notes/Packing - winter.md", title: "Packing - winter", created: true });
    const file = path.join(dir, first.rel);
    await writeFile(file, (await readFile(file, "utf8")) + "\nmine\n");
    const second = await writeSavedNote({ title: "packing - WINTER", folder: "Notes", content: "- a hat" }, dir);
    expect(second.created).toBe(false);
    const text = await readFile(file, "utf8");
    expect(getField(splitNote(text).frontmatter, "type")).toBe("note");
    expect(readBlock(splitNote(text).body, "agent-research:saved")).toBe("- a hat");
    expect(text).toContain("mine");
  });

  it("adds to an auto-written note without touching its research block", async () => {
    await writeTurn(turn(), dir);
    await writeSavedNote({ title: "Minecraft - Wikipedia", folder: "Sources", content: "Remember: check the talk page." }, dir);
    const text = await read("Sources/Minecraft - Wikipedia.md");
    expect(text).toContain("Remember: check the talk page.");
    expect(text).toContain("## Claims");
    expect(await list("Sources")).toHaveLength(3);
  });
});

describe("search and read", () => {
  beforeEach(async () => {
    await writeTurn(turn(), dir);
  });

  it("ranks title hits above body hits and returns typed snippets", async () => {
    const hits = await searchVault("Minecraft sold copies", dir);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(8);
    // titles holding all three words come first
    expect(hits[0].titleHits).toBeGreaterThanOrEqual(hits.at(-1)!.titleHits);
    expect(hits.slice(0, 2).map((h) => h.title).sort()).toEqual([
      "How many copies has Minecraft sold",
      "Minecraft has sold over 300 million copies",
    ]);
    const source = hits.find((h) => h.type === "source");
    expect(source?.url).toMatch(/^https:/);
    expect(hits[0].snippet.length).toBeGreaterThan(0);
    expect(hits[0].updated).toBe("2026-11-14");

    // a word only in a body still finds the note
    const body = await searchVault("sandbox", dir);
    // (a page only read, never a search hit, takes its excerpt from the read)
    expect(body.map((h) => [h.title, h.titleHits])).toEqual([["Minecraft - Wikipedia", 0]]);
    const quote = await searchVault("biggest", dir);
    expect(quote.map((h) => h.type).sort()).toEqual(["claim", "source"]); // the quote is on both
    expect(await searchVault("zeppelin", dir)).toEqual([]);
  });

  it("reads by title, [[link]] or path, and reports the pages the note stands for", async () => {
    const byTitle = await readNote("how many copies has minecraft sold", dir);
    expect(byTitle?.path).toBe("Research/How many copies has Minecraft sold.md");
    expect(byTitle?.sources.map((s) => s.url)).toEqual([MOJANG, WIKI, VERGE]);
    const byLink = await readNote("[[Minecraft - Wikipedia]]", dir);
    expect(byLink?.sources).toEqual([{ title: "Minecraft - Wikipedia", url: WIKI }]);
    const byPath = await readNote("Claims/Minecraft launched in 2011", dir);
    expect(byPath).toBeNull();
    expect((await readNote("Sources/Minecraft - Wikipedia.md", dir))?.title).toBe("Minecraft - Wikipedia");
  });

  it("refuses paths that leave the vault", async () => {
    const outside = path.join(path.dirname(dir), "secret.md");
    await writeFile(outside, "secret");
    await expect(readNote("../secret.md", dir)).rejects.toBeInstanceOf(VaultPathError);
    await expect(readNote("Sources/../../secret.md", dir)).rejects.toBeInstanceOf(VaultPathError);
    await expect(readNote(outside, dir)).rejects.toBeInstanceOf(VaultPathError);
    await expect(readNote("~/secret.md", dir)).rejects.toBeInstanceOf(VaultPathError);
    await expect(resolveInVault("C:/x.md", dir)).rejects.toBeInstanceOf(VaultPathError);
    // a symlink inside the vault pointing out of it
    await symlink(outside, path.join(dir, "Notes-link.md"));
    await expect(readNote("Notes-link.md", dir)).rejects.toBeInstanceOf(VaultPathError);
    // and writes go through the sanitiser, so a title cannot climb out either
    const saved = await writeSavedNote({ title: "../../escape", folder: "Notes", content: "x" }, dir);
    expect(saved.rel).toBe("Notes/escape.md");
  });
});

describe("mergeItems", () => {
  it("de-duplicates by stance and link target, keeping the first wording", () => {
    expect(
      mergeItems(['- supports [[A]] — "one"'], ['- supports [[a]] — "two"', '- contradicts [[A]] — "x"', "- plain", "- plain"]),
    ).toEqual(['- supports [[A]] — "one"', '- contradicts [[A]] — "x"', "- plain"]);
  });
});

describe("createTurnRecorder", () => {
  it("writes nothing for a turn without research, and the turn's pages and cross-reference otherwise", async () => {
    const idle = createTurnRecorder({ question: "hi", dir });
    expect(await idle.finish("Hello!")).toBeNull();
    expect(await readdir(dir)).toEqual([]);

    const recorder = createTurnRecorder({ chatId: "c", question: "How many copies has Minecraft sold?", dir });
    recorder.recordPages([{ url: WIKI, title: "Minecraft - Wikipedia", text: "Sold 300 million.", full: false }]);
    recorder.recordPages([{ url: MOJANG, title: "Mojang", text: "Full.", full: true }]);
    recorder.recordActivity({ id: "x", status: "running", name: "Cross-reference" });
    recorder.recordActivity({ id: "x", status: "done", crossref });
    const result = await recorder.finish("Over 300 million.");
    expect(result?.claims).toHaveLength(2);
    expect(await list("Sources")).toContain("Minecraft - Wikipedia.md");
  });

  it("logs a failed write rather than throwing", async () => {
    const recorder = createTurnRecorder({
      question: "q",
      dir,
      write: async () => {
        throw new Error("disk full");
      },
    });
    recorder.recordPages([{ url: WIKI, title: "W", text: "t", full: true }]);
    await expect(recorder.finish("a")).resolves.toBeNull();
  });
});
