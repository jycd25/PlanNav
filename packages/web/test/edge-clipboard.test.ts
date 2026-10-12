import { describe, it, expect } from 'vitest';
import { clipFromBlock, pasteRange, type BlockClip } from '../src/calendar/clipboard.js';

const at = (h: number, m = 0, d = 7) => new Date(2026, 9, d, h, m);
const clip = (minutes: number): BlockClip => ({ taskId: 't1', taskName: 'Leetcode', minutes });

describe('clipFromBlock', () => {
  it('rounds the length to whole minutes and copies a zero-length block as 0 minutes', () => {
    expect(clipFromBlock({ taskId: 't1', taskName: 'Leetcode', start: '2026-10-07T09:00:00.000Z', end: '2026-10-07T09:29:30.000Z' }).minutes).toBe(30);
    expect(clipFromBlock({ taskId: 't1', taskName: 'Leetcode', start: '2026-10-07T09:00:00.000Z', end: '2026-10-07T09:29:29.000Z' }).minutes).toBe(29);
    expect(clipFromBlock({ taskId: 't1', taskName: 'Leetcode', start: at(9).toISOString(), end: at(9).toISOString() })).toEqual({ taskId: 't1', taskName: 'Leetcode', minutes: 0 });
  });
  it('an inverted block copies a negative length (the caller never produces one)', () => {
    expect(clipFromBlock({ taskId: 't1', taskName: 'Leetcode', start: at(10).toISOString(), end: at(9).toISOString() }).minutes).toBe(-60);
  });
  it('keeps the task identity exactly and nothing else', () => {
    const c = clipFromBlock({ taskId: 'abc', taskName: 'Déjà vu', start: at(9).toISOString(), end: at(9, 45).toISOString() });
    expect(Object.keys(c).sort()).toEqual(['minutes', 'taskId', 'taskName']);
    expect(c).toEqual({ taskId: 'abc', taskName: 'Déjà vu', minutes: 45 });
  });
});

describe('pasteRange: at the end of the day', () => {
  it('a paste that would end past midnight is pulled back onto the grid so it ends at 24:00', () => {
    expect(pasteRange(clip(90), at(0), 23 * 60 + 30, 15)).toEqual({ start: at(22, 30), end: at(0, 0, 8) });
  });
  it('a clip of exactly 24 hours pasted anywhere fills the day', () => {
    expect(pasteRange(clip(1440), at(0), 600, 15)).toEqual({ start: at(0), end: at(0, 0, 8) });
  });
  it('a clip longer than a day starts at midnight and runs into the next day', () => {
    expect(pasteRange(clip(1500), at(0), 600, 15)).toEqual({ start: at(0), end: at(1, 0, 8) });
  });
  it('a pointer below the grid (past 24:00) pastes the last slots of the day', () => {
    expect(pasteRange(clip(30), at(0), 1500, 15)).toEqual({ start: at(23, 30), end: at(0, 0, 8) });
  });
  it('a slot that does not divide the day evenly still ends by midnight', () => {
    expect(pasteRange(clip(60), at(0), 1430, 25)).toEqual({ start: at(22, 55), end: at(23, 55) });
  });
});

describe('pasteRange: across days and odd inputs', () => {
  it('lands on the calendar day of the given date whatever its time of day', () => {
    expect(pasteRange(clip(60), at(23, 59, 9), 540, 15)).toEqual({ start: at(9, 0, 9), end: at(10, 0, 9) });
    expect(pasteRange(clip(60), at(0, 0, 9), 540, 15)).toEqual({ start: at(9, 0, 9), end: at(10, 0, 9) });
  });
  it('a negative pointer offset pastes at 00:00', () => {
    expect(pasteRange(clip(45), at(0), -30, 15)).toEqual({ start: at(0), end: at(0, 45) });
  });
  it('fractional minutes floor to the slot', () => {
    expect(pasteRange(clip(30), at(0), 614.7, 15)).toEqual({ start: at(10), end: at(10, 30) });
    expect(pasteRange(clip(30), at(0), 614.7, 5)).toEqual({ start: at(10, 10), end: at(10, 40) });
  });
  it('a slot of 0 or less means a one-minute grid', () => {
    expect(pasteRange(clip(30), at(0), 614, 0)).toEqual({ start: at(10, 14), end: at(10, 44) });
    expect(pasteRange(clip(30), at(0), 614, -5)).toEqual({ start: at(10, 14), end: at(10, 44) });
  });
  it('a zero-length clip pastes an empty range at the slot', () => {
    expect(pasteRange(clip(0), at(0), 600, 15)).toEqual({ start: at(10), end: at(10) });
  });
  it('does not mutate the day it is given', () => {
    const d = at(13, 37);
    pasteRange(clip(30), d, 600, 15);
    expect(d).toEqual(at(13, 37));
  });
});
