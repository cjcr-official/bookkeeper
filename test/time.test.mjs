// Time Clock — a punch belongs to the day it happened HERE.
//
// WHY THIS EXISTS: a punch stores two full timestamps (clock_in/clock_out), and the
// Time Log's From/To filter truncated clock_in to a day by slicing its ISO string —
// which is UTC. West of Greenwich that is the wrong day every evening: a 7:30pm
// punch in Montana is already tomorrow in UTC. The row printed "Aug 4" (fmtDayShort
// is local) and the filter filed it under Aug 5, so:
//
//   • filtering Aug 4 → Aug 4 hid an entry the app had just drawn as Aug 4
//   • the header's hours + dollar total for that range silently excluded it
//   • so did any "create invoice" selection made from that filtered view —
//     an evening's work simply wasn't on the invoice, with nothing to see
//
// Nothing errors; the totals are just quietly short. Same family as the today()
// bug pinned by test/dates.test.mjs — truncating an instant to a calendar day is
// always a LOCAL read (ymd()), never toISOString().
//
// These tests run the SHIPPED functions, extracted out of index.html.
//
//   run:  node test/time.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// --- Extract a top-level `function name(...) {...}` by brace matching. --------
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

// The punch-clock readers, over a caller-supplied cache + profile. _timeFrom /
// _timeTo are module state in the app; the sandbox exposes a setter for them.
function sandbox(entries, prof) {
  const factory = new Function('cache', 'profile', `
    let _timeFrom = '', _timeTo = '';
    ${extract('ymd')}
    ${extract('hoursBetween')}
    ${extract('fmtDur')}
    ${extract('currentHourlyRate')}
    ${extract('entryRate')}
    ${extract('timeDay')}
    ${extract('timeFiltered')}
    return {
      setRange: (a, b) => { _timeFrom = a; _timeTo = b; },
      timeDay, timeFiltered, hoursBetween, fmtDur, entryRate, ymd,
    };
  `);
  return factory({ time_entries: entries }, prof || {});
}

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

// 6:30pm–8:00pm on Aug 4th in Denver (MDT, UTC-6) — already Aug 5th in UTC.
const evening = { id: 'e1', label: 'Evening callout', rate: 80,
                  clock_in: '2026-08-05T00:30:00Z', clock_out: '2026-08-05T02:00:00Z' };
// A plain midday punch on the 5th, same zone.
const midday  = { id: 'e2', label: 'Bench work', rate: 80,
                  clock_in: '2026-08-05T18:00:00Z', clock_out: '2026-08-05T20:00:00Z' };
// Still clocked in — lives in the punch card, never in the list.
const running = { id: 'e3', label: 'Now', rate: 80, clock_in: '2026-08-05T21:00:00Z', clock_out: null };

console.log('\n── a punch is filed under the LOCAL day it started ──\n');

test('an evening punch belongs to that evening, not to tomorrow', () => {
  withTZ('America/Denver', () => {
    const s = sandbox([evening]);
    eq(s.timeDay(evening), '2026-08-04', 'the day the list prints for this row');
    eq(evening.clock_in.slice(0, 10), '2026-08-05',
       'the UTC read this replaced — same instant, wrong day');
  });
});

test('filtering that day finds the entry the list is showing', () => {
  withTZ('America/Denver', () => {
    const s = sandbox([evening, midday]);
    s.setRange('2026-08-04', '2026-08-04');
    eq(s.timeFiltered().length, 1, 'Aug 4 → Aug 4');
    eq(s.timeFiltered()[0].id, 'e1');
  });
});

test('and the next day does NOT pick it up', () => {
  withTZ('America/Denver', () => {
    const s = sandbox([evening, midday]);
    s.setRange('2026-08-05', '2026-08-05');
    eq(s.timeFiltered().map(t => t.id).join(','), 'e2', 'only the midday punch is the 5th');
  });
});

test('the billable total for a day includes its evening work', () => {
  withTZ('America/Denver', () => {
    const s = sandbox([evening, midday]);
    s.setRange('2026-08-04', '2026-08-04');
    const rows = s.timeFiltered();
    const hrs = rows.reduce((a, t) => a + s.hoursBetween(t.clock_in, t.clock_out), 0);
    const amt = rows.reduce((a, t) => a + s.hoursBetween(t.clock_in, t.clock_out) * s.entryRate(t), 0);
    eq(hrs, 1.5, 'hours in range');
    eq(amt, 120, '1.5h × $80 — the figure that would have been billed as $0');
  });
});

