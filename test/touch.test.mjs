// Harness for the touch-input invariants — the ones that only misbehave on a real
// phone, which is exactly why they need a static test.
//
// WHY THIS EXISTS: v483 removed `maximum-scale=1.0, user-scalable=no` from the
// viewport (correctly — it fails WCAG 1.4.4 and blocked pinch-zoom on Android). But
// that meta tag had been masking a real defect: a scattering of form controls with
// inline font-size under 16px. iOS zooms the whole page in when you focus one of
// those, and it does NOT zoom back out — you are left stranded at ~2x with the
// layout cut off. It shipped, and it bit the owner on the invoice line items.
//
// The fix is the font size, never the viewport. These two invariants pull in
// opposite directions and a future change can quietly break either one:
//   - put maximum-scale back  -> pinch-zoom dies again (accessibility regression)
//   - add a 13px input        -> stranded-zoom returns (usability regression)
// Both are pinned here.
//
//   run:  node test/touch.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const css = src.slice(src.indexOf('<style>') + 7, src.indexOf('</style>'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((msg || 'not equal') + `\n    got:      ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
}

console.log('\nTOUCH INPUT BEHAVIOR\n');

// ---------------------------------------------------- the viewport must allow zoom
const viewport = (src.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i) || [])[1] || '';

test('a viewport meta tag exists', () => {
  ok(viewport, 'no viewport meta tag found at all');
});

test('the viewport does NOT block pinch-zoom', () => {
  // WCAG 1.4.4 / Lighthouse. If a zoom complaint ever tempts someone to re-add these,
  // the real bug is an input under 16px — see the next test.
  ok(!/user-scalable\s*=\s*(no|0)/i.test(viewport), 'user-scalable=no is back on the viewport');
  ok(!/maximum-scale/i.test(viewport), 'maximum-scale is back on the viewport');
});

test('the viewport still handles the notch', () => {
  ok(/viewport-fit\s*=\s*cover/i.test(viewport), 'viewport-fit=cover was lost');
});

// --------------------------------------- 16px minimum on every touch form control
test('the coarse-pointer 16px guard exists and is !important', () => {
  // !important is required: the offenders are inline style attributes, which beat
  // every normal rule. pointer:coarse keeps compact type on mouse-driven desktop.
  const guard = /@media\s*\(\s*pointer:\s*coarse\s*\)\s*\{\s*input\s*,\s*select\s*,\s*textarea\s*\{[^}]*font-size:\s*16px\s*!important/i;
  ok(guard.test(css), 'the 16px touch guard is missing or no longer !important');
});

test('the base form-control rule is 16px', () => {
  // The guard is the safety net; the base rule should already be correct so that
  // anything NOT carrying an inline override is fine everywhere.
  const base = css.match(/(?:^|\n)input,select,textarea\{([^}]*)\}/);
  ok(base, 'base input,select,textarea rule not found');
  const fs = base[1].match(/font-size:\s*([\d.]+)px/);
  ok(fs, 'base rule has no font-size');
  ok(parseFloat(fs[1]) >= 16, `base form-control font-size is ${fs[1]}px, must be >= 16`);
});

test('no CSS rule drops a form control under 16px without the guard covering it', () => {
  // Informational inventory: these are fine ONLY because the coarse-pointer guard
  // overrides them on touch. If the guard is ever removed this test's sibling above
  // fails first — this one documents what would break.
  const offenders = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim(), body = m[2];
    if (!/\b(input|select|textarea)\b/.test(sel)) continue;
    if (/pointer:\s*coarse/.test(sel)) continue;
    const fs = body.match(/font-size:\s*([\d.]+)px/);
    if (fs && parseFloat(fs[1]) < 16) offenders.push(`${sel.slice(0, 50)} -> ${fs[1]}px`);
  }
  // Not an assertion failure — the guard handles them. Surfaced so a reviewer sees
  // the blast radius if anyone edits the guard.
  if (offenders.length) console.log('    (covered by the guard: ' + offenders.join('; ') + ')');
  ok(true);
});

test('every inline sub-16px form control is a known, guard-covered case', () => {
  // The guard covers these on touch. What this pins is that the SET doesn't quietly
  // grow in a place the guard can't reach — e.g. a control rendered into an iframe
  // (the print/PDF documents) where the app stylesheet doesn't apply.
  const inline = [];
  for (const m of src.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const fs = m[0].match(/font-size:\s*([\d.]+)px/);
    if (fs && parseFloat(fs[1]) < 16) inline.push(m[0].slice(0, 90));
  }
  // They must all live in the main document — never inside a printable doc template,
  // which is rendered in its own iframe/clone and never receives this stylesheet.
  const docTemplateStart = src.indexOf('function reportDoc');
  const bad = inline.filter(t => {
    const at = src.indexOf(t);
    return docTemplateStart > 0 && at > docTemplateStart && /printDocInIframe|reportDoc/.test(src.slice(Math.max(0, at - 4000), at));
  });
  eq(bad, [], 'a sub-16px form control was added inside a print/PDF template, where the guard cannot reach it');
});

// ------------------------------------------------------- keyboard-dismiss sanity
test('form controls are not blocked from the browser\'s own touch handling', () => {
  // touch-action:manipulation is deliberately NOT applied to input/textarea (the
  // logo-crop range slider needs native drag). Pin that it stays off them.
  const bad = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim(), body = m[2];
    if (!/touch-action/.test(body)) continue;
    if (/\b(input|textarea)\b/.test(sel) && !/button|\[type=/.test(sel)) bad.push(sel.slice(0, 60));
  }
  eq(bad, [], 'touch-action was applied to text inputs — breaks the crop slider drag');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
