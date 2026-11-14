import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * House rule: every control comes from a primitive — shadcn/Base UI, beui,
 * Motion or lucide. Nothing outside `src/components/ui/` may hand-roll a
 * <button> or an <a>; use `Button` (with `render={<Link/>}` when it navigates)
 * and the rest of the recipes instead.
 *
 * This is a source grep rather than a DOM assertion on purpose: the rendered
 * output is full of <button> and <a>, because that is exactly what the
 * primitives emit. What we are policing is the JSX we write.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // ui/ holds the primitives themselves, which of course render elements
      return entry === "ui" ? [] : sourceFiles(path);
    }
    return /\.tsx$/.test(path) ? [path] : [];
  });
}

describe("primitives", () => {
  const files = sourceFiles("src").filter((f) => !/\.test\.tsx$/.test(f));

  it("finds the app's own components to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(["button", "a"])("uses no raw <%s> outside src/components/ui", (tag) => {
    // opening tags only: `<button ...>` / `<a ...>`, not `<article>` or `<abbr>`
    const pattern = new RegExp(`<${tag}(?=[\\s/>])`);
    const offenders = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(offenders, `hand-rolled <${tag}> found`).toEqual([]);
  });

  it("routes every navigating control through next/link", () => {
    // the rail tiles and sidebar rows navigate, so they must carry an href
    for (const file of ["src/components/icon-rail.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain('render={<Link');
      // and Base UI needs telling that the rendered element is not a <button>
      expect(source, file).toContain("nativeButton={false}");
    }
  });
});
