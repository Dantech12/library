/*
  eLibrary website: Paystack payments, school accounts and student sign-in.  No extra packages (Node 18+).

  Start:   node server/server.js
  All settings come from environment variables (see server/.env.example).
  The Paystack SECRET key is only ever used here, on the server — never in the browser.

  Flow:  pay -> claim (create the school's admin account) -> admin creates student logins
         -> students sign in with school code + username + password to read.
*/
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./store');

loadDotEnv(path.join(__dirname, '.env'));

// ---------------------------------------------------------------- settings
const env = process.env;
const ROOT = path.resolve(__dirname, '..');
const CFG = {
  port: +env.PORT || 8080,
  baseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  secretKey: env.PAYSTACK_SECRET_KEY || '',
  paystackApi: (env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, ''),
  currency: env.BILLING_CURRENCY || 'GHS',
  // Amounts in pesewas (GH₵1 = 100 pesewas), like Paystack expects.
  amounts: { school: int(env.PLAN_SCHOOL_AMOUNT, 15000), network: int(env.PLAN_NETWORK_AMOUNT, 45000) },
  maxStudents: { school: int(env.PLAN_SCHOOL_MAX_STUDENTS, 1000), network: int(env.PLAN_NETWORK_MAX_STUDENTS, 5000) },
  termMonths: int(env.TERM_MONTHS, 4),
  termDiscount: int(env.TERM_DISCOUNT_PERCENT, 10),
  business: {
    name: env.BUSINESS_NAME || 'School eLibrary',
    email: env.SUPPORT_EMAIL || '',
    phone: env.SUPPORT_PHONE || '',
    whatsapp: (env.SUPPORT_WHATSAPP || '').replace(/[^\d]/g, ''),
    address: env.BUSINESS_ADDRESS || '',
    country: env.BUSINESS_COUNTRY || 'Ghana'
  },
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data'))
};
const PLANS = {
  school: { name: 'School', limits: 'one school' },
  network: { name: 'Network', limits: 'up to 5 schools' }
};
const PERIODS = ['month', 'term'];
const METHODS = ['momo', 'card'];
const SESSION_DAYS = { admin: 7, student: 30 };
const secureCookies = CFG.baseUrl.startsWith('https://');

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; }
function price(plan, period) {
  const m = CFG.amounts[plan];
  return period === 'term' ? Math.round(m * CFG.termMonths * (100 - CFG.termDiscount) / 100) : m;
}
const months = (period) => (period === 'term' ? CFG.termMonths : 1);
const paymentsOn = () => !!CFG.secretKey;
const testMode = () => CFG.secretKey.startsWith('sk_test_');

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env file: fine */ }
}

