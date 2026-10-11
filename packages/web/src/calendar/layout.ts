export const HOUR_PX = 48;
export const DAY_MIN = 24 * 60;

export const minutesToPx = (min: number) => (min / 60) * HOUR_PX;
export const pxToMinutes = (px: number) => (px / HOUR_PX) * 60;
export const snap = (min: number, slot: number) => Math.round(min / slot) * slot;

export interface LayoutItem { id: string; start: string; end: string }
export interface Positioned { id: string; top: number; height: number; col: number; cols: number; startMin: number; endMin: number }

function minutesIntoDay(d: Date, day: Date): number { return (d.getTime() - day.getTime()) / 60_000; }

/** Clip items to `day` (a local midnight), compute pixel positions, and assign columns to overlapping items. */
export function layoutDay(items: LayoutItem[], day: Date): Positioned[] {
  const clipped = items
    .map((it) => {
      const s = Math.max(0, minutesIntoDay(new Date(it.start), day));
      const e = Math.min(DAY_MIN, minutesIntoDay(new Date(it.end), day));
      return { id: it.id, startMin: s, endMin: e };
    })
    .filter((it) => it.endMin > it.startMin)
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Greedy column assignment within clusters of overlapping items.
  const out: Positioned[] = [];
  let cluster: Positioned[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = cluster.reduce((m, p) => Math.max(m, p.col + 1), 0);
    for (const p of cluster) p.cols = cols;
    out.push(...cluster);
    cluster = [];
  };
  for (const it of clipped) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    const colEnds: number[] = [];
    for (const p of cluster) colEnds[p.col] = Math.max(colEnds[p.col] ?? 0, p.endMin);
    let col = 0;
    while ((colEnds[col] ?? 0) > it.startMin) col += 1;
    cluster.push({ id: it.id, top: minutesToPx(it.startMin), height: minutesToPx(it.endMin - it.startMin), col, cols: 1, startMin: it.startMin, endMin: it.endMin });
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export function timeRangeFromPx(day: Date, topPx: number, heightPx: number, slot: number): { start: Date; end: Date } {
  let startMin = snap(Math.max(0, pxToMinutes(topPx)), slot);
  let endMin = snap(Math.max(0, pxToMinutes(topPx + heightPx)), slot);
  if (endMin - startMin < slot) endMin = startMin + slot;
  if (endMin > DAY_MIN) { endMin = DAY_MIN; startMin = Math.min(startMin, DAY_MIN - slot); }
  const start = new Date(day); start.setMinutes(startMin);
  const end = new Date(day); end.setMinutes(endMin);
  return { start, end };
}

/** Time range from a drag on empty calendar space between two pixel offsets (either order), at least `minMinutes` long. */
export function rangeFromDrag(day: Date, y0: number, y1: number, slot: number, minMinutes: number): { start: Date; end: Date } {
  const top = Math.min(y0, y1);
  const height = Math.max(Math.abs(y1 - y0), minutesToPx(minMinutes));
  const r = timeRangeFromPx(day, top, height, slot);
  if (r.end.getTime() - r.start.getTime() < minMinutes * 60_000) r.end = new Date(r.start.getTime() + minMinutes * 60_000);
  return r;
}

/** Range for a single click on empty space: the slot under the pointer, lasting the minimum block length, kept inside the day. */
export function rangeFromClick(day: Date, y: number, slot: number, minMinutes: number): { start: Date; end: Date } {
  let startMin = Math.floor(Math.max(0, pxToMinutes(y)) / slot) * slot;
  let endMin = startMin + minMinutes;
  if (endMin > DAY_MIN) { endMin = DAY_MIN; startMin = Math.max(0, DAY_MIN - minMinutes); }
  const start = new Date(day); start.setMinutes(startMin);
  const end = new Date(day); end.setMinutes(endMin);
  return { start, end };
}

/** Start and Finish are offered on any block of today, early or late (the core refuses another day's block). */
export function startsToday(blockStart: string, now: Date): boolean {
  const s = new Date(blockStart);
  return s.getFullYear() === now.getFullYear() && s.getMonth() === now.getMonth() && s.getDate() === now.getDate();
}
