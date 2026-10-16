import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaSort, parseSortOrder, buildMediaOrderBy } from '../src/routes/mediaSort';

describe('Plex-style library sorting', () => {
  it('parses sort keys with safe fallbacks', () => {
    assert.equal(parseMediaSort('title'), 'title');
    assert.equal(parseMediaSort('added'), 'added');
    assert.equal(parseMediaSort('size'), 'size');
    assert.equal(parseMediaSort('id; DROP TABLE media_items;--'), 'title');
    assert.equal(parseMediaSort(undefined), 'title');
  });

  it('uses sensible default orders (Plex-like)', () => {
    assert.equal(parseSortOrder(undefined, 'title'), 'asc');
    assert.equal(parseSortOrder(undefined, 'added'), 'desc');
    assert.equal(parseSortOrder(undefined, 'size'), 'desc');
    assert.equal(parseSortOrder('asc', 'added'), 'asc');
    assert.equal(parseSortOrder('nonsense', 'title'), 'asc');
  });

  it('builds whitelisted ORDER BY clauses only', () => {
    assert.ok(buildMediaOrderBy('added', 'desc').includes('created_at DESC'));
    assert.ok(buildMediaOrderBy('size', 'desc').includes('size_bytes DESC'));
    const title = buildMediaOrderBy('title', 'asc');
    assert.ok(title.includes('show_name') && title.includes('ASC'));
    // No user input can leak through: output alphabet is fixed (no ; or --)
    const out = buildMediaOrderBy(parseMediaSort('x;DELETE'), parseSortOrder('y', 'title'));
    assert.match(out, /^[A-Za-z_'(),\s]+$/);
    assert.ok(!out.includes(';') && !out.includes('--'));
  });
});
