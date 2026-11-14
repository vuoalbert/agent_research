"use client";

/**
 * The line under the docked bar.
 *
 * The bar itself is the composer — see `composer.tsx`, where `docked` is the one
 * boolean that turns the 760px box into an 840px, 16px-radius bar. What is left
 * over is the disclosure under it, and it lives here rather than in the pane
 * because it belongs to the *docked* screen and nothing else on the pane has an
 * opinion about it.
 *
 * One sentence, muted, hung on `DOCK_COLUMN` so it shares the bar's left and
 * right edges. It is not an instruction, so it is not drawn like one — and it is
 * said once, at the foot, rather than repeated under every reply.
 */

import { motion } from "motion/react";

import { DOCK_COLUMN, DOCK_SWAP } from "@/components/ai/tokens";
import { cn } from "@/lib/utils";

/** What a pane with no model behind it owes the reader. */
export const DISCLOSURE = "Starline is AI and can make mistakes.";

export function AiDockedFootnote({
  transition = DOCK_SWAP,
}: {
  transition?: React.ComponentProps<typeof motion.div>["transition"];
}) {
  return (
    <motion.div
      key="footnote"
      layout
      data-ai="docked-footnote"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition}
      className={cn(
        DOCK_COLUMN,
        "flex shrink-0 items-center px-4 pt-2 pb-4",
        "text-[11px] leading-none text-[var(--ai-muted)]",
      )}
    >
      <span>{DISCLOSURE}</span>
    </motion.div>
  );
}
