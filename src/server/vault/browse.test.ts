import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getNote } from "@/app/api/vault/note/route";
import { GET as getResolve } from "@/app/api/vault/resolve/route";
import { GET as getTree } from "@/app/api/vault/tree/route";
import { linkifyWikilinks, MISSING_HREF, noteHref, pathFromHref, resolveWikilink } from "@/lib/vault-browse";

import { readVaultNote, vaultTree } from "./browse";
import { VaultPathError } from "./files";

let dir: string;
const previous = process.env.VAULT_DIR;

async function put(rel: string, text: string) {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), text, "utf8");
}

const CLAIM = `---
type: claim
key: minecraft sold 425m
updated: 2026-11-14
---
<!-- agent-research:start -->
# Minecraft has sold more than 425 million copies.

## Supported by
- [[Guinness]] — "over 350 million"
<!-- agent-research:end -->

My own aside.
`;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-browse-"));
  process.env.VAULT_DIR = dir;
  await put("Research/How many copies.md", "---\ntype: research\nupdated: 2026-11-13\n---\n# How many copies\n\n## Claims\n- [[Minecraft sold 425M]]\n");
  await put("Claims/Minecraft sold 425M.md", CLAIM);
  await put("Sources/Guinness.md", '---\ntype: source\nurl: "https://www.guinnessworldrecords.com/x"\nupdated: 2026-11-14\n---\n# Guinness | Records\n');
  await put("Sources/alpha.md", "# alpha\n");
  await put("Zettel/Deep/Idea.md", "an idea\n");
  await mkdir(path.join(dir, "Empty"));
  await mkdir(path.join(dir, ".obsidian"));
  await put(".obsidian/workspace.md", "hidden");
  await put("Inbox.md", "root note");
  await put("Sources/not-a-note.txt", "nope");
});

afterEach(() => {
  process.env.VAULT_DIR = previous;
});

describe("vaultTree", () => {
  it("lists folders first, alphabetically, user folders and root notes included", async () => {
    const tree = await vaultTree(dir);
    expect(tree.children.map((n) => (n.kind === "folder" ? `${n.name}/` : n.title))).toEqual([
      "Claims/",
      "Empty/",
      "Research/",
      "Sources/",
      "Zettel/",
      "Inbox",
    ]);
    const sources = tree.children.find((n) => n.kind === "folder" && n.name === "Sources");
    expect(sources?.kind === "folder" && sources.children.map((n) => n.kind === "note" && n.title)).toEqual(["alpha", "Guinness"]);
    const guinness = sources?.kind === "folder" ? sources.children[1] : undefined;
    expect(guinness).toEqual({ kind: "note", title: "Guinness", path: "Sources/Guinness.md", type: "source", updated: "2026-11-14" });
    const zettel = tree.children.find((n) => n.kind === "folder" && n.name === "Zettel");
    expect(zettel?.kind === "folder" && zettel.children[0]).toMatchObject({ kind: "folder", path: "Zettel/Deep" });
    expect(tree.count).toBe(6);
    expect(tree.titles["minecraft sold 425m"]).toBe("Claims/Minecraft sold 425M.md");
    expect(tree.titles.workspace).toBeUndefined();
  });

  it("is empty for a vault that does not exist", async () => {
    expect(await vaultTree(path.join(dir, "nope"))).toEqual({ children: [], titles: {}, count: 0 });
  });

  it("does not follow symlinks", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "vault-outside-"));
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(outside, path.join(dir, "Linked"));
    await symlink(path.join(outside, "secret.md"), path.join(dir, "Secret.md"));
    const tree = await vaultTree(dir);
    expect(JSON.stringify(tree)).not.toContain("secret");
    expect(JSON.stringify(tree)).not.toContain("Linked");
  });
});

