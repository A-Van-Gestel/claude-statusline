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
const BUSY = path.join(__dirname, 'busy-read.cjs');
const T0 = 2_000_000_000;

let dir;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** The child's env: never the caller's state-file override, which may point at a live file. */
function testEnv(extra) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, ...extra };
  if (!extra || !('STATUSLINE_STATE_FILE' in extra)) delete env.STATUSLINE_STATE_FILE;
  return env;
}

/** Renders one frame at [now] and returns the cache segment, ANSI stripped. */
function cache(now, promptCache) {
  const payload = { session_id: 's1', context_window: { used_percentage: 10 } };
  if (promptCache) payload.prompt_cache = promptCache;
  const result = spawnSync(process.execPath, ['--require', CLOCK, SCRIPT], {
    input: JSON.stringify(payload),
    env: testEnv({ STATUSLINE_TEST_NOW: String(now) }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const match = plain.match(/· cache (.{7}(?: ↻)?)/);
  return match ? match[1] : null;
}

/**
 * Renders [sid] with a 5h reading of [pct] (none when undefined) and returns
 * the shown 5h plus the one stored in the [account] slot.
 */
function fiveHour(sid, pct, { resetsAt = T0 + 3600, env = {}, account = 'default' } = {}) {
  const payload = { session_id: sid };
  if (pct !== undefined) payload.rate_limits = { five_hour: { used_percentage: pct, resets_at: resetsAt } };
  const result = spawnSync(process.execPath, ['--require', CLOCK, SCRIPT], {
    input: JSON.stringify(payload),
    env: testEnv({ STATUSLINE_TEST_NOW: String(T0), ...env }),
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const shown = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').match(/5h \S+ +(\S+)%/)[1];
  return { shown, stored: storedFiveHour(env.STATUSLINE_STATE_FILE, account) };
}

function storedFiveHour(file = path.join(dir, '.statusline-state.json'), account = 'default') {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).accounts[account].five_hour.used_percentage;
  } catch {
    return null;
  }
}

/** A config dir logged in as [account], standing in for one OS's ~/.claude. */
function configDir(name, account) {
  const config = path.join(dir, name);
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account } }));
  return config;
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

test('an idle session with an older reading shows and keeps the newer stored one', () => {
  fiveHour('active', 77);
  assert.deepEqual(fiveHour('idle', 70), { shown: '77', stored: 77 });
  assert.deepEqual(fiveHour('fresh', undefined), { shown: '77', stored: 77 });
});

test('a higher live reading in the same window replaces the stored one', () => {
  fiveHour('idle', 70);
  assert.deepEqual(fiveHour('active', 77), { shown: '77', stored: 77 });
});

test('a later window beats a higher reading from an earlier one', () => {
  fiveHour('old', 90, { resetsAt: T0 + 60 });
  assert.deepEqual(fiveHour('new', 5, { resetsAt: T0 + 18000 }), { shown: '5', stored: 5 });
  assert.deepEqual(fiveHour('old', 90, { resetsAt: T0 + 60 }), { shown: '5', stored: 5 });
});

test('two config dirs on one account share readings through a moved state file', () => {
  const shared = path.join(dir, 'shared.json');
  const windows = { CLAUDE_CONFIG_DIR: configDir('windows', 'acct-1'), STATUSLINE_STATE_FILE: shared };
  const wsl = { CLAUDE_CONFIG_DIR: configDir('wsl', 'acct-1'), STATUSLINE_STATE_FILE: shared };
  fiveHour('windows', 77, { env: windows, account: 'acct-1' });
  assert.deepEqual(fiveHour('wsl', 70, { env: wsl, account: 'acct-1' }), { shown: '77', stored: 77 });
  assert.equal(fs.existsSync(path.join(dir, '.statusline-state.json')), false);
});

test('a different account keeps its own readings in the shared file', () => {
  const shared = path.join(dir, 'shared.json');
  const windows = { CLAUDE_CONFIG_DIR: configDir('windows', 'acct-1'), STATUSLINE_STATE_FILE: shared };
  const wsl = { CLAUDE_CONFIG_DIR: configDir('wsl', 'acct-2'), STATUSLINE_STATE_FILE: shared };
  fiveHour('windows', 77, { env: windows, account: 'acct-1' });
  assert.deepEqual(fiveHour('wsl', 20, { env: wsl, account: 'acct-2' }), { shown: '20', stored: 20 });
  assert.deepEqual(fiveHour('wsl-idle', undefined, { env: wsl, account: 'acct-2' }), { shown: '20', stored: 20 });
  assert.deepEqual(fiveHour('windows', 77, { env: windows, account: 'acct-1' }), { shown: '77', stored: 77 });
});

test('an account whose windows have all reset is dropped from the file', () => {
  const shared = path.join(dir, 'shared.json');
  const gone = { CLAUDE_CONFIG_DIR: configDir('gone', 'acct-gone'), STATUSLINE_STATE_FILE: shared };
  const here = { CLAUDE_CONFIG_DIR: configDir('here', 'acct-here'), STATUSLINE_STATE_FILE: shared };
  fiveHour('old', 50, { env: gone, resetsAt: T0 - 60, account: 'acct-gone' });
  fiveHour('new', 10, { env: here, account: 'acct-here' });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(shared, 'utf8')).accounts), ['acct-here']);
});

test('a relative state-file override is ignored for the default path', () => {
  assert.deepEqual(fiveHour('s1', 40, { env: { STATUSLINE_STATE_FILE: 'relative.json' } }).shown, '40');
  assert.equal(storedFiveHour(), 40);
});

test('the caller\'s state-file override never reaches a test that did not set it', () => {
  const live = path.join(dir, 'live.json');
  process.env.STATUSLINE_STATE_FILE = live;
  try {
    fiveHour('s1', 40);
  } finally {
    delete process.env.STATUSLINE_STATE_FILE;
  }
  assert.equal(fs.existsSync(live), false);
});

test('a state file that cannot be read is not overwritten', () => {
  const file = path.join(dir, '.statusline-state.json');
  const state = JSON.stringify({ accounts: {}, cache: { other: { expires_at: T0 + 300, ttl: 300 } } });
  fs.writeFileSync(file, state);
  const result = spawnSync(process.execPath, ['--require', CLOCK, '--require', BUSY, SCRIPT], {
    input: JSON.stringify({ session_id: 's1', rate_limits: { five_hour: { used_percentage: 40, resets_at: T0 + 3600 } } }),
    env: testEnv({ STATUSLINE_TEST_NOW: String(T0) }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /5h \S+ +40%/);
  assert.equal(fs.readFileSync(file, 'utf8'), state);
});

test('a corrupt state file is replaced on the next write', () => {
  fs.writeFileSync(path.join(dir, '.statusline-state.json'), '{not json');
  assert.deepEqual(fiveHour('s1', 40), { shown: '40', stored: 40 });
});
