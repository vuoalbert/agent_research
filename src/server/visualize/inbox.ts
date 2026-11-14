import { randomUUID } from "node:crypto";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The background agent's input: the run's first prompt, then whatever the
 * chat sends while it works. The agent runs in the SDK's streaming-input mode
 * with this as its `prompt`. A message pushed while a turn is running is
 * queued by Claude Code and folded into that turn between tool rounds, so the
 * agent reads it mid-build. One pushed after a turn ended starts another turn.
 *
 * Every message carries a uuid, and Claude Code lists the uuids each turn
 * consumed (`user_message_uuids` on assistant and result frames). That
 * decides when the run is over: after a result, once every message pushed so
 * far has been consumed (and nothing is queued), the inbox closes, the input
 * stream ends and so does the run. Anything that arrives after the close is
 * refused (`push` → null) and the runner carries it into a resumed session,
 * as it does a message no turn consumed before the run ended.
 */

export type Inbox = AsyncIterable<SDKUserMessage> & {
  /** queue one user message; its uuid, or null once the inbox has closed */
  push(text: string): string | null;
  /** these uuids were consumed by a turn */
  consumed(uuids: readonly string[] | undefined): void;
  /** every message pushed so far has been consumed */
  settled(): boolean;
  /** this message was pushed and no turn has consumed it (yet) */
  isPending(uuid: string): boolean;
  /** end the input: the iterator finishes once the queue is drained */
  close(): void;
  readonly closed: boolean;
};

export function userMessage(text: string, uuid: string = randomUUID()): SDKUserMessage {
  // `uuid` and `session_id` are wire fields the public type leaves out: the
  // uuid is what Claude Code echoes back in `user_message_uuids`
  const message = {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
    priority: "next" as const,
    uuid,
    session_id: "",
  };
  return message as SDKUserMessage;
}

export function createInbox(): Inbox {
  const queue: SDKUserMessage[] = [];
  const pending = new Set<string>();
  let closed = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  return {
    push(text) {
      if (closed) return null;
      const uuid = randomUUID();
      pending.add(uuid);
      queue.push(userMessage(text, uuid));
      poke();
      return uuid;
    },
    consumed(uuids) {
      for (const uuid of uuids ?? []) pending.delete(uuid);
    },
    settled: () => pending.size === 0,
    isPending: (uuid) => pending.has(uuid),
    close() {
      closed = true;
      poke();
    },
    get closed() {
      return closed;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
