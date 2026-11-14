import type { CSSProperties } from "react";

/**
 * The AI pane's greys, its columns and its one curve — declared once so the
 * five files that draw this screen cannot each pick their own.
 *
 * ── The tones ────────────────────────────────────────────────────────────────
 * These are the `--plane-*` tokens CONTRACT.md §2 sampled off the reference
 * PNG, re-declared under `--ai-*` names on the pane's root. Two reasons for the
 * prefix rather than the bare `--line` / `--ink` / `--muted` the source screen
 * uses:
 *
 * - `--muted` is already a shadcn theme token in `globals.css`, and Tailwind's
 *   `bg-muted` resolves through it. Redefining it on this subtree would quietly
 *   repaint the hover state of every `Button` inside the pane.
 * - The pane is not allowed to add tokens to `globals.css` (scaffold-owned), so
 *   these live on the element. A custom property set on the pane's root is
 *   inherited by everything in it and by nothing outside it, which is the same
 *   scoping a token would have had without the shared-file edit.
 *
 * ── Where each one comes from ────────────────────────────────────────────────
 *   --ai-line   #E1E2E3  --plane-border-strong: the control hairline. Card
 *                        edges and the dashed empty slots.
 *   --ai-ink    #0F0F10  --plane-ink: titles, message text, the send circle.
 *   --ai-muted  #494D50  --plane-muted: placeholders, dates, descriptions.
 *   --ai-tint   #F9F9F9  --plane-band: every hover wash on this screen. One
 *                        wash, one grey — the same rule the group bands follow.
 *   --ai-chip   #EAEBEC  --plane-border: the user's message bubble and the
 *                        count badge. The reference screen uses a warmer
 *                        #E2E2E0 here; this palette has no warm grey in it, and
 *                        a bubble in a tone the rest of the card never uses is
 *                        the one thing on the page that would look imported.
 */
export const PANE_TONES = {
  "--ai-line": "#E1E2E3",
  "--ai-ink": "#0F0F10",
  "--ai-muted": "#494D50",
  "--ai-tint": "#F9F9F9",
  "--ai-chip": "#EAEBEC",
} as CSSProperties;

/**
 * The centred composer's width.
 *
 * The screen this reproduces is 900px wide in a 1151px pane. This pane is the
 * clone's content card below its header — **1120 x 806**, measured, not
 * assumed — and the brief scales the box to ~760 for it. 760/900 is 0.845, and
 * that one ratio is what every other number on this screen is scaled by, so the
 * proportions of the source survive the smaller frame instead of each element
 * being re-guessed.
 *
 * `max-w` beside it because 760 is wider than this card on a narrow window, and
 * a composer that reaches past its own pane is worse than a narrow one.
 */
export const COLUMN = "w-[760px] max-w-[calc(100%-64px)]";

/**
 * The docked bar's width — 1000 on the source screen, 840 here, the same 0.845.
 *
 * Wider than the home box on purpose: the centred box is an invitation and
 * wants air around it, while the docked bar is chrome at the foot of a
 * conversation, and chrome narrower than the text above it reads as a second,
 * smaller column. The thread hangs on the same 840 so a message and the bar
 * under it share one left edge.
 */
export const DOCK_COLUMN = "w-[840px] max-w-[calc(100%-64px)]";

export const THREAD_COLUMN = DOCK_COLUMN;

/**
 * One curve for the whole swap: the composer's travel, its corner, its
 * counter-scaled contents, the thread's arrival and the cards' exit.
 *
 * `[0.32, 0.72, 0, 1]` leaves immediately and lands slowly, which is what a box
 * travelling two thirds of the pane's height needs. 450ms because at 320 the
 * same distance reads as a snap — long enough to be a move, short enough not to
 * be a wait. Several curves near each other is several things happening at
 * once; one curve is a screen changing.
 */
export const DOCK_SWAP = { duration: 0.45, ease: [0.32, 0.72, 0, 1] } as const;

/**
 * The ribbon mark behind the composer, and the band where it stops being drawn.
 *
 * It replaces a 400px lucide `Layers` diamond that drew here in outline. The
 * measured numbers off that diamond: 333.6px of ink centred on the pane, its
 * lower **half** behind the box, and an 80px fade ending exactly on the box's
 * top edge. Two of those three carry over unchanged. The width does not: the
 * ribbon is 16:9 where the diamond was square, so matching 333.6 would put a
 * 188px-tall mark where a 333px one used to be and the wash would lose most of
 * its mass. `MARK_SIZE` is set so the ribbon's *height* lands on the diamond's
 * — 600 x 338 against 333.6 x 333.3 — which is what actually reads as the same
 * footprint on the page.
 *
 * `MARK_SIZE` is the ink width, not a box: `RibbonMark`'s viewBox is the ink
 * box, so there is no padding to discount.
 *
 * The glyph is drawn **twice**, at the same size and position: once sharp and
 * once blurred, each masked with the *other's* gradient. Sharp at the crown,
 * blurred as it nears the box, and the crossfade between the two is the
 * dissolve — without it the mark meets the composer at a hard line, because the
 * box is opaque and the mark simply stops.
 *
 * The percentages are of the mark's own box and not of the layer that clips it:
 * the layer's height moves with the composer (a three-line field is 24px taller
 * than a two-line one) and a ramp pinned to that would slide up and down the
 * glyph as somebody typed. They are derived rather than written down so that
 * moving `MARK_SIZE` moves the ramp with it.
 *
 * `rgba(0,0,0,0)` rather than `transparent` because a gradient to the keyword
 * interpolates through premultiplied black in older engines and leaves a grey
 * bloom in the middle of the ramp.
 */
export const MARK_SIZE = 600;
/** 0.5634, the ribbon's aspect — see `INK` in components/brand/ribbon.tsx */
export const MARK_HEIGHT = Math.round(MARK_SIZE * 0.5634);
/** how far above the composer's top edge the mark starts, so its lower third
 *  is behind the box: bottom = top edge + height/3 */
export const MARK_RISE = Math.round((MARK_HEIGHT * 2) / 3);
export const MARK_BLUR_PX = 9;

/** the composer's top edge, as a percentage down the mark's own box */
const EDGE = (100 * MARK_RISE) / MARK_HEIGHT;
/** the ramp is the 80px directly above that edge, as the diamond's was */
const RAMP = EDGE - (100 * 80) / MARK_HEIGHT;
const pc = (n: number) => `${n.toFixed(2)}%`;

export const MARK_CRISP_MASK =
  `linear-gradient(to bottom, #000 0%, #000 ${pc(RAMP)}, rgba(0,0,0,0) ${pc(EDGE)})`;
export const MARK_BLUR_MASK =
  `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${pc(RAMP)}, #000 ${pc(EDGE)})`;

/**
 * No native scrollbars, written as utilities rather than as a `@utility` rule.
 *
 * `globals.css` is the scaffold's file (CONTRACT.md §5) and this is the one
 * thing the pane needs from it, so it is spelled out in Tailwind's arbitrary
 * syntax instead. The region still scrolls by wheel, trackpad, touch and
 * keyboard; only the bar is hidden — which is the whole requirement, since a
 * 15px macOS gutter inside a 760px column is wider than the hairline it sits
 * against.
 */
export const NO_SCROLLBAR =
  "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";

/** The pane's ring, for the one focus affordance this screen draws. */
export const FOCUS_RING =
  "focus-visible:ring-2 focus-visible:ring-[#D6D7D9] focus-visible:outline-none";
