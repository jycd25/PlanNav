import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store.js';

describe('MemoryStore recurring commitments', () => {
  it('adds, lists, replaces by id, deletes, and exports', () => {
    const s = new MemoryStore();
    s.addRecurring({ id: 'r1', title: 'Standup', days: [1, 2], start: '10:00', end: '10:30' });
    s.addRecurring({ id: 'r1', title: 'Standup (daily)', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' });
    expect(s.listRecurring()).toEqual([{ id: 'r1', title: 'Standup (daily)', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' }]);
    expect(s.exportAll().recurring.length).toBe(1);
    s.deleteRecurring('r1');
    expect(s.listRecurring()).toEqual([]);
  });
});
