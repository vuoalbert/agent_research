/**
 * What the background agent is told about messages from the chat, and how
 * each one reaches it (see inbox.ts for the delivery, runner.ts for when a
 * message goes into the live run and when it resumes a finished one).
 */

/** appended to the agent's system prompt, after the studio's own rules */
export const MESSAGING_RULES = [
  "# Messages from the chat",
  "- The person can send you a message from the app's chat while you work, or after you finished. It arrives as a user message starting with \"Message from the chat\". Treat it as a change request to this figure: say in one short sentence what you will change, apply it to the build in your folder, check it in proportion to the change, and copy the page to ./figure.html again.",
  "- Read-only research notes are available with vault_search and vault_read (the app's research vault: earlier answers, sources, claims). Use them when a fact for the figure might be there; they cannot write.",
].join("\n");

const quoted = (texts: readonly string[]) =>
  texts.length === 1 ? texts[0] : texts.map((text, i) => `${i + 1}. ${text}`).join("\n");

/** a message for the run in progress: folded into the turn between tool calls */
export function liveMessage(text: string): string {
  return [
    `Message from the chat, sent while you are building: ${text}`,
    "",
    "Say in one short sentence what you will change, then work it into the figure as you go. Keep going until ./figure.html reflects it, and end your final reply with one line that starts with \"Changed:\" and says, in a sentence or two, how you applied this message.",
  ].join("\n");
}

/** the first turn of a resumed session: the build is done and is to be changed */
export function resumeMessage(texts: readonly string[]): string {
  return [
    `Message from the chat about the figure you built: ${quoted(texts)}`,
    "",
    "Edit the existing build in your folder to apply it (don't start over), rebuild, check it in proportion to the change, and copy the final light page to ./figure.html again. Then reply with one line that starts with \"Changed:\" and says, in a sentence or two, what you changed.",
  ].join("\n");
}

/** the most of the agent's reply a job keeps */
export const MAX_REPLY = 600;

/**
 * The agent's answer to the chat, from its final reply: the `Changed:` line
 * it was asked to end with, or else the start of the reply. Plain text,
 * one line, markdown emphasis and code ticks removed.
 */
export function replyFrom(summary: string | undefined): string | undefined {
  if (!summary?.trim()) return undefined;
  const plain = (value: string) => value.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  const marked = [...summary.matchAll(/(?:^|\n)[\s>*_-]*Changed:[*_]*\s*([\s\S]*?)(?=\n\s*\n|$)/gi)].pop();
  const text = plain(marked?.[1] ?? summary);
  if (!text) return undefined;
  return text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY - 1)}…` : text;
}
