import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { createBlock, findTaskBlock, markBlock, materializeMissed, moveBlock } from '../src/mark.js';
import type { Block } from '../src/types.js';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const block = (id: string, start: Date, end: Date, status: Block['status'] = 'pending'): Block => ({
  id, taskId: 't', start: start.toISOString(), end: end.toISOString(), status, createdAt: start.toISOString(), statusChangedAt: null,
});

describe('markBlock', () => {
  it('sets status and timestamp, and is idempotent', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('b', d(9), d(10))]);
    const first = markBlock(s, 'b', 'done', d(9, 30));
    expect(first.status).toBe('done');
    expect(first.statusChangedAt).toBe(d(9, 30).toISOString());
    const again = markBlock(s, 'b', 'done', d(9, 45));
    expect(again.status).toBe('done');
    expect(again.statusChangedAt).toBe(d(9, 45).toISOString());
  });
  it('can move a missed block to done later', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('b', d(9), d(10), 'missed')]);
    expect(markBlock(s, 'b', 'done', d(12)).status).toBe('done');
  });
  it('throws for unknown ids', () => {
    expect(() => markBlock(new MemoryStore(), 'nope', 'done', d(9))).toThrow(/not found/i);
  });
});

describe('findTaskBlock', () => {
  it('prefers the block containing now, then the latest one started today, then the next one today', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('a', d(9), d(10)), block('b', d(11), d(12)), block('c', d(14), d(15))]);
    expect(findTaskBlock(s, 't', d(11, 30))!.id).toBe('b');
    expect(findTaskBlock(s, 't', d(13))!.id).toBe('b');
    expect(findTaskBlock(s, 't', d(8))!.id).toBe('a');
    expect(findTaskBlock(s, 'other', d(11, 30))).toBeUndefined();
  });
});

describe('moveBlock', () => {
  it('updates start and end', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('b', d(9), d(10))]);
    const r = moveBlock(s, 'b', d(13), d(14, 30));
    expect(r.start).toBe(d(13).toISOString());
    expect(r.end).toBe(d(14, 30).toISOString());
  });
  it('rejects end before start', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('b', d(9), d(10))]);
    expect(() => moveBlock(s, 'b', d(10), d(9))).toThrow(/end/i);
  });
});

describe('materializeMissed', () => {
  it('turns pending blocks that already ended into missed, and leaves the rest alone', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('past', d(9), d(10)), block('current', d(11), d(12)), block('future', d(14), d(15)), block('done', d(8), d(9), 'done')]);
    const changed = materializeMissed(s, d(11, 30));
    expect(changed.map((b) => b.id)).toEqual(['past']);
    expect(s.getBlock('past')!.status).toBe('missed');
    expect(s.getBlock('past')!.statusChangedAt).toBe(d(11, 30).toISOString());
    expect(s.getBlock('current')!.status).toBe('pending');
    expect(s.getBlock('future')!.status).toBe('pending');
    expect(s.getBlock('done')!.status).toBe('done');
    expect(materializeMissed(s, d(11, 30))).toEqual([]);
  });
});

describe('createBlock', () => {
  it('creates a pending block for a task by hand, snapped to the slot grid', () => {
    const s = new MemoryStore();
    s.upsertTask({ id: 't', name: 'A', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    const b = createBlock(s, 't', d(9, 7), d(10, 4), d(8));
    expect(b.status).toBe('pending');
    expect(b.start).toBe(d(9).toISOString());
    expect(b.end).toBe(d(10, 15).toISOString()); // end snaps up to the next slot
    expect(s.getBlock(b.id)).toBeTruthy();
    expect(() => createBlock(s, 'nope', d(9), d(10), d(8))).toThrow(/Task not found/);
    expect(() => createBlock(s, 't', d(10), d(9), d(8))).toThrow(/end/);
  });
});
