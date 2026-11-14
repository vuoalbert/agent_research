import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __setSeedForTests, type SeedChat } from "@/lib/agent-store";

// the chat route writes researched turns to the vault: never the repo's own in tests
process.env.VAULT_DIR = mkdtempSync(join(tmpdir(), "agent-research-vault-"));
// no World Labs worlds unless a test injects its own service (src/server/worlds/service.ts)
process.env.WORLDS_DISABLED = "1";
process.env.WORLDS_DIR = mkdtempSync(join(tmpdir(), "agent-research-worlds-"));
// … and records its usage (src/server/telem/usage.ts): never into the repo's /.telem either
process.env.TELEM_USAGE_DIR = mkdtempSync(join(tmpdir(), "agent-research-usage-"));

/**
 * Sample conversations for the AI tests. The app itself starts with no chats;
 * the tests seed these so the sidebar and pane have rows to lay out against.
 * Newest first, 2–4 messages each.
 */
export const SAMPLE_CHATS: SeedChat[] = [
  {
    title: "Hey",
    messages: [
      ["user", "Hey"],
      ["assistant", "Hey! I'm Agent Research. Ask me anything — or start with one of your projects."],
    ],
  },
  {
    title: "Trip packing list",
    messages: [
      ["user", "Put together a packing list for a two-night trip in mid-November."],
      ["assistant", "Overnight lows run 38–45°F, so the list leans warm: layers, a rain shell, a headlamp with spare batteries, and comfortable shoes."],
      ["user", "Add what a shared kitchen box needs on top of that."],
      ["assistant", "Two stoves with full fuel, a pot set, wash bins, a first-aid kit, and a duty rota."],
    ],
  },
  {
    title: "Event sign-up form",
    messages: [
      ["user", "Draft the sign-up form for the hike on the 22nd."],
      ["assistant", "Drafted it: activity, meet time at 7:30am, return by 4pm, driver list, and an emergency-contact field."],
      ["user", "Who still hasn't signed up?"],
      ["assistant", "Eleven of nineteen are in. Eight people are still outstanding."],
    ],
  },
  {
    title: "Mentor contact list",
    messages: [
      ["user", "Which mentors do we have on file for the core topics?"],
      ["assistant", "Fourteen mentors cover nine of the thirteen core topics. Four topics have no mentor yet."],
      ["user", "Ask around at the next planning meeting about the gaps."],
      ["assistant", "Added it to the planning agenda for the 14th, with the four uncovered topics listed."],
    ],
  },
  {
    title: "Quarterly review deck",
    messages: [
      ["user", "Start the deck for the quarterly review."],
      ["assistant", "Outlined twelve slides: opening, the year in review, milestones by team, highlights, recognition, and the closing."],
      ["user", "How many milestones this cycle?"],
      ["assistant", "Twenty-three across all teams."],
    ],
  },
  {
    title: "Volunteer shift schedule",
    messages: [
      ["user", "We need volunteer shifts for the fundraiser. Three weekends, two locations."],
      ["assistant", "Built a twelve-shift grid — two-hour blocks, Saturday and Sunday, three people per shift. That needs 36 sign-ups."],
      ["assistant", "Sign-ups are at 22 of 36. The Sunday afternoon blocks at the second location are the thin ones."],
    ],
  },
  {
    title: "Weekly meeting reminder",
    messages: [
      ["user", "Send the reminder for Monday's meeting."],
      ["assistant", "Drafted: Monday 7–8:30pm at the main hall. Ready to send to nineteen people."],
    ],
  },
];

__setSeedForTests(SAMPLE_CHATS);