test('an open range still returns everything', () => {
  withTZ('America/Denver', () => {
    const s = sandbox([evening, midday]);
    s.setRange('', '');
    eq(s.timeFiltered().length, 2);
  });
});

test('east of Greenwich a morning punch is not yesterday', () => {
  withTZ('Asia/Tokyo', () => {
    // 6am Aug 5 in Tokyo is still Aug 4 in UTC — the mirror-image failure.
    const t = { id: 'j', clock_in: '2026-08-04T21:00:00Z', clock_out: '2026-08-04T22:00:00Z' };
    const s = sandbox([t]);
    eq(s.timeDay(t), '2026-08-05');
    s.setRange('2026-08-05', '2026-08-05');
    eq(s.timeFiltered().length, 1);
  });
});

test('UTC itself is unchanged — where the old read happened to be right', () => {
  withTZ('UTC', () => {
    const s = sandbox([evening]);
    eq(s.timeDay(evening), '2026-08-05');
  });
});

console.log('\n── what the list is allowed to contain ──\n');

test('a running punch is not in the list (it lives in the punch card)', () => {
  withTZ('America/Denver', () => {
    const s = sandbox([running, midday]);
    s.setRange('', '');
    eq(s.timeFiltered().map(t => t.id).join(','), 'e2');
  });
});

test('entries come back newest first', () => {
  withTZ('America/Denver', () => {
    const s = sandbox([evening, midday]);
    s.setRange('', '');
    eq(s.timeFiltered().map(t => t.id).join(','), 'e2,e1');
  });
});

console.log('\n── hours and money ──\n');

test('duration is derived from the two timestamps, never stored', () => {
  const s = sandbox([]);
  eq(s.hoursBetween('2026-08-05T00:30:00Z', '2026-08-05T02:00:00Z'), 1.5);
  eq(s.fmtDur(1.5), '1:30:00');
  eq(s.fmtDur(0), '0:00:00');
});

test('a backwards pair reads as zero, never as negative money', () => {
  const s = sandbox([]);
  eq(s.hoursBetween('2026-08-05T02:00:00Z', '2026-08-05T00:30:00Z'), 0);
});

test('a punch across the DST spring-forward is real elapsed time', () => {
  withTZ('America/Denver', () => {
    // 1:30am–3:30am on 2026-03-08 is TWO wall-clock hours but ONE real hour.
    const s = sandbox([]);
    eq(s.hoursBetween('2026-03-08T08:30:00Z', '2026-03-08T09:30:00Z'), 1,
       'billed hours follow the clock that actually ran');
  });
});

test('the entry keeps its own rate; only a blank one follows the profile', () => {
  const s = sandbox([], { hourly_rate: 95 });
  eq(s.entryRate({ rate: 80 }), 80, 'the rate recorded at punch time wins');
  eq(s.entryRate({ rate: null }), 95, 'unset falls back to the current rate');
  eq(s.entryRate({ rate: 0 }), 0, 'an explicit zero is not "unset"');
  eq(sandbox([], {}).entryRate({ rate: null }), 0, 'no rate anywhere is zero, not NaN');
});

console.log('\n── the shipped source keeps one definition of a punch day ──\n');

test('nothing truncates a punch timestamp in UTC', () => {
  const script = src.slice(src.indexOf('<script>', src.indexOf('</style>')))
    .replace(/^\s*\/\/.*$/gm, '');   // the comment explaining this bug quotes the old call
  const offenders = [...script.matchAll(/\b(?:clock_in|clock_out)\b[^;\n]*?\.slice\(\s*0\s*,\s*(?:10|7|4)\s*\)/g)]
    .map(m => m[0].trim());
  ok(offenders.length === 0,
     'use timeDay()/ymd() — an ISO slice is the UTC day:\n      ' + offenders.join('\n      '));
});

test('the filter and the printed date read the same clock', () => {
  ok(/function timeDay\(/.test(src), 'timeDay() is the single local-day read');
  ok(/timeDay\(t\)/.test(extract('timeFiltered')), 'timeFiltered() goes through it');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
