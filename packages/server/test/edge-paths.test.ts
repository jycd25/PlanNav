import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defaultDbPath, firstExisting, mcpEntryCandidates, webDistCandidates } from '../src/paths.js';

describe('defaultDbPath', () => {
  const home = '/home/u';
  const never = () => false;

  it('an environment override is returned as given, with no existence check and no directory made', () => {
    const asked: string[] = [];
    const spy = (p: string) => { asked.push(p); return false; };
    expect(defaultDbPath({ REROUTEDAY_DB_PATH: 'relative/path.sqlite' }, home, spy)).toBe('relative/path.sqlite');
    expect(defaultDbPath({ REROUTEDAY_DB_PATH: ':memory:' }, home, spy)).toBe(':memory:');
    expect(defaultDbPath({ DS_DB_PATH: '/x/y.sqlite' }, home, spy)).toBe('/x/y.sqlite');
    expect(asked).toEqual([]);
  });

  it('an empty override is no override', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'rerouteday-home-'));
    try {
      expect(defaultDbPath({ REROUTEDAY_DB_PATH: '', DS_DB_PATH: '' }, tmpHome, never)).toBe(join(tmpHome, '.rerouteday', 'data.sqlite'));
      expect(existsSync(join(tmpHome, '.rerouteday'))).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('the legacy database wins only while the new one does not exist; both present means the new one', () => {
    const legacy = join(home, '.dynamic-scheduler', 'data.sqlite');
    const fresh = join(home, '.rerouteday', 'data.sqlite');
    const tmpHome = mkdtempSync(join(tmpdir(), 'rerouteday-home-'));
    try {
      expect(defaultDbPath({}, tmpHome, (p) => p === legacy.replace(home, tmpHome))).toBe(join(tmpHome, '.dynamic-scheduler', 'data.sqlite'));
      expect(existsSync(join(tmpHome, '.rerouteday'))).toBe(false); // nothing is created when the legacy file is used
      expect(defaultDbPath({}, tmpHome, (p) => p === legacy.replace(home, tmpHome) || p === fresh.replace(home, tmpHome))).toBe(join(tmpHome, '.rerouteday', 'data.sqlite'));
      expect(existsSync(join(tmpHome, '.rerouteday'))).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('with the real file system: a legacy file present and no new one is honoured; a new one present is preferred', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'rerouteday-home-'));
    try {
      mkdirSync(join(tmpHome, '.dynamic-scheduler'));
      writeFileSync(join(tmpHome, '.dynamic-scheduler', 'data.sqlite'), '');
      expect(defaultDbPath({}, tmpHome)).toBe(join(tmpHome, '.dynamic-scheduler', 'data.sqlite'));
      mkdirSync(join(tmpHome, '.rerouteday'));
      writeFileSync(join(tmpHome, '.rerouteday', 'data.sqlite'), '');
      expect(defaultDbPath({}, tmpHome)).toBe(join(tmpHome, '.rerouteday', 'data.sqlite'));
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('the exists predicate is asked about the new path first, then the legacy one only if needed', () => {
    const asked: string[] = [];
    const tmpHome = mkdtempSync(join(tmpdir(), 'rerouteday-home-'));
    try {
      defaultDbPath({}, tmpHome, (p) => { asked.push(p); return p.endsWith(join('.rerouteday', 'data.sqlite')); });
      expect(asked).toEqual([join(tmpHome, '.rerouteday', 'data.sqlite')]);
      asked.length = 0;
      defaultDbPath({}, tmpHome, (p) => { asked.push(p); return false; });
      expect(asked).toEqual([join(tmpHome, '.rerouteday', 'data.sqlite'), join(tmpHome, '.plannav', 'data.sqlite'), join(tmpHome, '.dynamic-scheduler', 'data.sqlite')]); // the two earlier names, newest first
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('candidate lists', () => {
  it('webDistCandidates: beside the module, then two levels up into web/dist; relative and trailing-slash inputs are normalised', () => {
    expect(webDistCandidates('dist')).toEqual([join('dist', 'web'), join('..', 'web', 'dist')]);
    expect(webDistCandidates('/a/b/c/')).toEqual(['/a/b/c/web', '/a/web/dist']);
    expect(webDistCandidates('/')).toEqual(['/web', '/web/dist']);
  });

  it('mcpEntryCandidates: beside the module, then one level up', () => {
    expect(mcpEntryCandidates('/a/b')).toEqual(['/a/b/mcp.js', '/a/mcp.js']);
    expect(mcpEntryCandidates('.')).toEqual(['mcp.js', join('..', 'mcp.js')]);
  });
});

describe('firstExisting', () => {
  it('asks the predicate in order and stops at the first hit; an empty list is undefined without asking', () => {
    const asked: string[] = [];
    expect(firstExisting(['/a', '/b', '/c', '/d'], (p) => { asked.push(p); return p === '/c'; })).toBe('/c');
    expect(asked).toEqual(['/a', '/b', '/c']);
    expect(firstExisting([], () => { throw new Error('never asked'); })).toBeUndefined();
    expect(firstExisting(['', ''], (p) => p === '')).toBe('');
  });

  it('uses the real file system by default', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rerouteday-first-'));
    try {
      const file = join(tmp, 'here.txt');
      writeFileSync(file, '');
      expect(firstExisting([join(tmp, 'missing'), file, join(tmp, 'also-missing')])).toBe(file);
      expect(firstExisting([join(tmp, 'missing')])).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
