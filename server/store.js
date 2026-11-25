/*
  Accounts store: schools (orgs), school admins, students, sessions and checkouts.
  Passwords are hashed with scrypt; only token hashes are stored.

  Two places it can live:
  - MongoDB, when MONGODB_URI is set (for hosts whose disk is wiped on restart, like Render's free plan).
    Each school, admin, student, session and checkout is its own document in the "records" collection,
    and only the ones that changed are written. The payment log goes to the "orders" collection.
  - Otherwise one JSON file (DATA_DIR/accounts.json), written safely after every change,
    with the payment log in DATA_DIR/orders.jsonl. Needs no extra packages.

  Either way the website keeps everything in memory (comfortable for thousands of students),
  and picks up changes made by the support tool (server/admin-cli.js) while it is running.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 864e5;
const GRACE_DAYS = 7;
const KINDS = ['orgs', 'admins', 'students', 'sessions', 'checkouts'];
const emptyDb = () => ({ orgs: {}, admins: {}, students: {}, sessions: {}, checkouts: {} });

// Pick the store from the settings: MongoDB if MONGODB_URI is set, else the JSON file.
async function openStore(dataDir) {
  const uri = (process.env.MONGODB_URI || '').trim();
  const store = uri ? await createMongoStore(uri, process.env.MONGODB_DB || 'bookbridge') : createFileStore(dataDir);
  startCleanup(store);
  return store;
}

// Remove expired sessions and old unpaid checkouts once an hour.
function startCleanup(store) {
  setInterval(() => {
    const db = store.db, now = Date.now();
    let changed = false;
    for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) { delete db.sessions[k]; changed = true; }
    for (const [k, c] of Object.entries(db.checkouts)) if (!c.paid && now - c.createdAt > 3 * DAY) { delete db.checkouts[k]; changed = true; }
    if (changed) store.save();
  }, 3600e3).unref();
}

// ---------------------------------------------------------------- JSON file
function createFileStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'accounts.json');
  const ordersFile = path.join(dataDir, 'orders.jsonl');
  const db = emptyDb();
  try { Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('accounts.json is damaged: ' + e.message + ' (restore it from a backup)');
  }

  let lastMtime = 0;
  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
    try { lastMtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
  }

  function watch() {
    try { lastMtime = fs.statSync(file).mtimeMs; } catch { /* not created yet */ }
    fs.watchFile(file, { interval: 2000 }, (cur) => {
      if (!cur.mtimeMs || cur.mtimeMs === lastMtime) return;
      try {
        const fresh = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const k of KINDS) if (fresh[k]) db[k] = fresh[k];
        lastMtime = cur.mtimeMs;
        console.log('accounts.json changed on disk: reloaded.');
      } catch (e) { console.error('Could not reload accounts.json:', e.message); }
    }).unref();
  }

  function logOrder(o) {
    fs.appendFile(ordersFile, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n', (e) => e && console.error('order log:', e.message));
  }

  return { kind: 'file', where: file, db, save, watch, logOrder, flush: async () => {}, close: async () => {} };
}

// ---------------------------------------------------------------- MongoDB
async function createMongoStore(uri, dbName) {
  let mongodb;
  try { mongodb = require('mongodb'); } catch {
    throw new Error('MONGODB_URI is set, but the mongodb package is not installed. Run "npm install" in the library folder.');
  }
  const client = new mongodb.MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const m = client.db(dbName);
  return createDocStore({
    records: m.collection('records'), meta: m.collection('meta'), orders: m.collection('orders'),
    close: () => client.close(), where: 'MongoDB database "' + dbName + '"'
  });
}

// The MongoDB logic, kept apart from the driver so it can be tested with a stand-in.
async function createDocStore(c) {
  const db = emptyDb();
  let snap = new Map(); // record id -> JSON last written or read, to find what changed
  let knownRev = 0;     // bumped on every write by anyone; a different value means someone else wrote

  async function load() {
    const fresh = emptyDb();
    const s = new Map();
    for await (const r of c.records.find({})) {
      if (!fresh[r.kind]) continue;
      fresh[r.kind][r.key] = r.v;
      s.set(r._id, JSON.stringify(r.v));
    }
    const meta = await c.meta.findOne({ _id: 'accounts' });
    for (const k of KINDS) db[k] = fresh[k];
    snap = s;
    knownRev = (meta && meta.rev) || 0;
  }

  async function write() {
    const ops = [];
    const next = new Map();
    for (const kind of KINDS) for (const [key, v] of Object.entries(db[kind])) {
      const id = kind + ':' + key;
      const j = JSON.stringify(v);
      next.set(id, j);
      if (snap.get(id) !== j) ops.push({ replaceOne: { filter: { _id: id }, replacement: { kind, key, v: JSON.parse(j) }, upsert: true } });
    }
    for (const id of snap.keys()) if (!next.has(id)) ops.push({ deleteOne: { filter: { _id: id } } });
    if (!ops.length) return;
    await c.records.bulkWrite(ops, { ordered: false });
    snap = next;
    const meta = await c.meta.findOneAndUpdate({ _id: 'accounts' }, { $inc: { rev: 1 } }, { upsert: true, returnDocument: 'after' });
    const rev = meta && (meta.value !== undefined ? meta.value && meta.value.rev : meta.rev);
    if (rev === knownRev + 1) knownRev = rev; // otherwise someone else wrote as well: the next check reloads
  }

  // Writes run one at a time, in order. A failed write is retried, and nothing is lost meanwhile: it is all in memory.
  let chain = Promise.resolve();
  function queue(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }
  let scheduled = false;
  function save() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      queue(write).catch((e) => { console.error('Could not save to the database (will retry):', e.message); setTimeout(save, 5000); });
    }, 50);
  }
  const flush = () => queue(write);

  function watch() {
    setInterval(() => {
      queue(async () => {
        const meta = await c.meta.findOne({ _id: 'accounts' });
        if (((meta && meta.rev) || 0) === knownRev) return;
        await write(); // keep our own latest changes
        await load();
        console.log('Accounts changed in the database: reloaded.');
      }).catch((e) => console.error('Could not check the database for changes:', e.message));
    }, 10e3).unref();
  }

  function logOrder(o) {
    c.orders.insertOne({ at: new Date().toISOString(), ...o }).catch((e) => console.error('order log:', e.message));
  }

  async function close() {
    await flush().catch((e) => console.error('Could not save to the database:', e.message));
    if (c.close) await c.close();
  }

  await load();
  return { kind: 'mongodb', where: c.where || 'database', db, save, watch, logOrder, flush, close };
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

module.exports = { openStore, createDocStore, newToken, hashToken, newId, hashPassword, checkPassword, studentPassword, slug, isActive, addPeriod, DAY, GRACE_DAYS };
