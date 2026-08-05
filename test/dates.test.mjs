// Harness for "what day is it" — the app's LOCAL calendar-date reads.
//
// WHY THIS EXISTS: every date in this app is a bare 'YYYY-MM-DD' string typed by a
// human in Montana, but `today()` used to derive that string with toISOString(),
// which formats in UTC. West of Greenwich that flips to TOMORROW every evening
// (6pm in MDT, 5pm in MST). Nothing errored — the app just quietly disagreed with
// the wall clock for the last third of every day:
//
//   • an invoice due today was rendered "overdue" (and pushed as such)
//   • a job scheduled for tonight became a "missed event" in the bell
//   • the calendar's today-ring sat on tomorrow, and "Today" selected tomorrow
//   • an expense logged after supper saved with TOMORROW's date
//
// parseDate() has always parsed at LOCAL NOON specifically to dodge this bug in
// the other direction; today() was the hole in the same wall. These tests run the
// SHIPPED functions (extracted out of index.html, same approach as the other
// suites) against a frozen clock in several timezones.
//
//   run:  node test/dates.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// --- Extract a top-level `function name(...) {...}` by brace matching. --------
// Comment-aware (contractions in comments would otherwise read as string quotes).
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('cannot find function ' + name);
  let i = src.indexOf('{', start), depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// --- Sandbox with a FROZEN clock. --------------------------------------------
// `new Date()` (no args) returns the given instant; every other form behaves
// normally, so `new Date(y, m, d)` still builds a local date and the timezone
// comes from process.env.TZ at call time.
function frozen(iso) {
  const t = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (!a.length) super(t); else super(...a); }
    static now() { return t; }
  };
}

// The date helpers + the two readers that consume them most visibly.
function sandbox(iso) {
  const factory = new Function('Date', 'profile', `
    ${extract('ymd')}
    ${extract('today')}
    ${extract('invDefaultDue')}
    ${extract('_daysAhead')}
    ${extract('parseDate')}
    ${extract('effectiveStatus')}
    return { ymd, today, invDefaultDue, _daysAhead, parseDate, effectiveStatus };
  `);
  return factory(frozen(iso), {});
}

// --- Tiny assert harness (matches the other suites' output style). -----------
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { process.env.TZ = prev; }
}

console.log('\n── local calendar date ──\n');

// 2026-08-05 19:30 in Denver (MDT, UTC-6) is already 2026-08-06 in UTC. This is
// the exact window the owner uses the app in: after supper.
test('an evening in Montana is still TODAY, not tomorrow', () => {
  withTZ('America/Denver', () => {
    const s = sandbox('2026-08-06T01:30:00Z');
    eq(s.today(), '2026-08-05', 'today() at 7:30pm MDT');
    eq(new Date('2026-08-06T01:30:00Z').toISOString().slice(0, 10), '2026-08-06',
       'the UTC read this replaced — same instant, wrong day');
  });
});

// Winter: MST is UTC-7, so the old bug started an hour earlier (5pm).
test('and in winter, when the flip used to start at 5pm', () => {
  withTZ('America/Denver', () => {
    eq(sandbox('2026-01-16T00:30:00Z').today(), '2026-01-15', 'today() at 5:30pm MST');
  });
});

// New Year's Eve is where the year — not just the day — went wrong: the YTD
// revenue/expense totals bucket by LOCAL year (parseDate), so a UTC-derived
// "this year" would have compared them against the wrong one.
test('New Year rolls at local midnight, not six hours early', () => {
  withTZ('America/Denver', () => {
    const s = sandbox('2027-01-01T04:00:00Z');   // 9pm Dec 31 in Denver
    eq(s.today(), '2026-12-31');
    eq(s.today().slice(0, 4), '2026', 'the year the mileage + spend cards read');
  });
});

// The mirror-image failure: east of Greenwich a LOCAL-midnight date converted
// through UTC reads as YESTERDAY. ymd() is correct in both directions, which is
// what makes it safe for the calendar's own cell keys.
test('and a morning east of Greenwich is not yesterday', () => {
  withTZ('Asia/Tokyo', () => {
    const s = sandbox('2026-08-04T21:00:00Z');   // 6am Aug 5 in Tokyo
    eq(s.today(), '2026-08-05');
    eq(s.ymd(new Date(2026, 7, 5)), '2026-08-05', 'a local date built from parts');
  });
});

test('UTC itself is unchanged — the old behavior where it was right', () => {
  withTZ('UTC', () => eq(sandbox('2026-08-05T19:30:00Z').today(), '2026-08-05'));
});

console.log('\n── what the wrong day actually broke ──\n');

test('an invoice due today does not read as overdue after supper', () => {
  withTZ('America/Denver', () => {
    const s = sandbox('2026-08-06T01:30:00Z');   // 7:30pm MDT on the 5th
    const inv = { status: 'sent', due: '2026-08-05', total: 200, amount_paid: 0 };
    eq(s.effectiveStatus(inv), 'sent', 'due TODAY is not yet past due');
    eq(s.effectiveStatus({ ...inv, due: '2026-08-04' }), 'overdue', 'yesterday still is');
  });
});

