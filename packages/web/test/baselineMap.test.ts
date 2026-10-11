import { describe, it, expect } from 'vitest';
import type { Baseline, BaselineSlot } from '@ds/core';
import { calendarFromSlots, describeApply, moveSlot, newerSavedVersion, referenceWeek, slotFromRange, slotIndex, slotRange, syncDraft, taskSlotSummary, type Draft } from '../src/baseline/map.js';

const at = (y: number, mo: number, d: number, h = 0, m = 0) => new Date(y, mo, d, h, m);

describe('referenceWeek', () => {
  it('is the week of Monday 2001-01-01, starting on the configured weekday', () => {
    expect(referenceWeek(1)).toEqual([1, 2, 3, 4, 5, 6, 7].map((d) => at(2001, 0, d)));
    const sun = referenceWeek(0);
    expect(sun[0]).toEqual(at(2000, 11, 31));
    expect(sun.map((d) => d.getDay())).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(referenceWeek(6).map((d) => d.getDay())).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });
});

describe('slotRange (weekday slot -> synthetic dates)', () => {
  it('places a slot on the reference date of its weekday', () => {
    const week = referenceWeek(1);
    expect(slotRange({ day: 3, start: '09:30', end: '11:00' }, week)).toEqual({ start: at(2001, 0, 3, 9, 30), end: at(2001, 0, 3, 11) });
    expect(slotRange({ day: 0, start: '08:00', end: '09:00' }, week)).toEqual({ start: at(2001, 0, 7, 8), end: at(2001, 0, 7, 9) });
    expect(slotRange({ day: 0, start: '08:00', end: '09:00' }, referenceWeek(0))).toEqual({ start: at(2000, 11, 31, 8), end: at(2000, 11, 31, 9) });
  });
  it('reads an end of 24:00 as the next midnight', () => {
    expect(slotRange({ day: 5, start: '22:00', end: '24:00' }, referenceWeek(1))).toEqual({ start: at(2001, 0, 5, 22), end: at(2001, 0, 6) });
  });
});

describe('slotFromRange (synthetic dates -> weekday slot)', () => {
  it('reads the weekday and local HH:MM', () => {
    expect(slotFromRange(at(2001, 0, 3, 9, 30), at(2001, 0, 3, 11))).toEqual({ day: 3, start: '09:30', end: '11:00' });
    expect(slotFromRange(at(2000, 11, 31, 8), at(2000, 11, 31, 8, 45))).toEqual({ day: 0, start: '08:00', end: '08:45' });
  });
  it('writes an end at the next midnight as 24:00', () => {
    expect(slotFromRange(at(2001, 0, 5, 22), at(2001, 0, 6))).toEqual({ day: 5, start: '22:00', end: '24:00' });
  });
  it('rejects a slot crossing midnight, and an empty or inverted one', () => {
    expect(slotFromRange(at(2001, 0, 3, 23), at(2001, 0, 4, 1))).toBeNull();
    expect(slotFromRange(at(2001, 0, 3, 23), at(2001, 0, 4, 0, 15))).toBeNull();
    expect(slotFromRange(at(2001, 0, 3, 9), at(2001, 0, 3, 9))).toBeNull();
    expect(slotFromRange(at(2001, 0, 3, 10), at(2001, 0, 3, 9))).toBeNull();
  });
  it('round-trips every weekday through the synthetic week, for any week start', () => {
    for (const ws of [0, 1, 6]) {
      const week = referenceWeek(ws);
      for (let day = 0; day < 7; day++) {
        for (const [start, end] of [['00:00', '00:30'], ['09:15', '17:45'], ['23:30', '24:00']]) {
          const r = slotRange({ day, start, end }, week);
          expect(slotFromRange(r.start, r.end)).toEqual({ day, start, end });
        }
      }
    }
  });
});