// ---------------------------------------------------------------- storage
fs.mkdirSync(CFG.dataDir, { recursive: true });
const store = S.createStore(CFG.dataDir);
const db = store.db;
store.watch();
const ORDERS = path.join(CFG.dataDir, 'orders.jsonl');
function logOrder(o) {
  fs.appendFile(ORDERS, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n', (e) => e && console.error('order log:', e.message));
}

// ---------------------------------------------------------------- Paystack
async function paystack(method, p, body) {
  const res = await fetch(CFG.paystackApi + p, {
    method,
    headers: { Authorization: 'Bearer ' + CFG.secretKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status !== true) {
    const err = new Error('paystack: ' + res.status + ' ' + (json.message || ''));
    err.paystack = String(json.message || 'Request was refused').slice(0, 200);
    throw err;
  }
  return json.data;
}

// Monthly card payments renew automatically through a Paystack plan. Find it or create it once.
const planCodes = {};
async function ensurePlans() {
  if (!paymentsOn()) return;
  try {
    const existing = [];
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`${CFG.paystackApi}/plan?perPage=100&page=${page}`, { headers: { Authorization: 'Bearer ' + CFG.secretKey }, signal: AbortSignal.timeout(15000) });
      const j = await res.json();
      if (!res.ok || !j.status) throw new Error(j.message || res.status);
      existing.push(...(j.data || []));
      if (!j.meta || !j.meta.pageCount || page >= j.meta.pageCount) break;
    }
    for (const key of Object.keys(PLANS)) {
      const name = `${CFG.business.name} — ${PLANS[key].name} (monthly)`;
      const amount = CFG.amounts[key];
      let p = existing.find((x) => x.name === name && x.amount === amount && x.currency === CFG.currency && x.interval === 'monthly' && !x.is_deleted);
      if (!p) p = await paystack('POST', '/plan', { name, amount, currency: CFG.currency, interval: 'monthly', description: `${PLANS[key].name} plan, ${PLANS[key].limits}` });
      planCodes[key] = p.plan_code;
    }
    console.log('Paystack plans ready:', planCodes);
  } catch (e) {
    console.error('Could not set up Paystack plans (monthly card payments will be charged once instead of renewing):', e.paystack || e.message);
  }
}

function verifySignature(raw, sig) {
  if (!sig || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  const expected = crypto.createHmac('sha512', CFG.secretKey).update(raw).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------- schools
function newSchoolCode(name) {
  const initials = String(name).normalize('NFD').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase().slice(0, 4) || 'sch';
  const taken = new Set(Object.values(db.orgs).map((o) => o.code));
  for (;;) { const c = initials + crypto.randomInt(100, 1000); if (!taken.has(c)) return c; }
}
function extendOrg(org, period, plan) {
  org.paidUntil = S.addPeriod(Math.max(Date.now(), org.paidUntil || 0), months(period));
  if (plan) org.plan = plan;
  if (org.status === 'suspended') org.status = 'active';
}
function orgView(org) {
  const count = Object.values(db.students).filter((s) => s.orgId === org.id).length;
  return { name: org.name, code: org.code, plan: org.plan, planName: PLANS[org.plan] ? PLANS[org.plan].name : org.plan,
    paidUntil: org.paidUntil, graceUntil: org.paidUntil + S.GRACE_DAYS * S.DAY, active: S.isActive(org), students: count, maxStudents: CFG.maxStudents[org.plan] || 0 };
}

// Confirm a payment with Paystack directly, check it matches what was ordered, then activate.
async function confirm(reference) {
  const t = await paystack('GET', '/transaction/verify/' + encodeURIComponent(reference));
  const co = db.checkouts[reference];
  const md = t.metadata || {};
  if (!co) return { paid: false, status: t.status, unknown: true };
  const matches = t.reference === reference && t.currency === CFG.currency && t.amount === co.amount && md.plan === co.plan && md.period === co.period;
  const paid = t.status === 'success' && matches;
  let org = co.orgId ? db.orgs[co.orgId] : null;
  if (paid && !co.paid) {
    co.paid = true;
    co.paidAt = Date.now();
    if (org) {
      extendOrg(org, co.period, co.plan); // renewal or plan change by a signed-in admin
    } else {
      org = { id: S.newId(), code: newSchoolCode(co.school), name: co.school, plan: co.plan, status: 'active', paidUntil: 0,
        createdAt: Date.now(), payerEmail: co.email, contactName: co.name, phone: co.phone, adminEmail: null, claimRef: reference };
      extendOrg(org, co.period, co.plan);
      db.orgs[org.id] = org;
      co.orgId = org.id;
    }
    if (co.method === 'card' && co.period === 'month') org.subscriptionEmail = (t.customer && t.customer.email) || co.email;
    store.save();
    logOrder({ event: 'paid', reference, plan: co.plan, period: co.period, method: co.method, amount: t.amount, currency: t.currency,
      school: org.name, schoolCode: org.code, email: t.customer && t.customer.email, phone: co.phone, channel: t.channel });
    console.log(`PAID ${reference}: ${org.name} (${org.code}) — ${co.plan}/${co.period} ${t.currency} ${(t.amount / 100).toFixed(2)}`);
  }
  return { paid: co.paid, status: t.status, mismatch: t.status === 'success' && !matches, plan: co.plan, period: co.period,
    amount: t.amount, currency: t.currency, school: co.school, org: org || null };
}

// A renewal charge for a monthly card subscription (Paystack makes a new reference each month).
async function confirmRenewal(reference, data) {
  if (db.checkouts[reference]) return;
  const t = await paystack('GET', '/transaction/verify/' + encodeURIComponent(reference));
  if (t.status !== 'success' || t.currency !== CFG.currency) return;
  const planCode = (t.plan && (t.plan.plan_code || t.plan)) || (data.plan && data.plan.plan_code);
  const planKey = Object.keys(planCodes).find((k) => planCodes[k] === planCode);
  const email = String((t.customer && t.customer.email) || '').toLowerCase();
  const org = Object.values(db.orgs).find((o) => (o.subscriptionEmail || '').toLowerCase() === email);
  if (!planKey || !org || t.amount !== CFG.amounts[planKey]) {
    logOrder({ event: 'charge-unmatched', reference, amount: t.amount, email, planCode });
    return;
  }
  db.checkouts[reference] = { renewal: true, plan: planKey, period: 'month', amount: t.amount, orgId: org.id, paid: true, paidAt: Date.now(), createdAt: Date.now() };
  extendOrg(org, 'month', planKey);
  store.save();
  logOrder({ event: 'renewed', reference, school: org.name, schoolCode: org.code, plan: planKey, amount: t.amount, email });
}

// ---------------------------------------------------------------- sessions
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function startSession(res, kind, sub, orgId) {
  const token = S.newToken();
  const days = SESSION_DAYS[kind];
  db.sessions[S.hashToken(token)] = { kind, sub, orgId, expires: Date.now() + days * S.DAY, createdAt: Date.now() };
  store.save();
  res.setHeader('Set-Cookie', `elib_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secureCookies ? '; Secure' : ''}`);
}
function endSession(req, res) {
  const t = parseCookies(req).elib_s;
  if (t && db.sessions[S.hashToken(t)]) { delete db.sessions[S.hashToken(t)]; store.save(); }
  res.setHeader('Set-Cookie', `elib_s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? '; Secure' : ''}`);
}
function getSession(req) {
  const t = parseCookies(req).elib_s;
  if (!t) return null;
  const s = db.sessions[S.hashToken(t)];
  if (!s || s.expires < Date.now()) return null;
  const org = db.orgs[s.orgId];
  if (!org) return null;
  if (s.kind === 'admin') {
    const admin = db.admins[s.sub];
    if (!admin || admin.orgId !== org.id) return null;
    return { kind: 'admin', admin, org };
  }
  const student = db.students[s.sub];
  if (!student || student.orgId !== org.id || student.disabled) return null;
  return { kind: 'student', student, org };
}
const canRead = (sess) => !!sess && S.isActive(sess.org);

// ---------------------------------------------------------------- HTTP helpers
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const HIDDEN = /^\/(server|tools|data|node_modules)(\/|$)|\/\.|^\/(package(-lock)?\.json|render\.yaml|README\.md)$/i;

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// JSON bodies only: browsers can't send these cross-site without permission, which blocks CSRF.
async function readJson(req, limit) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('json'), { code: 415 });
  try { return JSON.parse((await readBody(req, limit || 20e3)).toString('utf8')); }
  catch { throw Object.assign(new Error('bad'), { code: 400 }); }
}
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(key, list);
  return list.length > max;
}
setInterval(() => hits.clear(), 3600e3).unref();

