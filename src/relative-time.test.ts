import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { formatRelativeTime } from './relative-time.js';

const NOW_ISO = '2026-02-27T12:00:00.000Z';

function freezeNow(t: TestContext): void {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date(NOW_ISO),
  });
  t.after(() => t.mock.timers.reset());
}

test('formatRelativeTime returns "just now" for timestamps under one minute', (t) => {
  freezeNow(t);
  assert.equal(formatRelativeTime('2026-02-27T11:59:30.000Z'), 'just now');
});

test('formatRelativeTime returns minutes ago for timestamps under one hour', (t) => {
  freezeNow(t);
  assert.equal(formatRelativeTime('2026-02-27T11:37:00.000Z'), '23m ago');
});

test('formatRelativeTime returns hours ago for timestamps under one day', (t) => {
  freezeNow(t);
  assert.equal(formatRelativeTime('2026-02-27T04:00:00.000Z'), '8h ago');
});

test('formatRelativeTime returns "yesterday" for one day old timestamps', (t) => {
  freezeNow(t);
  assert.equal(formatRelativeTime('2026-02-26T12:00:00.000Z'), 'yesterday');
});

test('formatRelativeTime returns days ago for two to six day old timestamps', (t) => {
  freezeNow(t);
  assert.equal(formatRelativeTime('2026-02-24T12:00:00.000Z'), '3d ago');
});

test('formatRelativeTime returns short date for timestamps older than one week', (t) => {
  freezeNow(t);
  assert.equal(formatRelativeTime('2026-02-20T12:00:00.000Z'), 'Fri Feb 20');
});

test('formatRelativeTime accepts both string and Date inputs', (t) => {
  freezeNow(t);

  assert.equal(formatRelativeTime('2026-02-27T11:50:00.000Z'), '10m ago');
  assert.equal(formatRelativeTime(new Date('2026-02-27T11:50:00.000Z')), '10m ago');
});
