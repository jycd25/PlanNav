# Release log

## 0.2.0 — 2026-10-12

### PlanNav is now RerouteDay

Same app, new name. The package is `rerouteday`, so `npx rerouteday` starts it; the UI, the assistant and the exports say RerouteDay. The old `plannav` package is deprecated and points here.

Nothing to migrate: an existing `~/.plannav/data.sqlite` (or `~/.dynamic-scheduler/data.sqlite`) keeps being used until `~/.rerouteday/data.sqlite` exists, `PLANNAV_DB_PATH` and `PLANNAV_OPEN` are still honored next to the new `REROUTEDAY_DB_PATH` and `REROUTEDAY_OPEN`, and calendar files exported under the old names are still recognised as your own on import.

Everything in 0.1.2 below is included; 0.1.2 was never published to npm under the old name.

## 0.1.2 — 2026-10-12

### Starting late keeps your breaks

"I'm starting now" used to pack the rest of the day back to back from the current minute: the block in progress was cut short and blank time such as lunch disappeared. Now every block from the one in progress on moves later by how late you are, breaks included, and nothing moves earlier. When that would end the day past your last slot, the assistant asks whether to waive the breaks (they shrink to absorb the delay, the day ends on time) or keep them and end later. What still does not fit is dropped, lowest priority first, and named.

### The assistant remembers how you like changes

A memory note, yours to read, edit or clear in Settings → Memory. After you answer a question such as "waive the breaks or end later?", the assistant asks once whether to remember your answer and applies it without asking next time.

### Fixes

- Finishing a block you never started now counts the time from its planned start, capped at its length, instead of recording 0 minutes.
- Calendar import refuses IPv4-mapped IPv6 addresses that point at private hosts, in every spelling.
- A block from an earlier day that you start today keeps its running clock.
- Imported events: escaped backslashes read correctly, and a single cancelled occurrence of a series stays out.
- Untitled calendar events are no longer assigned to a task when building a baseline.
- Times like "25:00" are refused instead of rolling into the next day; an empty task name no longer matches your only task; days can be given as numbers everywhere the tool descriptions say so.
- Removing a commitment with an unknown id says so instead of reporting success.
- A corrupt settings row no longer prevents the app from opening; it is replaced on the next save.
- The chat no longer shows a spinning tool row when a result arrives before its call, and the Settings dialog shows an error instead of "Loading…" when the settings cannot be fetched.
- Dates in two assistant summaries were printed in UTC.

Under the hood: 958 new edge-case and integration tests, including the first UI component tests.

## 0.1.1 — 2026-10-11

- `rerouteday` opens the app in your default browser once the server is up. `--no-open` or `REROUTEDAY_OPEN=0` keeps the old behavior; nothing opens under `CI`.

## 0.1.0 — 2026-10-11

First public release.

RerouteDay is a local-first calendar that plans your week from a baseline and adjusts the day when life interrupts. You keep one template week; every real week starts as a copy of it. When the day goes off plan, you say so in a chat box next to the calendar, and the assistant adjusts it through tested scheduling tools and tells you what changed.

### Install

```bash
npx rerouteday
```

Needs Node 22.13 or newer and either the Claude Code CLI or an Anthropic API key for the assistant.

### Highlights

- Baseline week, applied to any week with one click or one sentence
- Day adjustments in plain words: starting late, something came up, didn't finish
- Direct editing: drag, resize, mark done or skipped, track actual time, leave notes
- Import from Apple Calendar or Google Calendar, export as `.ics` or JSON
- Everything stays on your machine in a SQLite file

See the [README](README.md) for the full feature list and screenshots.

### Notes

- The server listens on localhost only and has no authentication.
- The calendar works without an assistant backend; the chat does not.

Licensed under Apache-2.0.
