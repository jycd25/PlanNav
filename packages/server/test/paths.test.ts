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
  it('PLANNAV_DB_PATH wins, then the pre-rename DS_DB_PATH', () => {
    expect(defaultDbPath({ PLANNAV_DB_PATH: '/a', DS_DB_PATH: '/b' }, home, () => false)).toBe('/a');
    expect(defaultDbPath({ DS_DB_PATH: '/b' }, home, () => false)).toBe('/b');
  });
  it('uses an existing pre-rename database when the new default does not exist yet', () => {
    const legacy = join(home, '.dynamic-scheduler', 'data.sqlite');
    expect(defaultDbPath({}, home, (p) => p === legacy)).toBe(legacy);
  });
  it('prefers the new default once it exists (and creates its directory)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'plannav-home-'));
    try {
      const fresh = join(tmpHome, '.plannav', 'data.sqlite');
      expect(defaultDbPath({}, tmpHome, (p) => p === fresh || p.includes('.dynamic-scheduler'))).toBe(fresh);
      expect(existsSync(join(tmpHome, '.plannav'))).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
