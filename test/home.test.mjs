// Harness for HOME — the landing page's refresh contract and its fold controls.
//
// WHY THIS EXISTS: Home is the one page drawn straight from boot rather than through
// showPage() → rerenderCurrentView(), and it's the one page that edits its own data
// in place (a job saved from the calendar re-draws two cards and nothing else). Both
// of those make it easy to leave a surface behind, and every failure here is silent:
// a stale bell badge, a row that never got its role, a toggle a screen reader can't
// see. None of it throws, and none of it shows up in a diff.
//
//   run:  node test/home.test.mjs
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
// Code with the comments stripped — the comments quote the very patterns under test.
const code = name => extract(name).replace(/^\s*\/\/.*$/gm, '');

// Markup scans run over a comment-stripped copy: the notes explaining these rules
// quote the very markup shapes being searched for.
const markup = src.replace(/^\s*\/\/.*$/gm, '');

// --- Take one <div …> element's full outer HTML by tag depth. ----------------
function divAt(idx) {
  const re = /<\/?div\b/g;
  re.lastIndex = idx;
  let depth = 0, m;
  while ((m = re.exec(markup))) {
    if (m[0] === '<div') depth++; else depth--;
    if (depth === 0) return markup.slice(idx, re.lastIndex + 6);
  }
  return markup.slice(idx);
}

// --- Tiny assert harness (matches the other suites' output style). -----------
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

console.log('\n── Home answers for what it changes ──\n');

test('a job saved or deleted from Home refreshes the bell, not just the cards', () => {
  // The badge counts "missed event" / "event today" rows straight out of cache.jobs,
  // and it also drives the Home Screen app-icon badge. Ticking tonight's job done
  // used to leave the red dot on both until the user changed pages.
  const refresh = code('refreshHomeAfterJobWrite');
  ok(/refreshNotifBadge\(\)/.test(refresh), 'the bell must be rebuilt');
  ok(/renderDashCard\('dash-card-up'\)/.test(refresh), 'the Upcoming card must be redrawn');
  ok(/calendarOpen\(\) *&& *renderCalendar\(\)|if \(calendarOpen\(\)\) renderCalendar\(\)/.test(refresh),
    'the calendar must be redrawn while it is open');
  for (const fn of ['saveJob', 'deleteJobFromModal'])
    ok(/refreshHomeAfterJobWrite\(\)/.test(code(fn)), fn + ' should go through the shared refresh');
});

test('a folded card is still not drawn, and the calendar is only drawn while open', () => {
  // Guards the lazy-draw contract from the other side: the job write path must not
  // quietly reintroduce a full draw of a hidden card.
  const refresh = code('refreshHomeAfterJobWrite');
  ok(!/renderUpcoming\(\)/.test(refresh), 'call renderDashCard, not renderUpcoming directly');
});

test('retrying a failed load re-draws the page you are actually on', () => {
  // This lives on a toast that can be tapped from ANY page. It used to re-render the
  // Dashboard unconditionally, so retrying from Invoices reloaded the data and left
  // the empty list on screen — indistinguishable from the retry failing.
  const body = code('showDataLoadError');
  ok(/rerenderCurrentView\(\)/.test(body), 'retry should call rerenderCurrentView()');
  ok(!/renderDashboard\(\)/.test(body), 'retry should not hard-code the dashboard');
});

console.log('\n── generated Home content keeps its roles ──\n');

