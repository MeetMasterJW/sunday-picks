import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tbMillis, guessOff, compareTiebreak, rankRows } from '../scoring.js';

const row = (name, right, wrong, idx, tb = null, tbAt = Infinity, tb2 = null) =>
  ({ name, right, wrong, idx, tb, tbAt, tb2 });
const order = rows => rows.map(r => r.name);

test('tbMillis reads old ISO strings, server Timestamps, and anything else as last', () => {
  assert.equal(tbMillis('2026-09-19T18:28:42.161Z'), Date.parse('2026-09-19T18:28:42.161Z'));
  assert.equal(tbMillis({ toMillis: () => 1234 }), 1234);
  assert.equal(tbMillis(null), Infinity);
  assert.equal(tbMillis(undefined), Infinity);
  assert.equal(tbMillis('not a date'), Infinity);
  assert.equal(tbMillis({}), Infinity); // the serverTimestamp() placeholder before it echoes back
});

test('guessOff: any guess beats none, then closer, then not over', () => {
  assert.ok(guessOff(40, null, 45) < 0);
  assert.ok(guessOff(null, 40, 45) > 0);
  assert.equal(guessOff(null, null, 45), 0);
  assert.ok(guessOff(44, 40, 45) < 0);
  assert.ok(guessOff(43, 47, 45) < 0, 'same distance: under beats over');
  assert.equal(guessOff(44, 44, 45), 0);
});

test('compareTiebreak: first guess, then Monday guess, then who saved first', () => {
  const a = { tb: 44, tb2: 40, tbAt: 200 }, b = { tb: 44, tb2: 50, tbAt: 100 };
  assert.ok(compareTiebreak(a, b, 45, 41) < 0, 'Monday guess settles an identical first guess');
  assert.ok(compareTiebreak(a, b, 45, null) > 0, 'no Monday total yet: earlier save wins');
  assert.equal(compareTiebreak({ tb: 44, tbAt: 100 }, { tb: 44, tbAt: 100 }, 45, null), 0);
  assert.equal(compareTiebreak({ tb: null, tbAt: Infinity }, { tb: null, tbAt: Infinity }, 45, null), 0);
});

test('Week 1 as it happened: a three-way tie on 10 settled by the tiebreaker', () => {
  const rows = [
    row('Aaron', 9, 6, 0, 56, 1789318918565),
    row('Caleb', 10, 5, 1, 42, 1789318853191),
    row('Hannie', 11, 4, 2, 27, 1789320969748),
    row('Mom', 10, 5, 3, 67, 1789321051776),
    row('Dad', 10, 5, 4, 62, 1789318975313),
  ];
  rankRows(rows, { complete: true, actual: 72, actual2: null });
  assert.deepEqual(order(rows), ['Hannie', 'Mom', 'Dad', 'Caleb', 'Aaron']);
  assert.deepEqual(rows.map(r => r.pts), [3, 2, 1, 0, 0]);
  assert.deepEqual(rows.map(r => r.tied), [false, true, true, true, false]);
});

test('a week still in play gives no points and ranks fewer misses first', () => {
  const rows = [row('A', 5, 3, 0, 40), row('B', 5, 1, 1, 90), row('C', 6, 4, 2)];
  rankRows(rows, { complete: false, actual: null, actual2: null });
  assert.deepEqual(order(rows), ['C', 'B', 'A']);
  assert.deepEqual(rows.map(r => r.pts), [0, 0, 0]);
});

test('points go to the top three only', () => {
  const rows = [5, 4, 3, 2, 1, 0].map((n, i) => row('P' + i, n, 5 - n, i));
  rankRows(rows, { complete: true, actual: 40, actual2: null });
  assert.deepEqual(rows.map(r => r.pts), [3, 2, 1, 0, 0, 0]);
});

test('a total dead heat falls back to roster order', () => {
  const rows = [row('Second', 8, 8, 1, 40, 5), row('First', 8, 8, 0, 40, 5)];
  rankRows(rows, { complete: true, actual: 45, actual2: null });
  assert.deepEqual(order(rows), ['First', 'Second']);
});
