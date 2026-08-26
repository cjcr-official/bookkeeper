// Nobody gets an account without the owner's say-so.
//
// WHY THIS EXISTS: this is a personal app, but its Supabase anon key is hard-coded
// in index.html — so the ONE line `sb.auth.signUp({email, password})` handed a
// working account to anyone who opened the page. Signup moved server-side: the
// Worker checks an invite code against a secret the browser never sees and creates
// the login on the service key.
//
// Every failure this pins is SILENT. A gate that defaults open when the status
// check fails looks identical to a working gate right up until the Worker has a
// bad day. A client-side signUp() left in as a "fallback" is a way around the
// server saying no. And a status endpoint that reports "closed" while Supabase's
// own public signup is still on is worse than no endpoint at all — it's a false
// all-clear on the door that actually matters.
//
//   run:  node test/signup.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const client = readFileSync(join(root, 'index.html'), 'utf8');
const worker = readFileSync(join(root, 'worker', 'push-cron.js'), 'utf8');

let pass = 0, fail = 0;
const running = [];
function test(name, fn) {
  const good = () => { console.log('• ' + name); pass++; };
  const bad = e => { console.log('✗ ' + name + '\n    ' + e.message); fail++; };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { running.push(r.then(good, bad)); return; }
    good();
  } catch (e) { bad(e); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// The "must never appear" checks below read the shipped source, and this file's
// own prose names the very calls it is banning. Strip whole-line comments first,
// or the ban trips on the comment explaining it.
const codeOnly = src => src.replace(/^[ \t]*\/\/.*$/gm, '');
const clientCode = codeOnly(client);

// Brace-match a top-level function out of the shipped source (the trick every
// other suite uses), so these run the real code and not a copy of it.
function extract(src, name) {
  const start = src.search(new RegExp('(async )?function ' + name + '\\('));
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

console.log('\nSIGN-UP GATE\n');

// ── The client must not be able to create an account on its own ──────────

test('the client never calls Supabase signUp directly', () => {
  // The anon key is public (it is in this very file), so this call is an open
  // registration form for the whole internet. There is no safe place for it.
  ok(!/\bsb\.auth\.signUp\s*\(/.test(clientCode),
    'index.html still calls sb.auth.signUp() — that bypasses the Worker entirely\n'
    + '    and creates an account for anyone who can load the page.');
});

test('the client never calls signInWithOtp either', () => {
  // Magic-link sign-in CREATES the user unless shouldCreateUser:false — the same
  // hole wearing a different name.
  ok(!/signInWithOtp\s*\(/.test(clientCode), 'signInWithOtp can mint an account too');
});

test('doSignup posts to the Worker and sends the invite code', () => {
  const fn = extract(client, 'doSignup');
  ok(/fetch\(\s*'\/signup'/.test(fn), "doSignup must POST to '/signup'");
  ok(/\bcode\b/.test(fn), 'doSignup must send the invite code');
  ok(/signup-code/.test(fn), 'doSignup must read the invite-code field');
});

test('the invite-code field exists and is disabled with the rest of the signup form', () => {
  ok(/id="signup-code"/.test(client), 'no #signup-code input in the auth card');
  const form = client.slice(client.indexOf('<form id="signup-form"'), client.indexOf('</form>', client.indexOf('<form id="signup-form"')));
  ok(/id="signup-code"/.test(form),
    'the code field must live INSIDE #signup-form — setActiveAuthForm disables that\n'
    + '    form by selector, and a field outside it stays live for AutoFill.');
});

// ── The gate fails CLOSED ────────────────────────────────────────────────

// Run the shipped refreshSignupGate/applySignupGate against a stub DOM and a
// stub fetch, so "what happens when the Worker is unreachable" is answered by
// the real code.
function runGate(fetchImpl, opts = {}) {
  const els = {};
  const el = id => (els[id] = els[id] || { id, style: {}, textContent: '', innerHTML: '' });
  if (opts.tabsHiddenFirst) el('auth-tabs').style.display = 'none';
  if (opts.inMfa) { el('auth-tabs').style.display = 'none'; el('mfa-login-form').style.display = 'block'; }
  const doc = {
    getElementById: id => el(id),
    querySelector: sel => (sel === '.auth-tabs' ? el('auth-tabs') : null),
    querySelectorAll: () => [el('tab0')]
  };
  el('signup-form').style.display = 'none';
  const src = extract(client, 'applySignupGate') + '\n' + extract(client, 'refreshSignupGate') + '\n'
    + 'function renderSignupStatus(){}\nfunction switchAuthTab(){}\n';
  const f = new Function('document', 'fetch', `
    let _signupOpen = false, _signupDirect = 'unknown';
    ${src}
    return refreshSignupGate().then(()=>({open:_signupOpen, direct:_signupDirect, els:arguments[0]}));
  `);
  return f(doc, fetchImpl).then(r => ({ ...r, el }));
}
const jsonRes = (body, ok2 = true) => Promise.resolve({ ok: ok2, json: () => Promise.resolve(body) });

test('an unreachable Worker leaves sign-ups CLOSED', () =>
  runGate(() => Promise.reject(new Error('offline'))).then(r => {
    ok(r.open === false, 'a failed status check must not open the door');
    ok(r.el('auth-signup-tab').style.display === 'none', 'the Create Account tab must stay hidden');
  }));

test('an old Worker answering with the SPA HTML fallback leaves it CLOSED', () =>
  // not_found_handling = "single-page-application": an unknown path returns
  // index.html with status 200. A truthy body is not a yes.
  runGate(() => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('not json')) })).then(r => {
    ok(r.open === false, 'a non-JSON 200 must not open the door');
  }));

test('a malformed or truthy-but-wrong payload leaves it CLOSED', () =>
  Promise.all([
    runGate(() => jsonRes({ open: 'yes' })).then(r => ok(r.open === false, "open:'yes' is not open:true")),
    runGate(() => jsonRes({ open: 1 })).then(r => ok(r.open === false, 'open:1 is not open:true')),
    runGate(() => jsonRes(null)).then(r => ok(r.open === false, 'a null body is not open')),
    runGate(() => jsonRes({ open: true }, false)).then(r => ok(r.open === false, 'a non-2xx is not open'))
  ]));

test('an explicit open:true from the Worker shows the tab', () =>
  runGate(() => jsonRes({ open: true, direct: 'closed' })).then(r => {
    ok(r.open === true, 'open:true must open');
    ok(r.el('auth-signup-tab').style.display === '', 'the Create Account tab should be shown');
    ok(r.el('auth-tabs').style.display === '', 'the tab strip must be shown too');
    ok(r.direct === 'closed', "the direct-signup verdict must be carried through");
  }));

test('opening after the closed first paint un-hides the strip', () =>
  // The gate paints CLOSED before the Worker answers, which hides the tab strip.
  // If re-opening is written as "leave it alone if it's already hidden", that
  // first paint is permanent and the tab never comes back on an open app.
  runGate(() => jsonRes({ open: true, direct: 'closed' }), { tabsHiddenFirst: true }).then(r => {
    ok(r.el('auth-tabs').style.display === '', 'the strip must come back when signups open');
    ok(r.el('auth-signup-tab').style.display === '', 'and so must the tab');
  }));

test('the 2FA challenge keeps its hidden tab strip', () =>
  // showMfaChallenge hides the strip and owns it until resetAuthView; the gate
  // must not paint it back mid-challenge.
  runGate(() => jsonRes({ open: true, direct: 'closed' }), { inMfa: true }).then(r => {
    ok(r.el('auth-tabs').style.display === 'none', 'the gate must not re-show the strip during 2FA');
  }));

test('an unreadable direct-signup verdict is reported as unknown, never as closed', () =>
  // Claiming "locked" without having checked is the false all-clear this row exists
  // to prevent.
  runGate(() => jsonRes({ open: false })).then(r => {
    ok(r.direct === 'unknown', 'a missing `direct` must read as unknown, got ' + r.direct);
  }));

test('signing out re-applies the gate', () => {
  // resetAuthView un-hides the whole tab strip, so without this a sign-out hands
  // back a Create Account tab on an app that has none.
  ok(/applySignupGate\(\)/.test(extract(client, 'resetAuthView')),
    'resetAuthView must call applySignupGate() after re-showing .auth-tabs');
});

test('boot asks for the status', () => {
  ok(/refreshSignupGate\(\)/.test(extract(client, 'boot')), 'boot() must call refreshSignupGate()');
});

// ── The Worker is the actual lock ────────────────────────────────────────

const { signupOpen, signupEmailAllowed } = new Function(
  extract(worker, 'signupOpen') + extract(worker, 'signupEmailAllowed')
  + 'return { signupOpen, signupEmailAllowed };'
)();

test('no SIGNUP_CODE secret means sign-ups are closed', () => {
  // Fail closed. An unset secret meaning "open" is how a door stays propped for
  // months with nobody noticing.
  ok(signupOpen({}) === false, 'unset must be closed');
  ok(signupOpen({ SIGNUP_CODE: '' }) === false, 'empty must be closed');
  ok(signupOpen({ SIGNUP_CODE: '   ' }) === false, 'whitespace must be closed');
  ok(signupOpen({ SIGNUP_CODE: 'hunter2-hunter2' }) === true, 'a real code opens it');
});

test('the email allowlist is inert when unset and exact when set', () => {
  ok(signupEmailAllowed({}, 'anyone@example.com') === true, 'unset = any address');
  ok(signupEmailAllowed({ SIGNUP_ALLOWED_EMAILS: '' }, 'a@b.com') === true, 'blank = any address');
  const env = { SIGNUP_ALLOWED_EMAILS: ' Case@Example.com , two@example.com ' };
  ok(signupEmailAllowed(env, 'case@example.com') === true, 'case-insensitive match');
  ok(signupEmailAllowed(env, '  TWO@EXAMPLE.COM ') === true, 'trims and folds case');
  ok(signupEmailAllowed(env, 'stranger@example.com') === false, 'an uninvited address is refused');
});

test('/signup refuses everything when no code is configured', () => {
  const fn = extract(worker, 'signupCreate');
  const gate = fn.slice(0, fn.indexOf('req.json()'));
  ok(/if \(!signupOpen\(env\)\)/.test(gate),
    'the closed check must come FIRST in signupCreate, before any work');
  ok(/403/.test(gate), 'a closed app must answer 403');
});

test('the code is compared in constant time', () => {
  const fn = extract(worker, 'signupCreate');
  ok(/timingSafeEqual\(\s*code\s*,/.test(fn),
    'compare the invite code with timingSafeEqual — a plain === leaks it one\n'
    + '    character at a time to anyone who can measure the response.');
  ok(!/code\s*===\s*env\.SIGNUP_CODE/.test(fn), 'no direct === on the secret');
});

test('a wrong code is slow, and says the same thing as an uninvited address', () => {
  const fn = extract(worker, 'signupCreate');
  const m = /if \(!timingSafeEqual[\s\S]*?\n  \}/.exec(fn);
  ok(m, 'could not find the code check');
  ok(/setTimeout\(r, SIGNUP_SLOW_MS\)/.test(m[0]),
    'a wrong code must cost real time, or the code can be guessed online');
  // ONE branch, ONE message: splitting these would turn the response into an
  // oracle for "is this address invited".
  ok((m[0].match(/return jsonResp/g) || []).length === 1,
    'a bad code and an uninvited address must return through the same branch');
});

test('the login is created on the service key, not the anon key', () => {
  const fn = extract(worker, 'signupCreate');
  ok(/auth\/v1\/admin\/users/.test(fn),
    'use the GoTrue ADMIN endpoint — it is the only one that still works once\n'
    + '    public sign-ups are disabled in Supabase, which is the point.');
  ok(/SUPABASE_SERVICE_KEY/.test(fn), 'the admin call needs the service key');
  ok(/email_confirm:\s*true/.test(fn), 'an invited user should not have to wait on an email');
});

test('the profile row is written by the Worker, not left to the signed-out client', () => {
  const fn = extract(worker, 'signupCreate');
  ok(/rest\/v1\/profiles/.test(fn) && /svcHeaders/.test(fn),
    'the client is not signed in yet, so its own upsert is refused by RLS and the\n'
    + '    company name silently vanishes — write it here on the service key.');
});

// Run the shipped signupCreate against stubbed Supabase calls. The static checks
// above say the right code is present; this says it actually refuses.
function runSignup(env, body, adminRes) {
  const calls = [];
  const src = extract(worker, 'signupOpen') + '\n' + extract(worker, 'signupEmailAllowed') + '\n'
    + extract(worker, 'timingSafeEqual') + '\n' + extract(worker, 'signupCreate') + '\n';
  const f = new Function('env', 'body', 'calls', 'adminRes', `
    const SIGNUP_SLOW_MS = 0;
    const jsonResp = (o, s = 200) => ({ status: s, body: o });
    const svcHeaders = () => ({});
    const console = { error(){} };
    const fetch = (url, opt) => {
      calls.push(String(url));
      if (String(url).includes('/admin/users')) return Promise.resolve(adminRes);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    const req = { json: () => Promise.resolve(body) };
    ${src}
    return signupCreate(req, env);
  `);
  return f(env, body, calls, adminRes || { ok: true, json: () => Promise.resolve({ id: 'new-uid' }) })
    .then(r => ({ ...r, calls }));
}
const GOOD = { email: 'invited@example.com', password: 'a-long-enough-pw', company: 'Acme', code: 'let-me-in-please' };
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SIGNUP_CODE: 'let-me-in-please' };

test('a closed app creates nothing, whatever it is sent', () =>
  runSignup({ ...ENV, SIGNUP_CODE: '' }, GOOD).then(r => {
    ok(r.status === 403, 'expected 403, got ' + r.status);
    ok(r.calls.length === 0, 'a closed app must not talk to Supabase at all');
  }));

test('a wrong code creates nothing', () =>
  runSignup(ENV, { ...GOOD, code: 'let-me-in-pleasf' }).then(r => {
    ok(r.status === 403, 'expected 403, got ' + r.status);
    ok(r.calls.length === 0, 'no account may be created on a bad code');
  }));

test('a missing code creates nothing', () =>
  runSignup(ENV, { ...GOOD, code: '' }).then(r => {
    ok(r.status === 403 && r.calls.length === 0, 'an empty code must be refused');
  }));

test('an uninvited address creates nothing even with the right code', () =>
  runSignup({ ...ENV, SIGNUP_ALLOWED_EMAILS: 'owner@example.com' }, GOOD).then(r => {
    ok(r.status === 403, 'expected 403, got ' + r.status);
    ok(r.calls.length === 0, 'the allowlist must be checked before the account is made');
  }));

test('the right code creates the account and its profile row', () =>
  runSignup(ENV, GOOD).then(r => {
    ok(r.status === 200 && r.body.ok === true, 'expected ok, got ' + JSON.stringify(r.body));
    ok(r.calls.some(u => u.includes('/auth/v1/admin/users')), 'must call the admin API');
    ok(r.calls.some(u => u.includes('/rest/v1/profiles')), 'must write the profile row');
  }));

test('a code with stray whitespace still works', () =>
  // Codes arrive by text message and notes apps; a leading space reading as a
  // refusal is indistinguishable from a real refusal.
  runSignup(ENV, { ...GOOD, code: '  let-me-in-please ' }).then(r => {
    ok(r.body.ok === true, 'a trimmable code must be accepted');
  }));

test('a short password is refused before anything is created', () =>
  runSignup(ENV, { ...GOOD, password: 'short' }).then(r => {
    ok(r.status === 400 && r.calls.length === 0, 'expected 400 with no calls, got ' + r.status);
  }));

test("Supabase's own refusal is passed back, not swallowed as success", () =>
  runSignup(ENV, GOOD, { ok: false, status: 422, json: () => Promise.resolve({ msg: 'User already registered' }) }).then(r => {
    ok(r.status === 400, 'expected 400, got ' + r.status);
    ok(/already registered/.test(r.body.error), 'the real reason must reach the user');
    ok(!r.body.ok, 'a failed create must never report ok');
  }));

test('/signup-status reports Supabase’s own signup toggle and never guesses', () => {
  const fn = extract(worker, 'signupStatus');
  ok(/auth\/v1\/settings/.test(fn), 'read the verdict from GoTrue settings');
  ok(/disable_signup/.test(fn), 'disable_signup is the field that answers it');
  ok(/let direct = 'unknown'/.test(fn),
    "an unreadable check must stay 'unknown' — reporting 'closed' without having\n"
    + '    looked is a false all-clear on the one door that matters.');
  ok(!/SIGNUP_CODE\s*[,}]/.test(fn.replace(/signupOpen\(env\)/g, '')),
    'the status endpoint is public — it must never echo the code itself');
});

test('both routes are actually wired into the Worker', () => {
  ok(/url\.pathname === '\/signup-status' && req\.method === 'GET'/.test(worker), 'GET /signup-status');
  ok(/url\.pathname === '\/signup' && req\.method === 'POST'/.test(worker), 'POST /signup');
});

await Promise.all(running);
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
