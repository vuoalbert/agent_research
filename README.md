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

## Stack

Next.js 16 (App Router, Turbopack, `src/`) · React 19 · Tailwind v4 ·
shadcn **base-nova** style on **Base UI** · lucide-react · Motion ·
Vitest + jsdom · Playwright (layout test).

## Layout

| Path | What it is |
|---|---|
| `src/app/page.tsx` | `/` — the shell with the AI pane |
| `src/app/api/chat/route.ts` | streams one Claude turn as server-sent events |
| `src/components/shell.tsx` | top bar, icon rail, sidebar, content card |
| `src/components/ai/*` | composer, thread, home cards, plus menu |
| `src/components/sidebars/ai-sidebar.tsx` | chat list and its context menus |
| `src/lib/agent-store.ts` | local chat store (`localStorage`) |
| `src/components/ui/*` | shadcn / Base UI primitives |
