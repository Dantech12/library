/*
  Accounts store: schools (orgs), school admins, students, sessions and checkouts.
  Kept in one JSON file (DATA_DIR/accounts.json), written safely after every change.
  Comfortable for thousands of students. Passwords are hashed with scrypt; only token hashes are stored.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 864e5;
const GRACE_DAYS = 7;

function createStore(dataDir) {
  const file = path.join(dataDir, 'accounts.json');
  let db = { orgs: {}, admins: {}, students: {}, sessions: {}, checkouts: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('accounts.json is damaged: ' + e.message + ' (restore it from a backup)');
  }

  let lastMtime = 0;
  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
    try { lastMtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
  }

  // Pick up changes made by the support tool (server/admin-cli.js) while the website is running.
  function watch() {
    try { lastMtime = fs.statSync(file).mtimeMs; } catch { /* not created yet */ }
    fs.watchFile(file, { interval: 2000 }, (cur) => {
      if (!cur.mtimeMs || cur.mtimeMs === lastMtime) return;
      try {
        const fresh = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const k of Object.keys(db)) if (fresh[k]) db[k] = fresh[k];
        lastMtime = cur.mtimeMs;
        console.log('accounts.json changed on disk: reloaded.');
      } catch (e) { console.error('Could not reload accounts.json:', e.message); }
    }).unref();
  }

  // Remove expired sessions and old unpaid checkouts once an hour.
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) { delete db.sessions[k]; changed = true; }
    for (const [k, c] of Object.entries(db.checkouts)) if (!c.paid && now - c.createdAt > 3 * DAY) { delete db.checkouts[k]; changed = true; }
    if (changed) save();
  }, 3600e3).unref();

  return { db, save, watch };
}

// ---------------------------------------------------------------- crypto helpers
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw).normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) { crypto.scryptSync('x', 'dummy-salt-value', 32); return false; }
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hashHex, 'hex');
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}

// Easy-to-type student passwords like "mango-4821".
const WORDS = ('apple bead bird book cake calm cloud coal corn crab desk drum duck eagle earth fern fish flag flute fox frog '
  + 'gold goat grape hill honey horse jade kite lake lamp leaf lemon lion lily mango maple melon mint moon mouse nest '
  + 'nut oak ocean olive owl palm panda pear pearl pen pine plum pond rain river robin rock rose ruby sail salt sand '
  + 'seed shell ship silk sky snow spark star stone sun swan tiger toast tree tulip violet wave whale wind wolf yam zebra').split(' ');
function studentPassword() {
  return WORDS[crypto.randomInt(WORDS.length)] + '-' + String(crypto.randomInt(1000, 10000));
}

function slug(s, max) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, max || 24).replace(/\.+$/, '');
}

function isActive(org, now) {
  return !!org && org.status !== 'suspended' && (org.paidUntil || 0) + GRACE_DAYS * DAY > (now || Date.now());
}

function addPeriod(fromMs, months) {
  const d = new Date(fromMs);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

module.exports = { createStore, newToken, hashToken, newId, hashPassword, checkPassword, studentPassword, slug, isActive, addPeriod, DAY, GRACE_DAYS };
