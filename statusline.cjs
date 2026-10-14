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
// The keepalive flag allows touches up to 120s apart; a touch older than this
// means the server has stopped renewing the cache.
const TOUCH_FRESH = 150;
const KEEPALIVE_WINDOW_DEFAULT = 60;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const GLOBAL_CONFIG = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(os.homedir(), '.claude.json');
// State lives beside the config rather than in a world-writable tmpdir: the
// paths are predictable, and only the owner's directory may hold them. An
// absolute override lets WSL and Windows share one file.
const STATE_FILE = process.env.STATUSLINE_STATE_FILE && path.isAbsolute(process.env.STATUSLINE_STATE_FILE)
  ? process.env.STATUSLINE_STATE_FILE
  : path.join(CONFIG_DIR, '.statusline-state.json');

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

/**
 * Null when the file exists but cannot be read, as during another process's
 * rename; an absent or corrupt file is empty state, so it heals on next write.
 */
function readState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    return error && error.code === 'ENOENT' ? {} : null;
  }
  try {
    const state = JSON.parse(raw);
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
 * The later window wins, and within one window the higher usage, which only
 * rises until the reset; an idle session's stale reading loses either way.
 */
function newer(live, cached) {
  if (!usable(live)) return cached;
  if (!usable(cached)) return live;
  if (live.resets_at !== cached.resets_at) return live.resets_at > cached.resets_at ? live : cached;
  return live.used_percentage >= cached.used_percentage ? live : cached;
}

/**
 * The payload repeats this process's last reading; the state file holds the
 * newest any session has seen. A window past its reset reads zero, one never
 * measured reads unknown, and only real readings are persisted.
 */
function resolveLimits(live, cached) {
  const now = Date.now() / 1000;
  const display = {};
  const persist = {};
  for (const key of ['five_hour', 'seven_day']) {
    const window = newer(live && live[key], cached[key]);
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
 * A server keepalive touch moves expires_at without a new request, so a later
 * expiry at an unchanged request count is a touch. A changed count is activity,
 * which restarts the keepalive window.
 */
function trackActivity(entry, live, prior, now) {
  const requests = typeof live.requests === 'number' ? live.requests : null;
  const sameRun = !!prior && prior.requests === requests;
  entry.requests = requests;
  entry.active_at = sameRun && typeof prior.active_at === 'number' ? prior.active_at : now;
  if (sameRun && live.warm !== false && entry.expires_at > prior.expires_at) entry.touch_seen_at = now;
  else if (prior && typeof prior.touch_seen_at === 'number') entry.touch_seen_at = prior.touch_seen_at;
  return entry;
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
  const prior = keepCache(ownEntry, now) ? ownEntry : null;
  if (live && live.caching_observed) {
    // The CLI dates an absent ttl on the 5m scale, so anything but an explicit
    // 1h must follow it or the colour ramp is out by a factor of twelve.
    const ttl = live.ttl === '1h' ? 3600 : 300;
    let entry = null;
    if (live.warm === false) entry = { expires_at: now, ttl };
    else if (typeof live.expires_at === 'number') entry = { expires_at: live.expires_at, ttl };
    if (entry) {
      trackActivity(entry, live, prior, now);
      return { display: entry, own: entry };
    }
  }
  return { display: prior, own: prior };
}

/** The CLI's global config, or {}; it must be a regular file of sane size, as for the caveman flag. */
function readGlobalConfig() {
  try {
    const stat = fs.lstatSync(GLOBAL_CONFIG);
    if (stat.isFile() && stat.size <= 16 * 1024 * 1024) {
      const config = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf8'));
      if (config && typeof config === 'object') return config;
    }
  } catch {
    /* an unreadable config falls back to the defaults */
  }
  return {};
}

/** The server's keepalive window in seconds, from the CLI's cached feature flags. */
function keepaliveWindow(config) {
  const flag = config.cachedGrowthBookFeatures && config.cachedGrowthBookFeatures.tengu_sequential_cloud;
  const minutes = flag && flag.activityWindowMinutes;
  if (typeof minutes === 'number' && minutes >= 1 && minutes <= 1440) return minutes * 60;
  return KEEPALIVE_WINDOW_DEFAULT * 60;
}

/** Rate limits are per account, so each logged-in account keeps its own slot in the shared file. */
function accountKey(config) {
  const uuid = config.oauthAccount && config.oauthAccount.accountUuid;
  return typeof uuid === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(uuid) ? uuid : 'default';
}

/** A slot is worth keeping while any of its windows has yet to reset. */
function liveSlot(slot, now) {
  return !!slot && ['five_hour', 'seven_day'].some((key) => usable(slot[key]) && slot[key].resets_at > now);
}

/**
 * While keepalive touches arrive, the cache lives until the activity window
 * lapses plus one TTL; a trailing ↻ marks that mode. Grey while there is room,
 * yellow inside the last quarter, red inside the last twelfth, then red COLD.
 */
function cacheTrailer(state, window) {
  if (!state) return '';
  const label = ` ${DIM}· cache${RESET} `;
  const now = Date.now() / 1000;
  if (state.expires_at - now <= 0) return `${label}${RED}   COLD${RESET}`;
  const keepalive = typeof state.touch_seen_at === 'number' && now - state.touch_seen_at <= TOUCH_FRESH;
  // Typing extends the window without a request, so a passed estimate while
  // touches still arrive falls back to the live expiry rather than guessing.
  const estimating = keepalive && typeof state.active_at === 'number' && now < state.active_at + window;
  const target = estimating ? Math.max(state.expires_at, state.active_at + window + state.ttl) : state.expires_at;
  const span = estimating ? window + state.ttl : state.ttl;
  const remaining = target - now;
  const colour = remaining <= span / 12 ? RED : remaining <= span / 4 ? YELLOW : DIM;
  const symbols = [keepalive && `${colour}↻${RESET}`].filter(Boolean);
  const suffix = symbols.length ? ` ${symbols.join(' ')}` : '';
  return `${label}${colour}${countdown(target).padStart(7, ' ')}${RESET}${suffix}`;
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
function commit(sessionId, account, limits, ownCache) {
  const now = Date.now() / 1000;
  const current = readState();
  // Writing over a file we could not read would drop every other session.
  if (!current) return;
  const cache = {};
  for (const [id, entry] of Object.entries(current.cache || {})) {
    if (id !== sessionId && keepCache(entry, now)) cache[id] = entry;
  }
  if (ownCache) cache[sessionId] = ownCache;
  const accounts = {};
  for (const [id, slot] of Object.entries(current.accounts || {})) {
    if (id !== account && liveSlot(slot, now)) accounts[id] = slot;
  }
  if (Object.keys(limits).length) accounts[account] = limits;

  const state = { accounts, cache };
  const before = { accounts: current.accounts || {}, cache: current.cache || {} };
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
  const previous = readState() || {};
  const config = readGlobalConfig();
  const account = accountKey(config);
  const sessionId = String(data.session_id || 'default').replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  const limitState = resolveLimits(data.rate_limits, (previous.accounts || {})[account] || {});
  const cacheState = resolveCache(data.prompt_cache, (previous.cache || {})[sessionId]);
  commit(sessionId, account, limitState.persist, cacheState.own);

  // An unmeasured context is distinct from one a one-line turn rounds to zero.
  const limits = limitState.display;
  const context = data.context_window || {};
  const used = typeof context.used_percentage === 'number' ? context.used_percentage : null;
  segments.push(bar('ctx', used, cacheTrailer(cacheState.display, keepaliveWindow(config))));
  segments.push(bar('5h', limits.five_hour.used_percentage, resetTrailer(limits.five_hour.resets_at)));
  segments.push(bar('7d', limits.seven_day.used_percentage, resetTrailer(limits.seven_day.resets_at)));

  const badge = cavemanBadge();
  if (badge) segments.push(badge);

  return segments.join(`  ${DIM}│${RESET}  `);
}

/** Appends the payload to an absolute STATUSLINE_DEBUG_LOG, for tracing what the CLI sends. */
function debugLog(data) {
  const file = process.env.STATUSLINE_DEBUG_LOG;
  if (!file || !path.isAbsolute(file)) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now() / 1000, payload: data })}\n`, { mode: 0o600 });
  } catch {
    /* a failed log line costs nothing but the line */
  }
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
  debugLog(data);
  process.stdout.write(render(data));
});