function htmlEsc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fillTemplate(html, extra) {
  const b = CFG.business;
  const map = Object.assign({
    BUSINESS_NAME: b.name, SUPPORT_EMAIL: b.email || 'our support email', SUPPORT_PHONE: b.phone || b.whatsapp || '—',
    BUSINESS_ADDRESS: b.address || b.country, BUSINESS_COUNTRY: b.country, YEAR: String(new Date().getFullYear()),
    TERM_MONTHS: String(CFG.termMonths), USER_KEY: '', USER_NAME: '', SCHOOL_NAME: '', USER_KIND: ''
  }, extra || {});
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in map ? htmlEsc(map[k]) : m));
}
const ip = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const sess = getSession(req);

  if (p === '/api/config' && m === 'GET') {
    const plans = {};
    for (const k of Object.keys(PLANS)) plans[k] = { name: PLANS[k].name, month: price(k, 'month'), term: price(k, 'term'), maxStudents: CFG.maxStudents[k] };
    const b = CFG.business;
    return send(res, 200, { currency: CFG.currency, termMonths: CFG.termMonths, termDiscount: CFG.termDiscount, plans,
      payments: paymentsOn(), testMode: testMode(), contact: { name: b.name, email: b.email, phone: b.phone, whatsapp: b.whatsapp } });
  }

  // ----- who is signed in
  if (p === '/api/session' && m === 'GET') {
    if (!sess) return send(res, 200, { kind: null });
    const o = orgView(sess.org);
    if (sess.kind === 'admin') return send(res, 200, { kind: 'admin', name: sess.admin.name, email: sess.admin.email, org: o });
    return send(res, 200, { kind: 'student', name: sess.student.name, username: sess.student.username, org: { name: o.name, code: o.code, active: o.active } });
  }

  // ----- checkout (new school, or a signed-in admin renewing / changing plan)
  if (p === '/api/checkout' && m === 'POST') {
    if (!paymentsOn()) return send(res, 503, { error: 'payments_off' });
    if (limited(ip(req) + ':co', 12, 10 * 60e3)) return send(res, 429, { error: 'too_many' });
    const b = await readJson(req);
    const renew = !!b.renew && sess && sess.kind === 'admin';
    const email = String(b.email || (renew ? sess.admin.email : '')).trim().toLowerCase();
    const school = renew ? sess.org.name : String(b.school || '').trim().slice(0, 120);
    const contactName = String(b.name || (renew ? sess.admin.name : '')).trim().slice(0, 80);
    const phone = String(b.phone || '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);
    if (!PLANS[b.plan] || !PERIODS.includes(b.period) || !METHODS.includes(b.method)) return send(res, 400, { error: 'bad_plan' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return send(res, 400, { error: 'bad_email' });
    if (school.length < 2) return send(res, 400, { error: 'bad_school' });
    if (renew) {
      const count = Object.values(db.students).filter((s) => s.orgId === sess.org.id).length;
      if (count > CFG.maxStudents[b.plan]) return send(res, 400, { error: 'too_many_students', detail: CFG.maxStudents[b.plan] });
    }

    const reference = 'elib_' + crypto.randomBytes(9).toString('hex');
    const amount = price(b.plan, b.period);
    const recurring = b.method === 'card' && b.period === 'month' && planCodes[b.plan];
    const claimToken = renew ? null : S.newToken();
    const base = CFG.baseUrl || `http://${req.headers.host}`;
    const metadata = {
      plan: b.plan, period: b.period, method: b.method, school, contact_name: contactName, phone, renewal: renew,
      custom_fields: [
        { display_name: 'School', variable_name: 'school', value: school },
        { display_name: 'Plan', variable_name: 'plan', value: `${PLANS[b.plan].name} (${b.period === 'term' ? 'per term' : 'monthly'})${renew ? ' — renewal' : ''}` },
        { display_name: 'Contact', variable_name: 'contact', value: [contactName, phone].filter(Boolean).join(' · ') || '—' }
      ]
    };
    try {
      const d = await paystack('POST', '/transaction/initialize', {
        email, amount, currency: CFG.currency, reference,
        channels: b.method === 'momo' ? ['mobile_money'] : ['card'],
        ...(recurring ? { plan: planCodes[b.plan] } : {}),
        callback_url: `${base}/thanks.html`, metadata
      });
      db.checkouts[reference] = { plan: b.plan, period: b.period, method: b.method, amount, email, school, name: contactName, phone,
        claimHash: claimToken ? S.hashToken(claimToken) : null, orgId: renew ? sess.org.id : null, paid: false, createdAt: Date.now() };
      store.save();
      logOrder({ event: 'started', reference, plan: b.plan, period: b.period, method: b.method, amount, school, email, phone, contact: contactName, renewal: renew });
      return send(res, 200, { reference, claimToken, accessCode: d.access_code, authorizationUrl: d.authorization_url });
    } catch (e) {
      console.error('checkout failed:', e.message);
      return send(res, 502, e.paystack ? { error: 'paystack_rejected', detail: e.paystack } : { error: 'paystack_unavailable' });
    }
  }

  // ----- payment status (+ account setup info when the claim token is shown)
  if (p === '/api/verify' && m === 'GET') {
    const ref = url.searchParams.get('reference') || '';
    if (!/^elib_[0-9a-f]{18}$/.test(ref)) return send(res, 400, { error: 'bad_reference' });
    if (!paymentsOn()) return send(res, 503, { error: 'payments_off' });
    if (limited(ip(req) + ':v', 60, 10 * 60e3)) return send(res, 429, { error: 'too_many' });
    let r;
    try { r = await confirm(ref); } catch (e) { return send(res, 502, { error: 'paystack_unavailable' }); }
    const co = db.checkouts[ref];
    const claim = url.searchParams.get('claim') || '';
    const owns = co && co.claimHash && claim && S.hashToken(claim) === co.claimHash;
    return send(res, 200, {
      paid: r.paid, status: r.status, mismatch: !!r.mismatch, plan: r.plan, period: r.period, amount: r.amount, currency: r.currency, school: r.school,
      renewal: !!(co && co.orgId && !co.claimHash),
      account: r.org ? (r.org.adminEmail ? 'ready' : owns ? 'claimable' : 'unclaimed') : null,
      email: owns ? co.email : undefined
    });
  }

  // ----- create the school admin account after paying
  if (p === '/api/claim' && m === 'POST') {
    if (limited(ip(req) + ':claim', 20, 10 * 60e3)) return send(res, 429, { error: 'too_many' });
    const b = await readJson(req);
    const co = db.checkouts[String(b.reference || '')];
    if (!co || !co.claimHash || S.hashToken(String(b.claimToken || '')) !== co.claimHash) return send(res, 403, { error: 'bad_claim' });
    if (!co.paid) { try { await confirm(String(b.reference)); } catch { /* checked below */ } }
    const org = co.orgId && db.orgs[co.orgId];
    if (!co.paid || !org) return send(res, 402, { error: 'not_paid' });
    if (org.adminEmail) return send(res, 409, { error: 'already_claimed' });
    const password = String(b.password || '');
    const name = String(b.name || co.name || '').trim().slice(0, 80);
    if (password.length < 8) return send(res, 400, { error: 'weak_password' });
    if (db.admins[co.email]) return send(res, 409, { error: 'email_in_use' });
    db.admins[co.email] = { email: co.email, name, orgId: org.id, hash: S.hashPassword(password), createdAt: Date.now() };
    org.adminEmail = co.email;
    co.claimHash = null; // single use
    store.save();
    logOrder({ event: 'claimed', school: org.name, schoolCode: org.code, email: co.email });
    startSession(res, 'admin', co.email, org.id);
    return send(res, 200, { ok: true, code: org.code });
  }

  // ----- sign in / out
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req);
    if (limited(ip(req) + ':login', 30, 10 * 60e3)) return send(res, 429, { error: 'too_many' });
    const password = String(b.password || '');
    if (b.kind === 'admin') {
      const email = String(b.email || '').trim().toLowerCase();
      if (limited('acct:' + email, 10, 15 * 60e3)) return send(res, 429, { error: 'too_many' });
      const admin = db.admins[email];
      if (!S.checkPassword(password, admin && admin.hash) || !db.orgs[admin.orgId]) return send(res, 401, { error: 'wrong_login' });
      admin.lastLogin = Date.now();
      startSession(res, 'admin', email, admin.orgId);
      return send(res, 200, { ok: true, kind: 'admin' });
    }
    const code = String(b.school || '').trim().toLowerCase();
    const username = String(b.username || '').trim().toLowerCase();
    if (limited('acct:' + code + ':' + username, 10, 15 * 60e3)) return send(res, 429, { error: 'too_many' });
    const org = Object.values(db.orgs).find((o) => o.code === code);
    const student = org && Object.values(db.students).find((s) => s.orgId === org.id && s.username === username);
    if (!S.checkPassword(password, student && student.hash) || student.disabled) return send(res, 401, { error: 'wrong_login' });
    if (!S.isActive(org)) return send(res, 403, { error: 'school_inactive' });
    student.lastLogin = Date.now();
    startSession(res, 'student', student.id, org.id);
    return send(res, 200, { ok: true, kind: 'student' });
  }
  if (p === '/api/logout' && m === 'POST') { endSession(req, res); return send(res, 200, { ok: true }); }

  // ----- school admin
  if (p.startsWith('/api/admin/')) {
    if (!sess || sess.kind !== 'admin') return send(res, 401, { error: 'sign_in' });
    const org = sess.org;
    const mine = () => Object.values(db.students).filter((s) => s.orgId === org.id);
    const pub = (s) => ({ id: s.id, name: s.name, group: s.group || '', username: s.username, disabled: !!s.disabled, createdAt: s.createdAt, lastLogin: s.lastLogin || null });

    if (p === '/api/admin/overview' && m === 'GET') {
      const payments = Object.entries(db.checkouts).filter(([, c]) => c.orgId === org.id && c.paid)
        .map(([ref, c]) => ({ reference: ref, plan: c.plan, period: c.period, amount: c.amount, paidAt: c.paidAt })).sort((a, b) => b.paidAt - a.paidAt);
      return send(res, 200, { org: orgView(org), admin: { name: sess.admin.name, email: sess.admin.email }, currency: CFG.currency, payments,
        signInUrl: (CFG.baseUrl || `http://${req.headers.host}`) + '/login.html?school=' + org.code });
    }
    if (p === '/api/admin/students' && m === 'GET') return send(res, 200, { students: mine().map(pub).sort((a, b) => a.name.localeCompare(b.name)) });

    if (p === '/api/admin/students' && m === 'POST') {
      const b = await readJson(req, 200e3);
      const list = Array.isArray(b.students) ? b.students : [];
      const clean = list.map((x) => ({ name: String(x.name || '').trim().slice(0, 80), group: String(x.group || '').trim().slice(0, 40) })).filter((x) => x.name.length >= 2);
      if (!clean.length) return send(res, 400, { error: 'no_students' });
      if (clean.length > 500) return send(res, 400, { error: 'too_many_at_once' });
      const existing = mine();
      if (existing.length + clean.length > (CFG.maxStudents[org.plan] || 0)) return send(res, 400, { error: 'plan_limit', detail: CFG.maxStudents[org.plan] });
      const taken = new Set(existing.map((s) => s.username));
      const created = [];
      for (const x of clean) {
        const parts = x.name.split(/\s+/);
        let base = S.slug(parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1] : parts[0], 20) || 'student';
        let u = base, n = 2;
        while (taken.has(u)) u = base + n++;
        taken.add(u);
        const password = S.studentPassword();
        const s = { id: S.newId(), orgId: org.id, name: x.name, group: x.group, username: u, hash: S.hashPassword(password), createdAt: Date.now() };
        db.students[s.id] = s;
        created.push(Object.assign(pub(s), { password }));
      }
      store.save();
      return send(res, 200, { created });
    }
    if (p === '/api/admin/students/reset' && m === 'POST') {
      const b = await readJson(req);
      const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
      const out = [];
      for (const s of mine()) if (ids.has(s.id)) {
        const password = S.studentPassword();
        s.hash = S.hashPassword(password);
        for (const [k, v] of Object.entries(db.sessions)) if (v.kind === 'student' && v.sub === s.id) delete db.sessions[k];
        out.push(Object.assign(pub(s), { password }));
      }
      store.save();
      return send(res, 200, { reset: out });
    }
    if (p === '/api/admin/students/update' && m === 'POST') {
      const b = await readJson(req);
      const s = db.students[String(b.id || '')];
      if (!s || s.orgId !== org.id) return send(res, 404, { error: 'not_found' });
      if (typeof b.disabled === 'boolean') {
        s.disabled = b.disabled;
        if (s.disabled) for (const [k, v] of Object.entries(db.sessions)) if (v.kind === 'student' && v.sub === s.id) delete db.sessions[k];
      }
      if (typeof b.name === 'string' && b.name.trim().length >= 2) s.name = b.name.trim().slice(0, 80);
      if (typeof b.group === 'string') s.group = b.group.trim().slice(0, 40);
      store.save();
      return send(res, 200, { student: pub(s) });
    }
    if (p === '/api/admin/students/delete' && m === 'POST') {
      const b = await readJson(req);
      const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
      let n = 0;
      for (const s of mine()) if (ids.has(s.id)) {
        delete db.students[s.id]; n++;
        for (const [k, v] of Object.entries(db.sessions)) if (v.kind === 'student' && v.sub === s.id) delete db.sessions[k];
      }
      store.save();
      return send(res, 200, { deleted: n });
    }
    if (p === '/api/admin/password' && m === 'POST') {
      const b = await readJson(req);
      if (!S.checkPassword(String(b.current || ''), sess.admin.hash)) return send(res, 400, { error: 'wrong_password' });
      if (String(b.next || '').length < 8) return send(res, 400, { error: 'weak_password' });
      sess.admin.hash = S.hashPassword(String(b.next));
      // Sign out other devices.
      const current = S.hashToken(parseCookies(req).elib_s);
      for (const [k, v] of Object.entries(db.sessions)) if (v.kind === 'admin' && v.sub === sess.admin.email && k !== current) delete db.sessions[k];
      store.save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not_found' });
  }

  // ----- Paystack webhook
  if (p === '/api/paystack/webhook' && m === 'POST') {
    let raw;
    try { raw = await readBody(req, 1e6); } catch { return send(res, 413, { error: 'too_large' }); }
    if (!paymentsOn() || !verifySignature(raw, req.headers['x-paystack-signature'])) return send(res, 401, { error: 'bad_signature' });
    send(res, 200, { ok: true }); // answer Paystack quickly, then do the work
    let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch { return; }
    const ref = ev.data && ev.data.reference;
    if (ev.event === 'charge.success' && ref) {
      const work = db.checkouts[ref] ? confirm(ref) : confirmRenewal(ref, ev.data);
      work.catch((e) => console.error('webhook handling failed:', e.message));
    } else if (/^subscription\.|^invoice\./.test(ev.event || '')) {
      logOrder({ event: ev.event, subscription: ev.data && ev.data.subscription_code, email: ev.data && ev.data.customer && ev.data.customer.email, status: ev.data && ev.data.status });
    }
    return;
  }

  return send(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------- pages and files
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  if (rel === '/') rel = '/portfolio.html';
  if (rel === '/library' || rel === '/library/') return redirect(res, '/index.html');
  if (rel.endsWith('/')) rel += 'index.html';
  if (HIDDEN.test(rel)) return send(res, 404, 'Not found', 'text/plain');

  // Reading needs a signed-in student or admin of a school with an active plan.
  // Book covers and the book list stay public so the website can show the collection.
  const isBook = rel.startsWith('/books/');
  const isReading = rel === '/index.html' || (isBook && !/^\/books\/\d+\/cover\.jpg$/.test(rel));
  let sess = null;
  if (isReading || rel === '/admin.html' || rel === '/login.html') sess = getSession(req);
  if (isReading && !canRead(sess)) {
    if (isBook) return send(res, 401, 'Please sign in to read.', 'text/plain');
    if (sess && sess.kind === 'admin') return redirect(res, '/admin.html');
    return redirect(res, '/login.html?next=' + encodeURIComponent('/index.html' + (url.search || '')) + (sess ? '&inactive=1' : ''));
  }
  if (rel === '/admin.html' && !(sess && sess.kind === 'admin')) return redirect(res, '/login.html?as=admin');
  if (rel === '/login.html' && sess && !url.searchParams.has('switch')) return redirect(res, sess.kind === 'admin' ? '/admin.html' : '/index.html');

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    if (ext === '.html' && !isBook) {
      return fs.readFile(file, 'utf8', (e, html) => {
        if (e) return send(res, 500, 'Error', 'text/plain');
        const extra = sess ? {
          USER_KIND: sess.kind,
          USER_KEY: sess.org.code + ':' + (sess.kind === 'admin' ? 'admin' : sess.student.username),
          USER_NAME: sess.kind === 'admin' ? (sess.admin.name || sess.admin.email) : sess.student.name,
          SCHOOL_NAME: sess.org.name
        } : null;
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(fillTemplate(html, extra));
      });
    }
    // Books rarely change: cache them. Site files (scripts, styles) are re-checked each time so updates arrive at once.
    // Reading content must re-check sign-in every time (a quick 304 when unchanged), so signing out really locks it.
    const cache = isReading ? 'private, no-cache' : isBook ? 'public, max-age=86400' : 'no-cache';
    const lastMod = st.mtime.toUTCString();
    const since = Date.parse(req.headers['if-modified-since'] || '');
    if (since && Math.floor(st.mtimeMs / 1000) <= Math.floor(since / 1000)) {
      res.writeHead(304, { 'Cache-Control': cache, 'Last-Modified': lastMod });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache, 'Last-Modified': lastMod });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad_request' }); }
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url).catch((e) => {
      if (e && (e.code === 415 || e.code === 400)) return send(res, e.code, { error: 'bad_request' });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'server_error' });
    });
  }
  serveStatic(req, res, url);
});

server.listen(CFG.port, () => {
  console.log(`eLibrary website running on http://localhost:${CFG.port}`);
  console.log(`Accounts: ${Object.keys(db.orgs).length} schools, ${Object.keys(db.students).length} students.`);
  if (!paymentsOn()) console.log('Payments are OFF: set PAYSTACK_SECRET_KEY to turn them on.');
  else console.log(`Payments are ON (${testMode() ? 'TEST mode' : 'LIVE mode'}).`);
  if (!CFG.baseUrl) console.log('Tip: set PUBLIC_BASE_URL to your site address so Paystack returns customers to the right page.');
  ensurePlans();
});
