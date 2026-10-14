/**
 * Manual check, not part of `node --test`: renders three sessions round-robin
 * against one state file and prints failures plus render timings. Run several
 * at once, from Windows and WSL, to exercise concurrent writers.
 *   node test/stress.cjs <absolute state file> <session prefix> <iterations>
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'statusline.cjs');
const [stateFile, prefix = 's', iterations = '30'] = process.argv.slice(2);
if (!stateFile || !path.isAbsolute(stateFile)) {
  console.error('usage: node test/stress.cjs <absolute state file> <session prefix> <iterations>');
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);
const times = [];
let failures = 0;
for (let i = 0; i < Number(iterations); i++) {
  const payload = {
    session_id: `${prefix}${i % 3}`,
    rate_limits: { five_hour: { used_percentage: i % 50, resets_at: now + 3600 } },
    prompt_cache: { caching_observed: true, warm: true, ttl: '5m', expires_at: now + 300, requests: 1 },
  };
  const start = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    env: { ...process.env, STATUSLINE_STATE_FILE: stateFile },
    encoding: 'utf8',
  });
  times.push(Number(process.hrtime.bigint() - start) / 1e6);
  if (result.status !== 0 || !result.stdout.includes('5h')) failures++;
}

times.sort((a, b) => a - b);
const at = (q) => times[Math.floor(q * (times.length - 1))].toFixed(1);
console.log(`${prefix} n=${times.length} failures=${failures} p50=${at(0.5)}ms p95=${at(0.95)}ms max=${at(1)}ms`);
