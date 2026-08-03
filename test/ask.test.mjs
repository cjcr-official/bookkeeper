// Harness for askText() — the in-app replacement for window.prompt().
//
// WHY THIS EXISTS: askText returns a Promise and a dozen call sites `await` it
// (recording income, prior-year entries, splits, the app-lock passcode). If a close
// path ever fails to settle that promise, the awaiting function hangs FOREVER — no
// error, no toast, just an action that silently never finishes and a modal already
// gone from the screen. That is the worst possible failure for a bookkeeping step,
// and it is invisible in code review because the happy path looks perfect.
//
// The sheet can be dismissed by five different routes — OK, Cancel, the X button,
// Escape, the backdrop tap, and Android's back gesture — and only two of them go
// through askCancel(). This pins that EVERY one of them settles exactly once.
//
//   run:  node test/ask.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

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

// Minimal DOM stub: just enough for askText/askOk/askCancel/closeModal to run.
function build() {
  const els = {};
  const el = (id) => (els[id] = els[id] || {
    id, value: '', textContent: '', innerHTML: '', placeholder: '', type: 'text',
    style: {}, classList: { add(){}, remove(){}, contains(){ return false; } },
    setAttribute(){}, removeAttribute(){}, focus(){}, select(){},
  });
  const doc = {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { classList: { add(){}, remove(){} } },
  };
  const factory = new Function('document', 'openModal', 'navSync', 'escHtml', 'askSettleHook', `
    let _modalReturnFocus = null;
    let _askResolve = null;
    ${extract('closeModal')}
    ${extract('askText')}
    ${extract('askOk')}
    ${extract('askCancel')}
    ${extract('askSettle')}
    return { askText, askOk, askCancel, askSettle, closeModal,
             pending: () => _askResolve !== null };
  `);
  return factory(doc, () => {}, () => {}, s => String(s), null);
}

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
};
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((msg || 'not equal') + `\n    got: ${JSON.stringify(a)}  expected: ${JSON.stringify(b)}`);
}
// Any promise that hasn't settled by the next few microtask turns is a hang.
const settled = (p) => Promise.race([p.then(v => ({ v })), Promise.resolve().then(() => null)
  .then(() => null).then(() => null).then(() => 'PENDING')]);

console.log('\nASK MODAL (prompt replacement)\n');

await test('OK resolves with the typed value', async () => {
  const A = build();
  const p = A.askText({ title: 'x' });
  A.askOk.call(null);          // user taps OK — value comes from the stubbed input
  eq((await settled(p)).v, '');
});

await test('a typed value comes back exactly', async () => {
  const A = build();
  const p = A.askText({ value: 'Acme Corp' });
  A.askOk();
  eq((await settled(p)).v, 'Acme Corp', 'the default value should round-trip');
});

await test('Cancel resolves null (never rejects)', async () => {
  // Call sites do `if (v == null) return;` — a rejection would blow past that.
  const A = build();
  const p = A.askText({});
  A.askCancel();
  eq((await settled(p)).v, null);
});

await test('closeModal("modal-ask") settles — covers Escape, backdrop and back', async () => {
  // The three dismiss routes that never call askCancel(). This is the hang.
  const A = build();
  const p = A.askText({});
  A.closeModal('modal-ask');
  eq((await settled(p)).v, null, 'promise left hanging on a non-Cancel dismiss');
});

await test('closing a DIFFERENT modal does not settle the ask', async () => {
  const A = build();
  const p = A.askText({});
  A.closeModal('modal-expense');
  eq(await settled(p), 'PENDING', 'an unrelated modal must not cancel the ask');
  A.askCancel();
  eq((await settled(p)).v, null);
});

await test('settling twice is a no-op — OK then a close cannot double-resolve', async () => {
  // askOk resolves and THEN calls closeModal, which tries to settle again.
  let calls = 0;
  const A = build();
  const p = A.askText({ value: 'first' }).then(v => { calls++; return v; });
  A.askOk();
  A.closeModal('modal-ask');
  eq((await settled(p)).v, 'first');
  await Promise.resolve(); await Promise.resolve();
  eq(calls, 1, 'the promise resolved more than once');
  eq(A.pending(), false, 'the resolver should be cleared after settling');
});

await test('a second askText cancels the first instead of stranding it', async () => {
  const A = build();
  const p1 = A.askText({ value: 'one' });
  const p2 = A.askText({ value: 'two' });
  eq((await settled(p1)).v, null, 'the superseded prompt must resolve, not hang');
  A.askOk();
  eq((await settled(p2)).v, 'two');
});

// --------------------------------------------------------- static guarantees
await test('no window.prompt() calls remain in the app', async () => {
  const hits = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /(?<![\w])(window\.)?prompt\(/.test(l)
      && !/evt\.prompt|askText|^\s*\/\/|<!--|prompt\(\)'s shape/.test(l));
  eq(hits.map(([n]) => n), [], 'window.prompt() is still being used');
});

await test('the ask modal is registered in MODAL_CLOSERS', async () => {
  // Android back routes through MODAL_CLOSERS; without an entry it would fall back
  // to closeModal (which does settle now), but the explicit entry is the contract.
  eq(/'modal-ask':\s*'askCancel'/.test(src), true, 'modal-ask missing from MODAL_CLOSERS');
});

await test('the passcode prompts are masked', async () => {
  // window.prompt() showed the app-lock PIN in clear text.
  const lock = extract('toggleAppLock');
  const asks = lock.match(/askText\(\{[\s\S]*?\}\)/g) || [];
  eq(asks.length, 3, 'expected 3 passcode prompts');
  eq(asks.every(a => /type:\s*'password'/.test(a)), true, 'a passcode prompt is not masked');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