test('a new record dated "today" saves with today on it', () => {
  withTZ('America/Denver', () => {
    // Every form default (expense, trip, job, invoice, payment) is today().
    eq(sandbox('2026-08-06T01:30:00Z').today(), '2026-08-05');
  });
});

test('the 30-day Upcoming horizon and the notification window count from today', () => {
  withTZ('America/Denver', () => {
    const s = sandbox('2026-08-06T01:30:00Z');
    eq(s._daysAhead(3), '2026-08-08', 'the bell’s "coming up" horizon');
    eq(s._daysAhead(0), s.today(), 'zero days ahead is today');
  });
});

test('an invoice due date is the issue date plus the payment window', () => {
  withTZ('America/Denver', () => {
    const s = sandbox('2026-08-06T01:30:00Z');
    eq(s.invDefaultDue(), '2026-09-04', '30 days from Aug 5');
  });
});

test('a DST spring-forward day still advances exactly one calendar day', () => {
  withTZ('America/Denver', () => {
    // 2026-03-08 is the US spring-forward. A day here is 23 hours long, so any
    // arithmetic done in milliseconds would land back on the 8th.
    eq(sandbox('2026-03-08T18:00:00Z')._daysAhead(1), '2026-03-09');
    eq(sandbox('2026-11-01T18:00:00Z')._daysAhead(1), '2026-11-02', 'and fall-back');
  });
});

console.log('\n── the shipped source keeps no UTC date reads ──\n');

// The static half: the bug is trivially reintroduced by one more
// `new Date().toISOString().slice(0,10)`, and it looks completely normal in review.
// Anything deriving a calendar date from the CURRENT instant has to go through
// ymd()/today(). (Full timestamps — clock_in/clock_out, audit stamps — are fine:
// they keep the instant, they don't truncate it to a day.)
test('no calendar date is derived from the current instant via UTC', () => {
  // Comments stripped first — the note explaining this bug quotes the old call.
  const script = src.slice(src.indexOf('<script>', src.indexOf('</style>')))
    .replace(/^\s*\/\/.*$/gm, '');
  const offenders = [];
  // `new Date()` / `Date.now()`-seeded values truncated to a day or month key.
  const re = /new Date\((?:\)|Date\.now\(\))[^;\n]*?\.toISOString\(\)\.slice\(0,\s*(?:10|7|4)\)/g;
  let m; while ((m = re.exec(script))) offenders.push(m[0]);
  // `const d = new Date(); … d.toISOString().slice(0,10)` — the two-step form.
  const lines = script.split('\n');
  lines.forEach((ln, i) => {
    if (!/\.toISOString\(\)\.slice\(0,\s*(?:10|7|4)\)/.test(ln)) return;
    // Fine when the value came from parseDate() (local noon) or a stored string.
    if (/parseDate\(/.test(ln)) return;
    const around = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
    if (/=\s*new Date\(\s*\)/.test(around)) offenders.push(lines[i].trim());
  });
  ok(offenders.length === 0, 'use ymd()/today() instead:\n      ' + offenders.join('\n      '));
});

// The other half of the same rule: a STORED timestamp truncated to a day is just as
// wrong, and it doesn't need `new Date()` to get there. The Time Log's From/To
// filter sliced clock_in's ISO string, so an evening punch was filed under tomorrow
// while the row beside it printed today (test/time.test.mjs has the full story).
test('no stored timestamp is truncated to a day in UTC either', () => {
  const script = src.slice(src.indexOf('<script>', src.indexOf('</style>')))
    .replace(/^\s*\/\/.*$/gm, '');
  // Columns that hold an INSTANT. Date-only columns (date, due, next_date, paid_date)
  // are bare 'YYYY-MM-DD' strings — slicing those is fine and common.
  const stamps = 'clock_in|clock_out|created_at|updated_at|reminded_at';
  const offenders = [...script.matchAll(new RegExp('\\b(?:' + stamps + ')\\b[^;\\n]*?\\.slice\\(\\s*0\\s*,\\s*(?:10|7|4)\\s*\\)', 'g'))]
    .map(m => m[0].trim());
  ok(offenders.length === 0,
     'truncate it with ymd(new Date(ts)) — an ISO slice is the UTC day:\n      ' + offenders.join('\n      '));
});

test('today() is the single definition, and it is local', () => {
  eq((src.match(/function today\(\)/g) || []).length, 1, 'one today()');
  eq((src.match(/function ymd\(/g) || []).length, 1, 'one ymd()');
  ok(/function today\(\)\s*\{\s*return ymd\(new Date\(\)\);\s*\}/.test(src), 'today() delegates to ymd()');
  // ymd() must be declared before the calendar/budget code that leans on it, but
  // function declarations hoist — what actually matters is that it stays top-level.
  ok(/\nfunction ymd\(/.test(src), 'ymd() is top-level, not nested in another function');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
