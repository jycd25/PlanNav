import { describe, it, expect } from 'vitest';
import { directReply, matchDirect, normalizePhrase } from '../src/directActions.js';

describe('normalizePhrase: the exact-match key', () => {
  it('straightens every curly apostrophe variant to a straight one', () => {
    expect(normalizePhrase('I’m starting now')).toBe("i'm starting now");
    expect(normalizePhrase('I‘m starting now')).toBe("i'm starting now");
    expect(normalizePhrase('Iʼm starting now')).toBe("i'm starting now");
    expect(normalizePhrase("I'm starting now")).toBe("i'm starting now");
  });

  it('collapses runs of any whitespace, including tabs, newlines and no-break spaces, to one space', () => {
    expect(normalizePhrase("what's\t\ton\ntoday")).toBe("what's on today");
    expect(normalizePhrase('how am  i doing')).toBe('how am i doing');
    expect(normalizePhrase('  apply   my   baseline  ')).toBe('apply my baseline');
  });

  it('drops trailing punctuation and spaces in any mix, but keeps leading and inner punctuation', () => {
    expect(normalizePhrase("What's on today?!?! ... ")).toBe("what's on today");
    expect(normalizePhrase('Start my day.  .  .')).toBe('start my day');
    expect(normalizePhrase("?What's on today")).toBe("?what's on today");
    expect(normalizePhrase("I'm late, start now!")).toBe("i'm late, start now");
    expect(normalizePhrase('start; my day')).toBe('start; my day');
    expect(normalizePhrase('start my day;')).toBe('start my day;'); // only . ! ? are trailing punctuation
    expect(normalizePhrase('start my day…')).toBe('start my day…');
  });

  it('is case-insensitive and idempotent; empty and punctuation-only input become the empty string', () => {
    expect(normalizePhrase('APPLY MY BASELINE TO NEXT WEEK')).toBe('apply my baseline to next week');
    const once = normalizePhrase("  What’s   ON today?? ");
    expect(normalizePhrase(once)).toBe(once);
    expect(normalizePhrase('')).toBe('');
    expect(normalizePhrase('   ')).toBe('');
    expect(normalizePhrase('?!.')).toBe('');
  });
});

describe('matchDirect: every phrase, its variants, and the near misses', () => {
  const SHIFT = { tool: 'shift_day', input: {} };
  const NEXT = { tool: 'apply_baseline', input: { week_of: 'next week' } };
  const THIS = { tool: 'apply_baseline', input: { week_of: 'this week' } };
  const SCHED = { tool: 'get_schedule', input: {} };
  const SUMMARY = { tool: 'get_summary', input: {} };

  it('maps each of the fourteen phrases', () => {
    const table: Array<[string, unknown]> = [
      ["i'm starting now", SHIFT], ['im starting now', SHIFT], ['i am starting now', SHIFT], ['start my day', SHIFT], ["i'm late, start now", SHIFT],
      ['apply my baseline to this week', THIS], ['apply my baseline to next week', NEXT], ['apply my baseline', NEXT], ['set up next week', NEXT],
      ["what's on today", SCHED], ['whats on today', SCHED], ['how am i doing', SUMMARY],
    ];
    for (const [phrase, want] of table) expect(matchDirect(phrase), phrase).toEqual(want);
  });

  it('matches through case, curly quotes, surrounding and inner whitespace, and trailing punctuation', () => {
    const variants: Array<[string, unknown]> = [
      ['I’M STARTING NOW!!!', SHIFT], ['  Iʼm   starting\tnow.  ', SHIFT], ['I am starting now?', SHIFT], ['IM STARTING NOW', SHIFT],
      ['I’m late, start now...', SHIFT], ['Start My Day!', SHIFT],
      ['Apply my baseline to THIS week.', THIS], ['apply   my baseline to next week ?', NEXT], ['Apply my baseline!', NEXT], ['Set up next week.', NEXT],
      ['What’s on today?', SCHED], ['WHATS ON TODAY', SCHED], ["what's on today", SCHED], ['How am I doing?!', SUMMARY], ['how am i doing', SUMMARY],
    ];
    for (const [phrase, want] of variants) expect(matchDirect(phrase), JSON.stringify(phrase)).toEqual(want);
  });

  it('returns null for anything that is not exactly one of the phrases', () => {
    const misses = [
      '', ' ', '?', "I'm starting", "I'm starting now with Reading", 'start my day please', 'please start my day', 'start day', 'start', "let's go", 'lets go',
      "I'm late", "I'm late start now", "I'm late; start now", 'I am late, start now', 'i am starting now.. and skipping lunch',
      'apply baseline', 'apply my baseline this week', 'apply my baseline to the week', 'apply my baseline to this week and next', 'apply the baseline', 'reapply my baseline',
      'set up this week', 'setup next week', 'set up next week please',
      "what's on", "what's on tomorrow", "what's on today and tomorrow", "what's today", 'what is on today', "?what's on today",
      'how am i doing today', 'how am i doing this week', 'how are you doing', 'how am i', 'how i am doing',
      'busy until 15:00', "I didn't finish Reading", 'this is my baseline', 'plan my day', 'suggest a schedule',
    ];
    for (const m of misses) expect(matchDirect(m), JSON.stringify(m)).toBeNull();
  });

  it('hands out a fresh input object each time: mutating one result never leaks into the next', () => {
    const a = matchDirect('apply my baseline')!;
    (a.input as Record<string, unknown>).week_of = 'this week';
    (a.input as Record<string, unknown>).extra = true;
    const b = matchDirect('apply my baseline')!;
    expect(b).toEqual(NEXT);
    expect(b.input).not.toBe(a.input);
    const s1 = matchDirect("I'm starting now")!;
    (s1.input as Record<string, unknown>).breaks = 'waive';
    expect(matchDirect('start my day')).toEqual(SHIFT);
  });

  it('two phrases that share a tool still carry their own arguments', () => {
    expect(matchDirect('apply my baseline to this week')!.input).toEqual({ week_of: 'this week' });
    expect(matchDirect('set up next week')!.input).toEqual({ week_of: 'next week' });
    expect(matchDirect('apply my baseline')!.input).toEqual({ week_of: 'next week' }); // the bare phrase means next week
  });
});

describe('directReply: the tool summary becomes the reply, or nothing', () => {
  it('returns a non-empty summary string as is', () => {
    expect(directReply({ summary: 'Shifted 2 blocks by 20 min.' })).toBe('Shifted 2 blocks by 20 min.');
    expect(directReply({ summary: '  spaced  ', other: 1 })).toBe('  spaced  '); // not trimmed: the tool's words as written
    expect(directReply({ summary: 'Shifting 5 blocks… or keep them and end later?', needsConfirmation: true })).toBe('Shifting 5 blocks… or keep them and end later?');
  });

  it('returns null for a missing, empty, blank or non-string summary and for a result that is not an object', () => {
    for (const r of [{}, { summary: '' }, { summary: '   \n' }, { summary: 42 }, { summary: null }, { summary: ['a'] }, { summary: { text: 'x' } }, null, undefined, 'a string', 7, true, []]) {
      expect(directReply(r), JSON.stringify(r)).toBeNull();
    }
  });
});