describe("readVaultNote", () => {
  it("returns frontmatter and the body with the markers stripped, content kept", async () => {
    const note = await readVaultNote("Claims/Minecraft sold 425M.md", dir);
    expect(note?.frontmatter).toEqual({ type: "claim", key: "minecraft sold 425m", updated: "2026-11-14" });
    expect(note?.title).toBe("Minecraft sold 425M");
    expect(note?.body).not.toContain("agent-research");
    expect(note?.body).toMatch(/^# Minecraft has sold more than 425 million copies\./);
    expect(note?.body).toContain("- [[Guinness]]");
    expect(note?.body).toContain("My own aside.");
    expect((await readVaultNote("Sources/Guinness.md", dir))?.frontmatter.url).toBe("https://www.guinnessworldrecords.com/x");
  });

  it("is null for a missing note", async () => {
    expect(await readVaultNote("Claims/Nope.md", dir)).toBeNull();
  });

  it.each(["../etc/passwd.md", "Claims/../../x.md", "/etc/hosts.md", "~/x.md", "C:/x.md", "Sources/not-a-note.txt", "Claims/Minecraft sold 425M", ".obsidian/workspace.md", "Claims//x.md"])(
    "refuses %s",
    async (rel) => {
      await expect(readVaultNote(rel, dir)).rejects.toBeInstanceOf(VaultPathError);
    },
  );

  it("refuses symlinks, in or out of the vault", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "vault-outside-"));
    await writeFile(path.join(outside, "secret.md"), "secret");
    await symlink(path.join(outside, "secret.md"), path.join(dir, "Out.md"));
    await symlink(path.join(dir, "Inbox.md"), path.join(dir, "In.md"));
    await symlink(outside, path.join(dir, "Linked"));
    await expect(readVaultNote("Out.md", dir)).rejects.toBeInstanceOf(VaultPathError);
    await expect(readVaultNote("In.md", dir)).rejects.toBeInstanceOf(VaultPathError);
    await expect(readVaultNote("Linked/secret.md", dir)).rejects.toBeInstanceOf(VaultPathError);
  });
});

describe("wikilinks", () => {
  const titles = { guinness: "Sources/Guinness.md", "minecraft sold 425m": "Claims/Minecraft sold 425M.md" };

  it("resolves by title, case-insensitively, with aliases, headings and paths", () => {
    expect(resolveWikilink("Guinness", titles)).toBe("Sources/Guinness.md");
    expect(resolveWikilink("minecraft SOLD 425m|the claim", titles)).toBe("Claims/Minecraft sold 425M.md");
    expect(resolveWikilink("Guinness#Claims", titles)).toBe("Sources/Guinness.md");
    expect(resolveWikilink("Sources/Guinness.md", titles)).toBe("Sources/Guinness.md");
    expect(resolveWikilink("Nope", titles)).toBeUndefined();
    expect(resolveWikilink("constructor", titles)).toBeUndefined();
  });

  it("turns [[links]] outside code into note links, unknown ones into inert ones", () => {
    const out = linkifyWikilinks("See [[Guinness]], [[Minecraft sold 425M|the claim]] and [[Ghost]].\n\n`[[Guinness]]`", titles);
    expect(out).toBe(
      `See [Guinness](${noteHref("Sources/Guinness.md")}), [the claim](${noteHref("Claims/Minecraft sold 425M.md")}) and [Ghost](${MISSING_HREF}).\n\n\`[[Guinness]]\``,
    );
    expect(pathFromHref(noteHref("Claims/Minecraft sold 425M.md"))).toBe("Claims/Minecraft sold 425M.md");
    expect(pathFromHref("https://example.com")).toBeNull();
  });
});

describe("routes", () => {
  const request = (url: string) => new NextRequest(new URL(url, "http://localhost"));

  it("GET /api/vault/tree", async () => {
    const body = await (await getTree()).json();
    expect(body.count).toBe(6);
    expect(body.children[0]).toMatchObject({ kind: "folder", name: "Claims" });
  });

  it("GET /api/vault/note", async () => {
    const ok = await getNote(request(`/api/vault/note?path=${encodeURIComponent("Claims/Minecraft sold 425M.md")}`));
    expect(ok.status).toBe(200);
    expect((await ok.json()).body).toContain("## Supported by");
    expect((await getNote(request("/api/vault/note?path=Claims/Nope.md"))).status).toBe(404);
    expect((await getNote(request("/api/vault/note?path=../x.md"))).status).toBe(400);
    expect((await getNote(request("/api/vault/note"))).status).toBe(400);
  });

  it("GET /api/vault/resolve", async () => {
    expect(await (await getResolve(request("/api/vault/resolve?title=guinness"))).json()).toEqual({ path: "Sources/Guinness.md" });
    expect((await getResolve(request("/api/vault/resolve?title=Ghost"))).status).toBe(404);
  });
});
