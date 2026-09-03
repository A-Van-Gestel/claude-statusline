/**
 * Claude Code status line: model and effort, context %, prompt-cache TTL,
 * and 5h / 7d rate-limit bars.
 * Zero dependencies, no subprocesses: runs identically on Linux, macOS and Windows.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BAR_WIDTH = 10;
const FILLED = '█';
const EMPTY = '░';
const CACHE_KEEP = 24 * 3600;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// State lives beside the config rather than in a world-writable tmpdir: the
// paths are predictable, and only the owner's directory may hold them.
const STATE_FILE = path.join(CONFIG_DIR, '.statusline-state.json');

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[2;32m';
const YELLOW = '\x1b[2;33m';
const RED = '\x1b[2;31m';
const ORANGE = '\x1b[38;5;172m';

/** Colour ramp shared by every gauge so the three bars read as one scale. */
function colourFor(pct) {
  if (pct >= 90) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

/**
 * Time remaining, gaining precision as it shrinks: d:hh, then h:mm, then m:ss
 * inside the last ten minutes, where a whole minute of "0h 00m" would hide the
 * part that matters. Every form is at most seven columns wide.
 */
function countdown(target) {
  if (typeof target !== 'number') return '';
  const seconds = Math.max(0, Math.floor(target - Date.now() / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${pad(Math.floor((seconds % 86400) / 3600))}h`;
  if (seconds >= 600) return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
}

/** A null percentage means nothing has been measured yet, which reads as --%. */
function bar(label, pct, trailer) {
  if (pct === null) {
    return `${DIM}${label}${RESET} ${DIM}${EMPTY.repeat(BAR_WIDTH)}${RESET} ${DIM} --%${RESET}${trailer || ''}`;
  }
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.round((clamped / 100) * BAR_WIDTH);
  // Reserve a full bar for 100% and a visible sliver for anything above zero.
  if (filled === BAR_WIDTH && clamped < 100) filled = BAR_WIDTH - 1;
  if (filled === 0 && clamped > 0) filled = 1;
  const gauge = FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
  // The gauge saturates but the number does not, so an overage still reads true.
  const value = String(Math.round(pct)).padStart(3, ' ');
  return `${DIM}${label}${RESET} ${colourFor(clamped)}${gauge}${RESET} ${DIM}${value}%${RESET}${trailer || ''}`;
}

/** Window resets are account-wide, so the slot holds its place even unknown. */
function resetTrailer(resetsAt) {
  const left = countdown(resetsAt) || '--';
  return ` ${DIM}· ${left.padStart(7, ' ')}${RESET}`;
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

/**
 * Rename in, so a session reading mid-write sees the old file rather than half
 * of one. The temp name is exclusive, so it cannot be pre-planted as a symlink.
 */
function writeState(state) {
  const temp = `${STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, STATE_FILE);
  } catch {
    /* an unwritable config dir costs us the cache, not the status line */
    try { fs.unlinkSync(temp); } catch { /* nothing to clean up */ }
  }
}

/** A window is only usable if it carries both a reading and its reset time. */
function usable(window) {
  return !!window
    && typeof window.used_percentage === 'number'
    && typeof window.resets_at === 'number';
}

/**
 * Rate limits vanish from the payload between API responses, which would make
 * the bars flicker, so the last usable reading is kept until it is replaced.
 * A window past its reset is genuinely back to zero and says so; one never
 * measured is unknown, and says that instead of claiming an idle account.
 * Only real readings are persisted — never a placeholder, which would leak
 * into the next session as if it had been measured.
 */
function resolveLimits(live, cached) {
  const now = Date.now() / 1000;
  const display = {};
  const persist = {};
  for (const key of ['five_hour', 'seven_day']) {
    // Presence is not usability: a partial live window must not shadow a good
    // cached one, or the reading would be lost rather than merely stale.
    const liveWindow = live && live[key];
    const window = usable(liveWindow) ? liveWindow : cached[key];
    if (!usable(window)) {
      display[key] = { used_percentage: null };
      continue;
    }
    // Keeping the expired window is what lets its zero survive past one frame.
    display[key] = window.resets_at < now ? { used_percentage: 0 } : window;
    persist[key] = window;
  }
  return { display, persist };
}

/** Entries stay readable for a day past expiry, so COLD can still be shown. */
function keepCache(entry, now) {
  return !!entry
    && typeof entry.expires_at === 'number'
    && now - entry.expires_at < CACHE_KEEP;
}

/**
 * A resumed session runs in a fresh process whose in-memory prompt-cache
 * tracker is empty, so the payload carries no reading until its first response
 * even while the cache is still warm. The last expiry bridges that gap; a live
 * reading always wins. An eviction is stored as an already-lapsed entry, which
 * is what lets COLD survive the frames that carry no reading of their own.
 */
function resolveCache(live, ownEntry) {
  const now = Date.now() / 1000;
  if (live && live.caching_observed) {
    // The CLI dates an absent ttl on the 5m scale, so anything but an explicit
    // 1h must follow it or the colour ramp is out by a factor of twelve.
    const ttl = live.ttl === '1h' ? 3600 : 300;
    if (live.warm === false) {
      const entry = { expires_at: now, ttl };
      return { display: entry, own: entry };
    }
    if (typeof live.expires_at === 'number') {
      const entry = { expires_at: live.expires_at, ttl };
      return { display: entry, own: entry };
    }
  }
  const own = keepCache(ownEntry, now) ? ownEntry : null;
  return { display: own, own };
}

/**
 * Grey while there is room, yellow inside the last quarter of the TTL, red
 * inside the last twelfth, then red COLD. Absent until a turn has been cached.
 */
function cacheTrailer(state) {
  if (!state) return '';
  const label = ` ${DIM}· cache${RESET} `;
  const remaining = state.expires_at - Date.now() / 1000;
  if (remaining <= 0) return `${label}${RED}   COLD${RESET}`;
  const colour = remaining <= state.ttl / 12 ? RED : remaining <= state.ttl / 4 ? YELLOW : DIM;
  return `${label}${colour}${countdown(state.expires_at).padStart(7, ' ')}${RESET}`;
}

/**
 * Optional caveman-plugin badge: without the plugin its flag file is absent
 * and nothing renders. The flag must be a small regular file — a symlink could
 * point at anything readable, and opening a FIFO would hang the status line.
 */
function cavemanBadge() {
  const flag = path.join(CONFIG_DIR, '.caveman-active');
  const allowed = new Set(['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan',
    'wenyan-full', 'wenyan-ultra', 'commit', 'review', 'compress']);
  let mode;
  try {
    const stat = fs.lstatSync(flag);
    if (!stat.isFile() || stat.size > 64) return '';
    mode = fs.readFileSync(flag, 'utf8').slice(0, 64).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  } catch {
    return '';
  }
  if (!allowed.has(mode) || mode === 'off') return '';
  const text = mode === 'full' ? '[CAVEMAN]' : `[CAVEMAN:${mode.toUpperCase()}]`;
  return `${ORANGE}${text}${RESET}`;
}

/**
 * Persist this session's own slice, taking every other session's entry from a
 * read taken now rather than from the one this frame started with — otherwise
 * a concurrent session's freshly written expiry is dropped, and a resumed one
 * would not rewrite it until its next turn.
 */
function commit(sessionId, limits, ownCache) {
  const now = Date.now() / 1000;
  const current = readState();
  const cache = {};
  for (const [id, entry] of Object.entries(current.cache || {})) {
    if (id !== sessionId && keepCache(entry, now)) cache[id] = entry;
  }
  if (ownCache) cache[sessionId] = ownCache;

  const state = { limits, cache };
  const before = { limits: current.limits || {}, cache: current.cache || {} };
  if (JSON.stringify(state) !== JSON.stringify(before)) writeState(state);
}

function render(data) {
  const name = (data.model && data.model.display_name) || 'Claude';
  const effortLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  const effort = data.effort && data.effort.level;
  const label = effortLevels.has(effort) ? `${name} - ${effort}` : name;
  const segments = [`${DIM}${label}${RESET}`];

  // Windows are account-wide, so a new session inherits the last known reading
  // instead of starting blind; the cache expiry belongs to one session.
  const previous = readState();
  const sessionId = String(data.session_id || 'default').replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  const limitState = resolveLimits(data.rate_limits, previous.limits || {});
  const cacheState = resolveCache(data.prompt_cache, (previous.cache || {})[sessionId]);
  commit(sessionId, limitState.persist, cacheState.own);

  // An unmeasured context is distinct from one a one-line turn rounds to zero.
  const limits = limitState.display;
  const context = data.context_window || {};
  const used = typeof context.used_percentage === 'number' ? context.used_percentage : null;
  segments.push(bar('ctx', used, cacheTrailer(cacheState.display)));
  segments.push(bar('5h', limits.five_hour.used_percentage, resetTrailer(limits.five_hour.resets_at)));
  segments.push(bar('7d', limits.seven_day.used_percentage, resetTrailer(limits.seven_day.resets_at)));

  const badge = cavemanBadge();
  if (badge) segments.push(badge);

  return segments.join(`  ${DIM}│${RESET}  `);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let data = {};
  try {
    data = JSON.parse(raw) || {};
  } catch {
    /* render what we can from an unparseable payload */
  }
  process.stdout.write(render(data));
});
