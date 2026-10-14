/**
 * Renders statusline.cjs in a child process per frame, against a throwaway
 * config dir and a pinned clock. Run with `node --test`.
 */
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { beforeEach, afterEach, test } = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'statusline.cjs');
const CLOCK = path.join(__dirname, 'fake-clock.cjs');
const T0 = 2_000_000_000;

let dir;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Renders one frame at [now] and returns the cache segment, ANSI stripped. */
function cache(now, promptCache) {
  const payload = { session_id: 's1', context_window: { used_percentage: 10 } };
  if (promptCache) payload.prompt_cache = promptCache;
  const result = spawnSync(process.execPath, ['--require', CLOCK, SCRIPT], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, STATUSLINE_TEST_NOW: String(now) },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const match = plain.match(/· cache (.{7}(?: ↻)?)/);
  return match ? match[1] : null;
}

/** A 5m-tier reading whose expiry was last renewed at [renewedAt]. */
function fiveMinute(renewedAt, requests) {
  return { caching_observed: true, warm: true, ttl: '5m', expires_at: renewedAt + 300, requests };
}

function setWindow(minutes) {
  const flags = { cachedGrowthBookFeatures: { tengu_sequential_cloud: { activityWindowMinutes: minutes } } };
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(flags));
}

test('a 1h reading without touches counts down its own expiry', () => {
  assert.equal(cache(T0, { caching_observed: true, warm: true, ttl: '1h', expires_at: T0 + 3600, requests: 1 }), ' 1h 00m');
  assert.equal(cache(T0 + 600, { caching_observed: true, warm: true, ttl: '1h', expires_at: T0 + 3600, requests: 1 }), ' 0h 50m');
});

test('a 5m reading before any touch counts down the plain TTL', () => {
  assert.equal(cache(T0, fiveMinute(T0, 1)), ' 5m 00s');
  assert.equal(cache(T0 + 20, fiveMinute(T0, 1)), ' 4m 40s');
});

test('touches switch to the countdown until the cache is cold after the window', () => {
  cache(T0, fiveMinute(T0, 1));
  assert.equal(cache(T0 + 30, fiveMinute(T0 + 30, 1)), ' 1h 04m ↻');
  // A frame between touches keeps the estimate rather than jumping back.
  assert.equal(cache(T0 + 50, fiveMinute(T0 + 30, 1)), ' 1h 04m ↻');
  assert.equal(cache(T0 + 3580, fiveMinute(T0 + 3580, 1)), ' 5m 20s ↻');
});

test('the window comes from the cached keepalive flag', () => {
  setWindow(10);
  cache(T0, fiveMinute(T0, 1));
  assert.equal(cache(T0 + 30, fiveMinute(T0 + 30, 1)), ' 0h 14m ↻');
});

test('a new request restarts the window', () => {
  cache(T0, fiveMinute(T0, 1));
  cache(T0 + 30, fiveMinute(T0 + 30, 1));
  cache(T0 + 1800, fiveMinute(T0 + 1800, 2));
  assert.equal(cache(T0 + 1830, fiveMinute(T0 + 1830, 2)), ' 1h 04m ↻');
});

test('without a touch for long, the icon drops and the plain expiry shows', () => {
  cache(T0, fiveMinute(T0, 1));
  cache(T0 + 30, fiveMinute(T0 + 30, 1));
  assert.equal(cache(T0 + 200, fiveMinute(T0 + 30, 1)), ' 2m 10s');
});

test('touches past the estimated window fall back to the live expiry', () => {
  cache(T0, fiveMinute(T0, 1));
  cache(T0 + 30, fiveMinute(T0 + 30, 1));
  assert.equal(cache(T0 + 3630, fiveMinute(T0 + 3630, 1)), ' 5m 00s ↻');
});

test('an evicted cache reads COLD and is not mistaken for a touch', () => {
  cache(T0, fiveMinute(T0, 1));
  assert.equal(cache(T0 + 400, { caching_observed: true, warm: false, ttl: '5m', expires_at: null, requests: 1 }), '   COLD');
  assert.equal(cache(T0 + 430, { caching_observed: true, warm: false, ttl: '5m', expires_at: null, requests: 1 }), '   COLD');
  assert.equal(cache(T0 + 460), '   COLD');
});

test('a resumed frame without a reading bridges the stored estimate', () => {
  cache(T0, fiveMinute(T0, 1));
  cache(T0 + 30, fiveMinute(T0 + 30, 1));
  assert.equal(cache(T0 + 60), ' 1h 04m ↻');
});
