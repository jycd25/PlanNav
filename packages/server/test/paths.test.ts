import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defaultDbPath, firstExisting, mcpEntryCandidates, webDistCandidates } from '../src/paths.js';

describe('webDistCandidates', () => {
  it('prefers a web/ folder beside the module (bundled layout), then the monorepo layout', () => {
    const here = '/repo/packages/server/dist';
    expect(webDistCandidates(here)).toEqual([join(here, 'web'), join('/repo/packages', 'web', 'dist')]);
  });
});

describe('mcpEntryCandidates', () => {
  it('prefers mcp.js beside the module (bundled layout), then one level up (server/dist/assistant → server/dist)', () => {
    const here = '/pkg/dist/assistant';
    expect(mcpEntryCandidates(here)).toEqual([join('/pkg/dist/assistant', 'mcp.js'), join('/pkg/dist', 'mcp.js')]);
  });
});

describe('firstExisting', () => {
  it('returns the first candidate the predicate accepts', () => {
    expect(firstExisting(['/a', '/b', '/c'], (p) => p === '/b' || p === '/c')).toBe('/b');
  });
  it('returns undefined when none exists', () => {
    expect(firstExisting(['/a'], () => false)).toBeUndefined();
  });
});

describe('defaultDbPath', () => {
  const home = '/home/u';
  it('an existing ~/.plannav database is used before ~/.dynamic-scheduler, and neither once ~/.rerouteday has one', () => {
    const fresh = join(home, '.rerouteday', 'data.sqlite');
    const plannav = join(home, '.plannav', 'data.sqlite');
    const ds = join(home, '.dynamic-scheduler', 'data.sqlite');
    const tmpHome = mkdtempSync(join(tmpdir(), 'rerouteday-home-'));
    try {
      expect(defaultDbPath({}, tmpHome, (p) => p.endsWith(plannav.slice(home.length)) || p.endsWith(ds.slice(home.length)))).toBe(join(tmpHome, '.plannav', 'data.sqlite'));
      expect(defaultDbPath({}, tmpHome, (p) => p.endsWith(ds.slice(home.length)))).toBe(join(tmpHome, '.dynamic-scheduler', 'data.sqlite'));
      expect(defaultDbPath({}, tmpHome, (p) => p.endsWith(fresh.slice(home.length)) || p.endsWith(plannav.slice(home.length)))).toBe(join(tmpHome, '.rerouteday', 'data.sqlite'));
    } finally { rmSync(tmpHome, { recursive: true, force: true }); }
  });

  it('REROUTEDAY_DB_PATH wins, then the pre-rename PLANNAV_DB_PATH, then DS_DB_PATH', () => {
    expect(defaultDbPath({ REROUTEDAY_DB_PATH: '/a', PLANNAV_DB_PATH: '/p', DS_DB_PATH: '/b' }, home, () => false)).toBe('/a');
    expect(defaultDbPath({ PLANNAV_DB_PATH: '/p', DS_DB_PATH: '/b' }, home, () => false)).toBe('/p');
    expect(defaultDbPath({ DS_DB_PATH: '/b' }, home, () => false)).toBe('/b');
  });
  it('uses an existing pre-rename database when the new default does not exist yet', () => {
    const legacy = join(home, '.dynamic-scheduler', 'data.sqlite');
    expect(defaultDbPath({}, home, (p) => p === legacy)).toBe(legacy);
  });
  it('prefers the new default once it exists (and creates its directory)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'rerouteday-home-'));
    try {
      const fresh = join(tmpHome, '.rerouteday', 'data.sqlite');
      expect(defaultDbPath({}, tmpHome, (p) => p === fresh || p.includes('.dynamic-scheduler'))).toBe(fresh);
      expect(existsSync(join(tmpHome, '.rerouteday'))).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
