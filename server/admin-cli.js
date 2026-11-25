/*
  Support tool for the website owner.

    node server/admin-cli.js schools                 list schools, plans and admins
    node server/admin-cli.js reset-admin <email>     give a school admin a new temporary password
    node server/admin-cli.js extend <code> <days>    add free days to a school's plan (e.g. after a bank transfer)
    node server/admin-cli.js create-school <email> <days> <school name...>
                                                     set up a school without online payment (bank transfer, demo,
                                                     or trying it on localhost). Uses the School plan.

  Where to run it:
  - Accounts in MongoDB (MONGODB_URI set, e.g. on Render's free plan): on any computer with Node.js.
    Run "npm install" in the library folder once, and put the same MONGODB_URI in server/.env.
  - Accounts in a file (DATA_DIR/accounts.json): on the server itself (e.g. Render > Shell).

  The running website picks up the change within a few seconds.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./store');

// Same settings file as the website.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file: fine */ }

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const [cmd, a, b] = process.argv.slice(2);
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-');

main().catch((e) => { console.error(e.message); process.exit(1); });

async function main() {
const store = await S.openStore(dataDir);
const db = store.db;
const done = async (code) => { await store.close(); process.exit(code || 0); };

if (cmd === 'schools') {
  const rows = Object.values(db.orgs).map((o) => ({
    code: o.code, school: o.name, plan: o.plan, paidUntil: day(o.paidUntil), active: S.isActive(o),
    admin: o.adminEmail || '(not created yet)', students: Object.values(db.students).filter((s) => s.orgId === o.id).length
  }));
  console.table(rows);
} else if (cmd === 'reset-admin' && a) {
  const admin = db.admins[a.trim().toLowerCase()];
  if (!admin) { console.error('No admin with that email.'); return done(1); }
  const temp = S.studentPassword() + '-' + S.studentPassword();
  admin.hash = S.hashPassword(temp);
  for (const [k, v] of Object.entries(db.sessions)) if (v.kind === 'admin' && v.sub === admin.email) delete db.sessions[k];
  store.save();
  console.log(`New temporary password for ${admin.email}: ${temp}\nAsk them to change it in their dashboard after signing in.`);
} else if (cmd === 'extend' && a && +b > 0) {
  const org = Object.values(db.orgs).find((o) => o.code === a.trim().toLowerCase());
  if (!org) { console.error('No school with that code.'); return done(1); }
  org.paidUntil = Math.max(Date.now(), org.paidUntil || 0) + (+b) * S.DAY;
  store.save();
  console.log(`${org.name} (${org.code}) is now paid until ${day(org.paidUntil)}.`);
} else if (cmd === 'create-school' && a && +b > 0 && process.argv.length > 5) {
  const email = a.trim().toLowerCase();
  const name = process.argv.slice(5).join(' ').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('That email does not look right.'); return done(1); }
  if (db.admins[email]) { console.error('That email already has an admin account.'); return done(1); }
  const initials = name.split(/\s+/).map((w) => w[0] || '').join('').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4) || 'sch';
  const taken = new Set(Object.values(db.orgs).map((o) => o.code));
  let code; do { code = initials + (100 + Math.floor(Math.random() * 900)); } while (taken.has(code));
  const org = { id: S.newId(), code, name, plan: 'school', status: 'active', paidUntil: Date.now() + (+b) * S.DAY,
    createdAt: Date.now(), payerEmail: email, adminEmail: email, manual: true };
  const temp = S.studentPassword() + '-' + S.studentPassword();
  db.orgs[org.id] = org;
  db.admins[email] = { email, name: '', orgId: org.id, hash: S.hashPassword(temp), createdAt: Date.now() };
  store.save();
  console.log(`Created ${name} (school code ${code}), paid until ${day(org.paidUntil)}.`);
  console.log(`Admin sign-in: ${email}  /  temporary password: ${temp}`);
  console.log('Sign in as "School admin", then change the password in the dashboard.');
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace('/*', '').trim());
}
await done(0);
}
