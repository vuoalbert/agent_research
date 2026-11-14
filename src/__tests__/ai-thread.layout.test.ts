// @vitest-environment node
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The two things about the thread that only a real layout can answer: where the
 * first turn sits, and where the scroller ends up after a send. jsdom reports
 * every box as 0x0, so the unit test next door can only assert the classes.
 *
 * Opt-in, because it needs the app running:
 *   npm run dev
 *   PLAYWRIGHT_URL=http://localhost:3500 npx vitest run ai-thread.layout
 */
const URL = process.env.PLAYWRIGHT_URL;
const suite = URL ? describe : describe.skip;

/** put a chat of `turns` messages in the store before the app boots */
function seedScript(turns: number) {
  return `(() => {
    const now = Date.now();
    const id = "chat-fixture";
    const messages = Array.from({ length: ${turns} }, (_, i) => ({
      id: "msg-" + i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "Turn " + (i + 1) + " — a line of conversation to give the thread some height.",
      createdAt: now + i,
    }));
    localStorage.setItem("agent_research.agent.v1", JSON.stringify({
      chats: [{ id, title: "Fixture", createdAt: now, updatedAt: now }],
      messages: { [id]: messages },
      activeChatId: id,
    }));
  })()`;
}

suite("AI thread — measured layout", () => {
  let browser: Browser;

  const open = async (turns: number): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await context.addInitScript(seedScript(turns));
    const page = await context.newPage();
    await page.goto(`${URL}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector("[data-role]");
    return page;
  };

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => browser?.close());

  it("starts a short thread just under the header strip", async () => {
    const page = await open(2);
    const gap = await page.evaluate(() => {
      const strip = document.querySelector('[data-region="ai-header"]')!.getBoundingClientRect();
      const first = document.querySelector("[data-role]")!.getBoundingClientRect();
      return first.top - strip.bottom;
    });
    // the list's 24px padding, and nothing else: no filler pushing it down
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);
    await page.close();
  });

  it("leaves a short thread unscrolled, with room below it", async () => {
    const page = await open(2);
    const box = await page.evaluate(() => {
      const s = document.querySelector('[data-ai="thread"]') as HTMLElement;
      return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };
    });
    expect(box.scrollTop).toBe(0);
    // it does not fill the pane — which is the whole point of the fix
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight);
    await page.close();
  });

  it("scrolls a long thread to the newest message after a send", async () => {
    const page = await open(30);
    const field = page.locator('[data-composer="docked"] textarea');
    await field.fill("and one more line to push the thread along");
    await field.press("Enter");
    await page.waitForTimeout(400);

    const box = await page.evaluate(() => {
      const s = document.querySelector('[data-ai="thread"]') as HTMLElement;
      return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };
    });
    // taller than the pane, and parked at the bottom
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(box.scrollTop + box.clientHeight).toBeGreaterThanOrEqual(box.scrollHeight - 2);
    await page.close();
  });
});
