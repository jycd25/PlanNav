# CLAUDE.md

Guidance for Claude Code when working in this repository. The sections below are the project reference: what the product does, how to run it, how the assistant backends are chosen, and how the packages are laid out. Read it before changing scheduling logic, the assistant prompt, or the API.

---

# PlanNav

A local-first calendar built on your baseline week: each week is a copy of it, and the assistant adjusts the day when life interrupts. You talk to it in a chat box next to the calendar; the assistant changes the calendar only through tested scheduling functions.

The problem it addresses, the decisions behind it, and what is done so far are tracked in [docs/problem-statement.md](docs/problem-statement.md). The tech stack, the packages, the data model and the development approach are in [docs/architecture.md](docs/architecture.md). The two experiment loops that shaped the planner and the assistant are in [docs/experiments/](docs/experiments/): `scheduler-optimize` (planner friction) and `tools-first` (prompt rules against tools and memory; run on branch `tools/oct9`, not merged).

## What it does

- Your baseline week is the source of truth: a template week of task slots and busy slots (lunch, standup), saved whole and versioned. Free time is simply blank. Every real week is a copy of it, adjusted day by day.
- The first run is one line: import a past week as your baseline (Settings → Import with "Use as my baseline", or a Google Calendar "secret address in iCal format" in the chat: "use it as my baseline"), draw the week on the Baseline tab, or, with no calendar to start from, add your tasks and hours and ask for a suggestion ("Suggest a schedule"), then keep it as your baseline. The import keeps your calendar exactly as it was: what repeats becomes a slot, each title a task, one-offs are left out.
- The week is the baseline applied: "apply my baseline" (or Apply on the Baseline tab) lays it on this week or next, slot for slot; a re-apply keeps what you moved and names any slot it could not lay.
- "I'm starting now" (or "I'm late") shifts the rest of the day to start now, in order; what no longer fits before the day's last slot is dropped, lowest priority first, and named.
- "Busy from 14:00 to 15:00" carves the time out and pushes what it covered, and what follows, later in order; blank time absorbs the push.
- "I didn't finish X" carries X's unfinished minutes to the next blank gap today, else to its next slot this week, else says there is no room.
- "This is my baseline" saves the current week as a new baseline version; the Baseline tab lists the versions and reverts to any of them. Editing the template itself happens on the Baseline tab.
- Single changes are edits: "move X to 10", drag a block, drag its bottom edge to resize, click it to mark it done or skipped, Copy it and paste with ⌘V where the pointer is (or from the right-click menu). "I finished X" records completion; blocks left unmarked become `missed`, so the data for future suggestions is collected from day one.
- Click a block and press Start when you begin (early, late, or on a block planned for another day: the block stays put and the actual start is recorded), Pause when interrupted, Finish when done, Reset to undo; or type the minutes. "I spent 45 minutes on reading" works in chat too.
- Starter bubbles above the chat box offer the next sensible thing to say for where you are (set up, apply the baseline, start the day, a busy stretch, what you did not finish, a note on the current block); click one to prefill it, edit if you like, Enter sends.
- Leave a note on any block for the assistant ("did it, not focused", "Leetcode and Reading share this slot; Reading got done"): it stays with the block, the assistant sees the last two weeks of notes when it plans or adjusts, and "note on Leetcode: not focused" works in chat too.
- Import commitments from an .ics file (Apple Calendar or Google Calendar export) or a Google Calendar secret iCal address, re-fetchable any time; export everything as `.ics` (imports into Google Calendar and Apple Calendar) or JSON.

## Requirements

- Node 22.13 or newer (uses the built-in `node:sqlite`). Developed on Node 26.
- pnpm.
- One of: the Claude Code CLI installed and logged in (`claude`), or an Anthropic API key.

## Run

```bash
pnpm install
pnpm dev        # API server on http://localhost:4820, UI on http://localhost:5173
```

Production build, served from one port:

```bash
pnpm start      # builds the UI, serves it with the API on http://localhost:4820
```

Data lives in `~/.plannav/data.sqlite` (an existing `~/.dynamic-scheduler/data.sqlite` from before the rename is still used). Override with `PLANNAV_DB_PATH=/path/to/file.sqlite`. Change the port with `PORT=…`.

## Choosing the assistant backend

Open **Settings** in the toolbar.

- **Claude Code subscription** (default): the server runs `claude -p` headlessly on your machine and hands it an MCP server that exposes the scheduling tools. Nothing to configure if `claude` is on your PATH.
- **Anthropic API key**: paste your key. It is stored in the local database and sent only to the Anthropic API. Default model is `claude-opus-5-5`.

Both backends use the same tool definitions and the same system prompt.

## Layout

```
packages/core     scheduling logic, budgets, stats, iCalendar export, tool definitions (pure, tested)
packages/server   Hono API, SQLite store, assistant providers, MCP server, static serving
packages/web      Vite + React calendar and chat panel
packages/bench    friction benchmark for the planner
packages/plannav  the npm package: bundles server, core and the built UI into `npx plannav`
docs/             problem statement, planner rules, experiment loop
```

## Commands

```bash
pnpm test         # all packages
pnpm typecheck
pnpm build
```
