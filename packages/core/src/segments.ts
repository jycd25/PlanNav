import type { Interval, Settings, Task, TaskSegment } from './types.js';
import { atTime, startOfDay } from './time.js';

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const SEGMENT_WORDS: Array<[Exclude<TaskSegment, 'any'>, RegExp]> = [
  ['morning', /\b(morning|mornings|breakfast|dawn|sunrise)\b/i],
  ['afternoon', /\b(afternoon|afternoons|lunch|midday|noon)\b/i],
  ['evening', /\b(evening|evenings|night|nights|tonight|bedtime|dusk)\b/i],
];
/** The part of day a task name says it belongs to ("Morning learning" → morning), or undefined when the name does not say. */
export function inferSegment(name: string): Exclude<TaskSegment, 'any'> | undefined {
  for (const [segment, re] of SEGMENT_WORDS) if (re.test(name)) return segment;
  return undefined;
}

export function segmentOf(d: Date, settings: Settings): Exclude<TaskSegment, 'any'> {
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes < toMin(settings.segments.morningEnd)) return 'morning';
  if (minutes < toMin(settings.segments.afternoonEnd)) return 'afternoon';
  return 'evening';
}

/** A free interval, cut at a segment edge when `until` is set: the free time runs on to `until` past the edge at `end`. */
export interface Slot extends Interval { until?: Date }

/** Split intervals so that none crosses a segment boundary; a piece cut at an edge keeps where the free time really ends. */
export function splitBySegments(free: Interval[], settings: Settings): Slot[] {
  const out: Slot[] = [];
  for (const f of free) {
    const day = startOfDay(f.start);
    const cuts = [atTime(day, settings.segments.morningEnd), atTime(day, settings.segments.afternoonEnd)];
    let cursor = f.start;
    for (const cut of cuts) {
      if (cut > cursor && cut < f.end) { out.push({ start: cursor, end: cut, until: f.end }); cursor = cut; }
    }
    if (cursor < f.end) out.push({ start: cursor, end: f.end });
  }
  return out;
}

export function prefers(task: Task, slot: Interval, settings: Settings): boolean {
  const pref = task.preferredSegment ?? 'any';
  return pref !== 'any' && segmentOf(slot.start, settings) === pref;
}

export function isFlexible(task: Task): boolean { return (task.preferredSegment ?? 'any') === 'any'; }