test('every innerHTML pass on Home re-runs enhanceA11y', () => {
  // enhanceA11y retrofits role=button/tabindex onto tappable divs. It runs once over
  // the static shell and then only via rerenderCurrentView() — which Home skips on
  // boot (the login paths call renderDashboard directly) and which never fires for
  // a lazily-expanded card or a calendar month change.
  ok(/enhanceA11y\(card\)/.test(code('renderDashCard')), 'a drawn widget should be enhanced');
  ok(/enhanceA11y\(/.test(code('renderCalendar')), 'a redrawn calendar should be enhanced');
});

test('a heading does not disqualify an element from being a control', () => {
  // The guard excludes elements that CONTAIN a real control (wiring those would bury
  // one button inside another). Headings used to be in that list, which disqualified
  // exactly one shape — the fold header — i.e. the collapse toggle of every widget
  // on Home plus the loan schedule.
  const guard = code('enhanceA11y');
  const m = guard.match(/querySelector\('([^']*button[^']*)'\)/);
  ok(m, 'the nested-control guard should still exist');
  ok(!/h[1-6]/.test(m[1]), 'headings must not be in the nested-control guard: ' + m[1]);
  ok(/button/.test(m[1]) && /input/.test(m[1]), 'real controls must still disqualify: ' + m[1]);
});

console.log('\n── fold controls ──\n');

test('every fold header is reachable — by itself or through its chevron', () => {
  // Two routes, and each header must have exactly one of them:
  //   • no nested control  → enhanceA11y makes the header itself the button
  //   • a nested control   → the card is .collapsible, and markFoldState wires the
  //     chevron instead (a button inside a role=button hides the inner one from AT)
  let idx = -1, seen = 0;
  while ((idx = markup.indexOf('<div class="card-header" onclick=', idx + 1)) >= 0) {
    const html = divAt(idx);
    seen++;
    if (!/<h[1-6][ >]/.test(html)) continue;          // not a titled fold header
    const nested = /<button\b|<a\b|<input\b|<select\b|<textarea\b/.test(html);
    if (!nested) continue;                            // enhanceA11y wires it
    const tag = markup.slice(idx, markup.indexOf('>', idx) + 1);
    ok(/toggleDashCard\(/.test(tag),
      'a fold header holding a control must be a .collapsible card (toggleDashCard), '
      + 'so markFoldState can wire its chevron instead — found: ' + tag.slice(0, 90));
    ok(/dash-chev/.test(html), 'and it needs a chevron to wire');
  }
  ok(seen >= 5, 'expected to find the dashboard fold headers, saw ' + seen);
  // ...and a toggleDashCard header only reaches markFoldState if its card is
  // .collapsible, which is what applyDashCollapsed() walks.
  const cards = markup.match(/<div class="card[^"]*" id="dash-card-(?:up|flow|cat)"[^>]*>/g) || [];
  eq(cards.length, 3, 'the three lazily-drawn widgets');
  cards.forEach(c => ok(/collapsible/.test(c), 'should be collapsible: ' + c.slice(0, 80)));
});

test('folding announces itself — aria-expanded is set and kept in step', () => {
  const mark = code('markFoldState');
  ok(/setAttribute\('role', *'button'\)/.test(mark), 'the control gets role=button');
  ok(/setAttribute\('tabindex', *'0'\)/.test(mark), 'and is focusable');
  ok(/aria-expanded/.test(mark), 'and reports its state');
  ok(/stopPropagation\(\)/.test(mark),
    'a chevron control must stop the header onclick — both firing toggles twice, back to where it started');
  // Applied on first paint AND on every toggle, or the state goes stale.
  ok(/markFoldState\(card\)/.test(code('applyDashCollapsed')), 'applied when the saved state is restored');
  ok(/markFoldState\(card\)/.test(code('toggleDashCard')), 'and updated on every toggle');
  // Calendar + Reports fold by inline display, so they never reach markFoldState.
  for (const fn of ['toggleCalendar', 'toggleReports'])
    ok(/setHeaderExpanded\(/.test(code(fn)), fn + ' should update aria-expanded');
  for (const id of ['calendar-body', 'reports-body']) {
    const body = src.indexOf('id="' + id + '"');
    ok(body > 0, id + ' not found');
    const header = src.lastIndexOf('<div class="card-header"', body);
    ok(/aria-expanded="false"/.test(src.slice(header, body)),
      id + "'s header should start out marked closed (both bodies ship display:none)");
  }
});

test('the chevron stays visible on a folded card', () => {
  // markFoldState wires the chevron as the control for a header that holds a button,
  // so the rule that strips a collapsed header down to its title has to keep it.
  const rule = src.match(/\.card\.collapsed>\.card-header>\*:not\([^{]*\)\{display:none!important\}/);
  ok(rule, 'the collapsed-header strip rule should still exist');
  ok(/:not\(\.dash-chev\)/.test(rule[0]), 'the chevron must be exempt: ' + rule[0]);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