const slots: BaselineSlot[] = [
  { day: 1, start: '09:00', end: '10:30', kind: 'task', taskId: 't1' },
  { day: 1, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' },
  { day: 2, start: '20:00', end: '24:00', kind: 'task', taskId: 'gone' },
];

describe('calendarFromSlots', () => {
  it('draws task slots as blocks and busy slots as commitments, ids naming the slot index', () => {
    const week = referenceWeek(1);
    const { blocks, commitments } = calendarFromSlots(slots, week, new Map([['t1', 'Leetcode']]));
    expect(blocks.map((b) => [b.id, b.taskId, b.taskName, b.start, b.end, b.status])).toEqual([
      ['slot:0', 't1', 'Leetcode', at(2001, 0, 1, 9).toISOString(), at(2001, 0, 1, 10, 30).toISOString(), 'pending'],
      ['slot:2', 'gone', 'Unknown task', at(2001, 0, 2, 20).toISOString(), at(2001, 0, 3).toISOString(), 'pending'],
    ]);
    expect(commitments).toEqual([{ id: 'slot:1', title: 'Lunch', start: at(2001, 0, 1, 12).toISOString(), end: at(2001, 0, 1, 13).toISOString() }]);
    expect(blocks.map((b) => slotIndex(b.id))).toEqual([0, 2]);
    expect(slotIndex('rec:x')).toBeNull();
  });
});

describe('moveSlot', () => {
  it('moves a slot to a new weekday and time, keeping its kind, task and title', () => {
    const next = moveSlot(slots, 'slot:1', at(2001, 0, 4, 12, 30), at(2001, 0, 4, 13, 15))!;
    expect(next[1]).toEqual({ day: 4, start: '12:30', end: '13:15', kind: 'busy', title: 'Lunch' });
    expect(next[0]).toBe(slots[0]);
    expect(slots[1].day).toBe(1); // the input is not mutated
  });
  it('refuses a move past midnight or of an unknown id', () => {
    expect(moveSlot(slots, 'slot:0', at(2001, 0, 1, 23), at(2001, 0, 2, 1))).toBeNull();
    expect(moveSlot(slots, 'slot:9', at(2001, 0, 1, 9), at(2001, 0, 1, 10))).toBeNull();
  });
});

describe('taskSlotSummary', () => {
  it('sums a task\'s weekly minutes and takes its most common slot length as the sitting', () => {
    const s: BaselineSlot[] = [
      { day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' },
      { day: 2, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' },
      { day: 3, start: '09:00', end: '11:00', kind: 'task', taskId: 'a' },
      { day: 3, start: '20:00', end: '24:00', kind: 'task', taskId: 'b' },
      { day: 4, start: '09:00', end: '10:00', kind: 'busy', title: 'a' },
    ];
    expect(taskSlotSummary(s, 'a')).toEqual({ weeklyMinutes: 240, sessionMinutes: 60, slots: 3, partOfDay: 'morning' });
    expect(taskSlotSummary(s, 'b')).toEqual({ weeklyMinutes: 240, sessionMinutes: 240, slots: 1, partOfDay: 'evening' });
    expect(taskSlotSummary(s, 'none')).toEqual({ weeklyMinutes: 0, sessionMinutes: 0, slots: 0, partOfDay: null });
  });
  it('names the part of day the slots start in (before 12:00 morning, before 17:00 afternoon), or varies', () => {
    const at = (start: string): BaselineSlot => ({ day: 1, start, end: '23:00', kind: 'task', taskId: 'x' });
    expect(taskSlotSummary([at('12:00'), at('16:45')], 'x').partOfDay).toBe('afternoon');
    expect(taskSlotSummary([at('11:59'), at('17:00')], 'x').partOfDay).toBe('varies');
  });
});

describe('describeApply', () => {
  it('says what an apply created, replaced and skipped, naming each skipped slot', () => {
    const names = new Map([['t1', 'Leetcode']]);
    const text = describeApply({
      created: [{}, {}, {}], commitments: [{}], replaced: 2,
      skipped: [{ slot: { day: 3, start: '09:00', end: '10:00', kind: 'task', taskId: 't1' }, reason: 'under a commitment' }],
    }, names);
    expect(text).toBe('3 blocks created, 1 busy slot, 2 replaced, 1 skipped (Leetcode Wed 09:00–10:00: under a commitment).');
    expect(describeApply({ created: [{}], commitments: [], replaced: 0, skipped: [] }, names)).toBe('1 block created, 0 replaced, 0 skipped.');
  });
});

describe('syncDraft and newerSavedVersion', () => {
  const v = (version: number, slots: BaselineSlot[] = []): Baseline => ({ version, savedAt: '', slots });
  const one: BaselineSlot[] = [{ day: 1, start: '09:00', end: '10:00', kind: 'busy', title: 'Gym' }];
  const two: BaselineSlot[] = [{ day: 2, start: '09:00', end: '10:00', kind: 'busy', title: 'Run' }];

  it('loads a newer saved version into a clean draft', () => {
    const clean: Draft = { slots: [], dirty: false, baseVersion: 0 };
    expect(syncDraft(clean, v(1, one))).toEqual({ slots: one, dirty: false, baseVersion: 1 });
    expect(syncDraft({ slots: one, dirty: false, baseVersion: 1 }, null)).toEqual({ slots: [], dirty: false, baseVersion: 0 });
  });
  it('keeps the same draft object when nothing changed, so React does not re-render', () => {
    const d: Draft = { slots: one, dirty: false, baseVersion: 1 };
    expect(syncDraft(d, v(1, one))).toBe(d);
  });
  it('never overwrites unsaved edits; it reports the newer version instead', () => {
    const dirty: Draft = { slots: two, dirty: true, baseVersion: 1 };
    expect(syncDraft(dirty, v(2, one))).toBe(dirty);
    expect(newerSavedVersion(dirty, v(2, one))).toBe(2);
    expect(newerSavedVersion(dirty, v(1, one))).toBeNull();
    expect(newerSavedVersion({ ...dirty, dirty: false }, v(2, one))).toBeNull();
    expect(newerSavedVersion(dirty, null)).toBeNull();
  });
});
