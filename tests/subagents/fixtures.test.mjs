import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseClause, normalized, clauseIds, markers } from './fixture/agent/lib/clauses.ts';

test('three checked-in text fixtures normalize exactly to checked-in expected JSON', async () => {
  const expected = JSON.parse(await readFile(new URL('./fixtures/expected.json', import.meta.url), 'utf8'));
  assert.equal(expected.length, 3);
  const actual = await Promise.all(clauseIds.map(async id => parseClause(await readFile(new URL(`./fixtures/inputs/${id}.txt`, import.meta.url), 'utf8'), id)));
  assert.equal(normalized(actual), normalized(expected));
  assert.equal(new Set(actual.map(x => x.id)).size, 3);
  assert.equal(normalized(markers), normalized(JSON.parse(await readFile(new URL('./fixtures/markers.json', import.meta.url), 'utf8'))));
});

test('mechanical parser refuses another assigned clause or malformed prose', () => {
  assert.throws(() => parseClause('Clause ID: clause-002\nQuoted sentence: "fixed"\n', 'clause-001'), /Assigned/);
  assert.throws(() => parseClause('A model paraphrase rather than a fixture.', 'clause-001'), /Assigned/);
  assert.equal(normalized({ sentence: 'exact', id: 'clause-001' }), normalized({ id: 'clause-001', sentence: 'exact' }));
});
