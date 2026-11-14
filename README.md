# agent_research

A chat interface for agent research: the AI tab — a centered composer, chat
list and conversation thread — streamed from Claude through the Claude Agent
SDK, using this machine's own Claude login (no API key).

## Quick start

```bash
npm install
npm run dev      # http://localhost:3500
npm test         # unit tests (Vitest + jsdom)
npm run build
```

`/api/chat` runs the Claude Agent SDK on the Node runtime against the local
`claude` login, so it only works on a machine that is signed in to Claude.

## Visualize

Claude can commission an interactive isometric figure, built in the
background (15–60 min) by a second Claude agent with the
[anatomy](https://github.com/wheresryan22/anatomy) skill, and shown in the
**Visualize** tab. There is one figure at a time: a research turn always ends
with one (unless a figure is still building), and an explicit "visualize …"
replaces the current one.

```bash
npm run setup:visualize   # once: the pinned skill, minus its publish script, into .visualize/
```

The background agent runs locked down (macOS): Bash in Claude Code's sandbox
(writes only in its job folder, no network, secrets unreadable), a PreToolUse
guard (no publishing, git remotes, gh, network tools or installs), headless
Chrome checks under their own seatbelt profile, and the finished page served
into a script-only sandboxed iframe with a no-network CSP. See
`src/server/visualize/`.

## Stack

Next.js 16 (App Router, Turbopack, `src/`) · React 19 · Tailwind v4 ·
shadcn **base-nova** style on **Base UI** · lucide-react · Motion ·
Vitest + jsdom · Playwright (layout test).

## Layout

| Path | What it is |
|---|---|
| `src/app/page.tsx` | `/` — the shell with the AI pane |
| `src/app/api/chat/route.ts` | streams one Claude turn as server-sent events |
| `src/app/api/visualize/*` | the current figure, its progress, Stop, and the page |
| `src/server/visualize/*` | the figure runner, the background agent and its guard |
| `src/components/shell.tsx` | top bar, icon rail, sidebar, content card |
| `src/components/ai/*` | composer, thread, home cards, plus menu |
| `src/components/sidebars/ai-sidebar.tsx` | chat list and its context menus |
| `src/lib/agent-store.ts` | local chat store (`localStorage`) |
| `src/components/ui/*` | shadcn / Base UI primitives |
