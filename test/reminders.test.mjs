// The Worker's reminder scheduling math.
//
// WHY THIS EXISTS: a job reminder fires at `remind_minutes` before the job's
// America/Denver wall-clock time, and the whole thing hangs on wallToUtc() turning
// "2026-11-01" + "06:00:00" into the right UTC instant. That conversion samples the
// zone offset, and it was sampling it at the WRONG instant — the wall time read as
// UTC, six or seven hours before the event. Right all year except where those two
// samples straddle a DST transition: a 2:00-8:30am band on the two switch days came
// out a full hour off. A 6am reminder arriving at 5am reads as "the app is broken"
// and can never be reproduced afterwards, which is exactly the class of bug that
// survives forever without a test.
//
// These are pure Date/Intl functions, so unlike the rest of the Worker they run
// directly under Node (full ICU) against the real shipped source.
//
//   run:  node test/reminders.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'worker', 'push-cron.js'), 'utf8');

// Brace-match a top-level function out of the Worker (same trick the other suites
// use on index.html), so the tests always run the shipped code.
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('cannot find function ' + name);
  let i = src.indexOf('{', start), depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const TZ = 'America/Denver';
const { wallToUtc } = new Function(
  `const TZ = '${TZ}';` + extract('wallToUtc') + extract('tzOffsetMin') + 'return { wallToUtc };'
)();

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// The round trip that matters: convert to UTC, then read that instant back in
// Denver. It must be the wall time we started from.
function readsBack(day, time) {
  const ms = wallToUtc(day, time);
  return new Date(ms).toLocaleString('en-US', { timeZone: TZ, hour12: false }).split(', ')[1];
}
function everyHalfHour(day, skip = []) {
  const wrong = [];
  for (let h = 0; h < 24; h++) for (const m of ['00', '30']) {
    const t = `${String(h).padStart(2, '0')}:${m}:00`;
    if (skip.includes(t)) continue;
    const got = readsBack(day, t);
    if (got !== t) wrong.push(`${t} → ${got}`);
  }
  return wrong;
}

console.log('\nWORKER reminder scheduling (America/Denver)\n');

test('an ordinary summer and winter time converts exactly', () => {
  ok(wallToUtc('2026-08-04', '14:30:00') === Date.parse('2026-08-04T20:30:00Z'), 'MDT is UTC-6');
  ok(wallToUtc('2026-01-15', '09:00:00') === Date.parse('2026-01-15T16:00:00Z'), 'MST is UTC-7');
});

test('the seconds-less "HH:MM" shape from the client converts the same', () => {
  ok(wallToUtc('2026-08-04', '14:30') === wallToUtc('2026-08-04', '14:30:00'),
    'jobs.time can arrive either way');
});

test('every half hour on the fall-back day is correct', () => {
  // 2026-11-01: 02:00 MDT → 01:00 MST. The old one-pass conversion fired the whole
  // 02:00–07:30 band an hour EARLY.
  const wrong = everyHalfHour('2026-11-01');
  ok(wrong.length === 0, 'off by an hour: ' + wrong.join(', '));
});

test('every half hour on the spring-forward day is correct', () => {
  // 2026-03-08: 02:00 MST → 03:00 MDT, so 02:00 and 02:30 are wall times that DO
  // NOT EXIST. They are excluded because there is no right answer, not because
  // they are tolerated failures. Everything else used to be an hour LATE.
  const wrong = everyHalfHour('2026-03-08', ['02:00:00', '02:30:00']);
  ok(wrong.length === 0, 'off by an hour: ' + wrong.join(', '));
});

test('a full year of 6am reminders lands at 6am', () => {
  // The single most likely real reminder — first appointment of the day — checked
  // on every date of the year rather than only near the transitions.
  const wrong = [];
  for (let d = new Date(Date.UTC(2026, 0, 1)); d.getUTCFullYear() === 2026; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const got = readsBack(day, '06:00:00');
    if (got !== '06:00:00') wrong.push(`${day} → ${got}`);
  }
  ok(wrong.length === 0, wrong.join(', '));
});

test('the dedupe stamp reports whether it actually wrote', () => {
  // Both reminder loops dedupe by PATCHing reminded_at / reminded_date. A silently
  // dropped write means the same reminder goes out again every minute.
  const body = extract('supaPatch');
  ok(/r\.ok/.test(body), 'supaPatch ignores the response status');
  ok(/return (true|false)/.test(body), 'supaPatch does not report success to callers');
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
