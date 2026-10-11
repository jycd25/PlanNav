import type { Commitment } from './types.js';
import type { Store } from './store.js';
import { addDays } from './time.js';

export interface ImportResult {
  /** Future events (within the horizon): what gets stored as commitments. */
  commitments: Commitment[];
  /** Every event from `lookbackDays` ago to the horizon, past ones included, for routine learning. */
  events: Array<{ title: string; start: string; end: string }>;
  skipped: number;
  notes: string[];
  /** Ids of items the feed says are cancelled. */
  cancelled: string[];
  /** X-WR-CALNAME or PRODID of the calendar, when present. */
  calendarName?: string;
}
export interface ParseOptions { now: Date; horizonDays?: number; lookbackDays?: number }

const OWN_UID = /@(plannav|dynamic-scheduler)$/; // own exports, including those made before the rename
const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITERATIONS = 20_000;

function unescapeText(s: string): string {
  // One pass, so an escaped backslash followed by "n" stays a backslash and an "n".
  return s.replace(/\\([\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

interface Prop { params: Record<string, string>; value: string }
type Props = Record<string, Prop[]>;

function parseProps(lines: string[]): Props {
  const props: Props = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const [name, ...paramParts] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    (props[name.toUpperCase()] ??= []).push({ params, value: line.slice(colon + 1) });
  }
  return props;
}
const first = (p: Props, name: string): Prop | undefined => p[name]?.[0];

interface ParsedTime { date: Date; utc: boolean }

/** iCalendar date-time. Zulu is UTC; floating or TZID values are taken as local time. 'date' for VALUE=DATE, null for junk. */
function parseDateTime(value: string | undefined, params: Record<string, string> = {}): ParsedTime | null | 'date' {
  if (value === undefined) return null;
  const v = value.trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) return 'date';
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(Number);
  const utc = Boolean(m[7]);
  const date = utc ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : { date, utc };
}

function parseDuration(v: string): number | null {
  const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [w, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5]].map((x) => Number(x ?? 0));
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Basic iCalendar format of a time, in the same convention (UTC or local) as the master event. */
function basic(d: Date, utc: boolean): string {
  return utc
    ? d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    : `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

interface Parts { y: number; m: number; d: number; h: number; mi: number; s: number }
function parts(d: Date, utc: boolean): Parts {
  return utc
    ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
    : { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
}
function make(p: Parts, utc: boolean): Date {
  return utc ? new Date(Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s)) : new Date(p.y, p.m, p.d, p.h, p.mi, p.s);
}
function weekday(d: Date, utc: boolean): number { return utc ? d.getUTCDay() : d.getDay(); }

interface Rule { freq: string; interval: number; byday: number[]; bymonthday: number[]; count: number | null; until: Date | null }

function parseRule(raw: string, start: ParsedTime): Rule | null {
  const rule: Record<string, string> = {};
  for (const part of raw.split(';')) { const eq = part.indexOf('='); if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1); }
  const freq = (rule.FREQ ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const interval = Math.max(1, Number(rule.INTERVAL ?? '1') || 1);
  const byday = rule.BYDAY
    ? [...new Set(rule.BYDAY.split(',').map((d) => BYDAY[d.trim().toUpperCase().slice(-2)]).filter((d): d is number => d !== undefined))].sort()
    : [];
  const bymonthday = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31) : [];
  const count = rule.COUNT ? Math.max(0, Number(rule.COUNT) || 0) : null;
  let until: Date | null = null;
  if (rule.UNTIL) {
    const u = rule.UNTIL.trim();
    if (/^\d{8}$/.test(u)) until = new Date(Number(u.slice(0, 4)), Number(u.slice(4, 6)) - 1, Number(u.slice(6, 8)), 23, 59, 59);
    else { const t = parseDateTime(u); if (t && t !== 'date') until = t.date; }
  }
  return { freq, interval, byday, bymonthday, count, until };
}

/** Occurrence starts of a rule, in order, from DTSTART up to `limit` (inclusive) or COUNT/UNTIL. */
function* occurrences(start: ParsedTime, rule: Rule, limit: Date): Generator<Date> {
  const utc = start.utc;
  const base = parts(start.date, utc);
  let produced = 0;
  let iterations = 0;
  const emit = function* (d: Date): Generator<Date, boolean> {
    if (d < start.date) return true;
    if (rule.until && d > rule.until) return false;
    if (d > limit) return false;
    if (rule.count !== null && produced >= rule.count) return false;
    produced += 1;
    yield d;
    return true;
  };
  if (rule.freq === 'DAILY') {
    for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval) {
      if (!(yield* emit(make({ ...base, d: base.d + k }, utc)))) return;
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byday.length ? rule.byday : [weekday(start.date, utc)];
    const wk = weekday(start.date, utc);
    const weekStartOffset = (wk - 1 + 7) % 7; // weeks start on Monday (RFC 5545 default WKST)
    for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval * 7) {
      for (const day of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
        const offset = ((day - 1 + 7) % 7) - weekStartOffset;
        const d = make({ ...base, d: base.d + k + offset }, utc);
        if (d < start.date) continue;
        if (!(yield* emit(d))) return;
      }
    }
  } else if (rule.freq === 'MONTHLY') {
    const monthDays = rule.bymonthday.length ? rule.bymonthday : [base.d];
    for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval) {
      for (const md of monthDays) {
        const d = make({ ...base, m: base.m + k, d: md }, utc);
        if (parts(d, utc).d !== md) continue; // month shorter than md
        if (d < start.date) continue;
        if (!(yield* emit(d))) return;
      }
    }
  } else {
    for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval) {
      const d = make({ ...base, y: base.y + k }, utc);
      if (parts(d, utc).d !== base.d) continue; // Feb 29
      if (!(yield* emit(d))) return;
    }
  }
}

interface RawEvent {
  uid: string; title: string; recurrenceId?: string; start: ParsedTime; end: Date; rrule?: string; exdates: number[];
}

export function parseIcs(text: string, opts: ParseOptions): ImportResult {
  const now = opts.now;
  const horizonEnd = addDays(now, opts.horizonDays ?? 90);
  const lookbackStart = addDays(now, -(opts.lookbackDays ?? 60));
  const result: ImportResult = { commitments: [], events: [], skipped: 0, notes: [], cancelled: [] };
  const skips: Record<string, string[]> = {};
  const skip = (reason: string, title: string) => { result.skipped += 1; (skips[reason] ??= []).push(title); };

  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const topLevel: string[] = [];
  const events: Props[] = [];
  let current: string[] | null = null;
  let depth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (current === null) {
      if (t === 'BEGIN:VEVENT') current = [];
      else if (t.startsWith('BEGIN:') || t.startsWith('END:')) { /* other components */ }
      else topLevel.push(line);
      continue;
    }
    if (t.startsWith('BEGIN:')) { depth += 1; continue; }
    if (t.startsWith('END:')) {
      if (depth > 0) { depth -= 1; continue; }
      if (t === 'END:VEVENT') { events.push(parseProps(current)); current = null; }
      continue;
    }
    if (depth === 0) current.push(line);
  }
  const top = parseProps(topLevel);
  const calName = first(top, 'X-WR-CALNAME')?.value.trim() || first(top, 'PRODID')?.value.trim();
  if (calName) result.calendarName = unescapeText(calName);

  // Pass 1: parse every event; separate masters from RECURRENCE-ID overrides.
  const masters: RawEvent[] = [];
  const overrides = new Map<string, RawEvent[]>();
  for (const p of events) {
    const uid = first(p, 'UID')?.value.trim() || `noid-${masters.length + result.skipped}`;
    const title = first(p, 'SUMMARY') ? unescapeText(first(p, 'SUMMARY')!.value).trim() || 'Untitled' : 'Untitled';
    const recurrenceId = first(p, 'RECURRENCE-ID')?.value.trim();
    const fullId = recurrenceId ? `${uid}#${recurrenceId}` : uid;
    if (OWN_UID.test(uid)) { skip('exported by this app', title); continue; }
    if ((first(p, 'STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED') { result.cancelled.push(`ics:${fullId}`); skip('cancelled', title); continue; }
    const startProp = first(p, 'DTSTART');
    const start = parseDateTime(startProp?.value, startProp?.params);
    if (start === 'date') { skip('all-day', title); continue; }
    if (!start) { skip('no usable start time', title); continue; }
    let end: Date | null = null;
    const endProp = first(p, 'DTEND');
    const endRaw = parseDateTime(endProp?.value, endProp?.params);
    if (endRaw && endRaw !== 'date') end = endRaw.date;
    else if (first(p, 'DURATION')) { const ms = parseDuration(first(p, 'DURATION')!.value); if (ms !== null) end = new Date(start.date.getTime() + ms); }
    if (!end || end <= start.date) { skip('no usable end time', title); continue; }
    const exdates: number[] = [];
    for (const ex of p.EXDATE ?? []) {
      for (const v of ex.value.split(',')) { const t = parseDateTime(v, ex.params); if (t && t !== 'date') exdates.push(t.date.getTime()); }
    }
    const raw: RawEvent = { uid, title, recurrenceId, start, end, rrule: first(p, 'RRULE')?.value, exdates };
    if (recurrenceId) (overrides.get(uid) ?? overrides.set(uid, []).get(uid)!).push(raw);
    else masters.push(raw);
  }

  const push = (id: string, title: string, start: Date, end: Date) => {
    if (end <= lookbackStart || start > horizonEnd) return false;
    result.events.push({ title, start: start.toISOString(), end: end.toISOString() });
    if (end > now) result.commitments.push({ id: `ics:${id}`, title, start: start.toISOString(), end: end.toISOString() });
    return true;
  };

  // Pass 2: one-off events and expanded series; overrides replace the occurrence they name.
  const unsupported: string[] = [];
  for (const ev of masters) {
    if (!ev.rrule) {
      if (ev.end <= lookbackStart) skip('already over', ev.title);
      else if (ev.start.date > horizonEnd) skip('more than 90 days ahead', ev.title);
      else push(ev.uid, ev.title, ev.start.date, ev.end);
      continue;
    }
    const rule = parseRule(ev.rrule, ev.start);
    if (!rule) { skip('unsupported repeat rule', ev.title); unsupported.push(ev.title); continue; }
    const overridden = new Set<number>();
    for (const o of overrides.get(ev.uid) ?? []) {
      const t = parseDateTime(o.recurrenceId);
      if (t && t !== 'date') overridden.add(t.date.getTime());
    }
    const duration = ev.end.getTime() - ev.start.date.getTime();
    let any = false;
    for (const occ of occurrences(ev.start, rule, horizonEnd)) {
      const ms = occ.getTime();
      if (ev.exdates.includes(ms) || overridden.has(ms)) continue;
      const end = new Date(ms + duration);
      if (end <= lookbackStart) continue;
      any = push(`${ev.uid}#${basic(occ, ev.start.utc)}`, ev.title, occ, end) || any;
    }
    if (!any) skip('repeat already ended or outside the horizon', ev.title);
  }
  for (const list of overrides.values()) {
    for (const o of list) {
      if (o.end <= lookbackStart) { skip('already over', o.title); continue; }
      if (o.start.date > horizonEnd) { skip('more than 90 days ahead', o.title); continue; }
      push(`${o.uid}#${o.recurrenceId}`, o.title, o.start.date, o.end);
    }
  }
  result.commitments.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  result.events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));

  for (const [reason, titles] of Object.entries(skips)) {
    const shown = titles.slice(0, 5).join(', ') + (titles.length > 5 ? ', …' : '');
    result.notes.push(`Skipped ${titles.length} ${reason} event${titles.length === 1 ? '' : 's'}: ${shown}`);
  }
  return result;
}

export interface ImportOutcome extends ImportResult {
  /** Ids removed because the feed cancelled them or no longer lists them. */
  removed: string[];
  /** The refresh key used: the URL, or `file:<calendar name>`. */
  source: string;
}

/**
 * Parse and store. Ids derive from the ICS UID, so a re-import replaces earlier copies, and items from the
 * previous import of the same source (URL, or the calendar's name for files) that are absent now are removed.
 */
export function importIcs(store: Store, text: string, now: Date, source?: string): ImportOutcome {
  const r = parseIcs(text, { now });
  const key = source ?? `file:${r.calendarName ?? 'unnamed'}`;
  const removed = new Set<string>();
  const removeId = (id: string) => { store.deleteCommitment(id); removed.add(id); };
  for (const id of r.cancelled) removeId(id);
  const ids = r.commitments.map((c) => c.id);
  const present = new Set(ids);
  for (const old of store.getImportRecord(key)?.ids ?? []) if (!present.has(old)) removeId(old);
  store.setImportRecord(key, { ids, events: r.events.slice(0, 5000), importedAt: now.toISOString() });
  for (const c of r.commitments) store.addCommitment(c);
  return { ...r, removed: [...removed], source: key };
}
