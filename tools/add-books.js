/*
  Adds books to the eLibrary from Project Gutenberg (free, public-domain books).

  1. Open tools/book-list.txt and add Gutenberg book numbers to the right line.
     (The number is in the book's web address, e.g. gutenberg.org/ebooks/1342 -> 1342.)
     Textbooks take a subject:  12345:Science
  2. Install Node.js (nodejs.org) and run, from the library folder:
        node tools/add-books.js
  Books already downloaded are skipped, so it is safe to run again.
*/
const fs = require('fs'), path = require('path');
const LIB = path.join(__dirname, '..');
const CATALOG = path.join(__dirname, 'pg_catalog.csv');
// Main site first; if it is busy, the official Gutenberg mirror is used instead.
const SITES = ['https://www.gutenberg.org/', 'https://gutenberg.pglaf.org/'];
const BASE = 'cache/epub/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let mainDown = false;
async function get(rel) {
  for (const site of SITES) {
    if (site === SITES[0] && mainDown) continue;
    const b = await getOne(site + rel, site === SITES[0] ? 2 : 3);
    if (b !== undefined) return b;
    if (site === SITES[0]) { mainDown = true; console.log('  gutenberg.org is busy, using the mirror instead'); }
  }
  console.error('  could not download', rel); return null;
}
async function getOne(url, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'school-elibrary/1.0' } });
      if (r.status == 404) return null; // the book or picture does not exist
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i == tries - 1) return undefined; // try the next site
      await sleep(1500 * (i + 1));
    }
  }
}
function parseCSV(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c == '"') { if (t[i + 1] == '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c == '"') q = true; else if (c == ',') { r.push(f); f = '' }
    else if (c == '\n') { r.push(f); rows.push(r); r = []; f = '' } else if (c != '\r') f += c;
  }
  return rows;
}
function person(a) {
  if (!a) return 'Unknown';
  const parts = a.split('; ');
  const first = parts.find(x => !/\[(Illustrator|Translator|Editor|Contributor|Commentator)/.test(x)) || parts[0];
  let s = first.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/,?\s*-?\d{1,4}\??\s*(BCE)?-?\d{0,4}\??\s*(BCE)?\s*$/, '').trim().replace(/,$/, '');
  const p = s.split(',').map(x => x.trim()).filter(Boolean);
  if (p.length >= 2) s = p.slice(1).join(' ') + ' ' + p[0];
  return s.replace(/\s+/g, ' ').trim();
}

// Gutenberg makes a plain 200x300 cover for books that have none. Those are skipped (false),
// so the library draws its own designed cover with the title instead.
function realCover(dir) {
  const f = path.join(dir, 'cover.jpg');
  if (!fs.existsSync(f)) return false;
  const b = fs.readFileSync(f);
  let i = 2, d = null;
  while (i < b.length - 8) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xC3) { d = [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; break; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  const own = fs.existsSync(path.join(dir, 'images', 'cover.jpg')) || fs.existsSync(path.join(dir, 'images', 'cover.png'));
  return !(d && d[0] === 200 && d[1] === 300 && !own);
}

async function downloadBook(p, m) {
  const dir = path.join(LIB, 'books', p.id);
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'index.html');
  let html;
  if (fs.existsSync(indexFile)) html = fs.readFileSync(indexFile, 'utf8');
  else {
    const raw = await get(`${BASE}${p.id}/pg${p.id}-images.html`) || await get(`${BASE}${p.id}/pg${p.id}.html`);
    if (!raw) { console.error('  NOT FOUND on Gutenberg:', p.id); return false; }
    html = raw.toString('utf8')
      .replace(/<header[^>]*id="pg-header"[\s\S]*?<\/header>/, '')
      .replace(/<footer[^>]*id="pg-footer"[\s\S]*?<\/footer>/, '')
      .replace(/<link[^>]*rel="icon"[^>]*>/g, '')
      .replace('</head>', '<link rel="stylesheet" href="../../assets/book.css"><script src="../../assets/book.js"></script></head>');
  }
  // Pictures (also fills in any that failed last time)
  const srcs = new Set();
  html.replace(/<img[^>]*?src="([^"]+)"/g, (_, s) => { if (!/^(https?:|data:|\/)/.test(s)) srcs.add(s) });
  html.replace(/<a[^>]*?href="(images\/[^"]+\.(?:jpg|jpeg|png|gif))"/gi, (_, s) => srcs.add(s));
  const list = [...srcs].filter(s => !fs.existsSync(path.join(dir, decodeURIComponent(s))));
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async s => {
      const b = await get(`${BASE}${p.id}/${s}`);
      if (b) { const f = path.join(dir, decodeURIComponent(s)); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); }
    }));
  }
  fs.writeFileSync(indexFile, html);
  if (!fs.existsSync(path.join(dir, 'cover.jpg'))) {
    const cover = await get(`${BASE}${p.id}/pg${p.id}.cover.medium.jpg`);
    if (cover) fs.writeFileSync(path.join(dir, 'cover.jpg'), cover);
  }
  return true;
}

(async () => {
  if (!fs.existsSync(CATALOG)) {
    console.log('Downloading the Gutenberg catalogue (about 15 MB)…');
    const c = await get('cache/epub/feeds/pg_catalog.csv');
    if (!c) { console.error('Could not download the catalogue. Check the internet connection, or try again later.'); process.exit(1); }
    fs.writeFileSync(CATALOG, c);
  }
  const meta = new Map(parseCSV(fs.readFileSync(CATALOG, 'utf8')).map(r => [r[0], r]));
  const picks = [];
  for (const line of fs.readFileSync(path.join(__dirname, 'book-list.txt'), 'utf8').trim().split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const [cat, ...ids] = line.trim().split(/\s+/);
    for (const x of ids) { const [id, subject] = x.split(':'); picks.push({ id, cat, subject }); }
  }
  const out = new Array(picks.length); let next = 0, done = 0;
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (next < picks.length) {
      const k = next++, p = picks[k], m = meta.get(p.id);
      if (!m) { console.error('  Unknown book number:', p.id); continue; }
      if (!(await downloadBook(p, m))) continue;
      const dir = path.join(LIB, 'books', p.id);
      const [title, ...sub] = m[3].split('\n');
      const imgDir = path.join(dir, 'images');
      out[k] = {
        id: +p.id, cat: p.cat, subject: p.subject || null, title: title.trim(), subtitle: sub.join(' ').trim() || null,
        author: person(m[5]), subjects: (m[6] || '').split('; ').slice(0, 4).map(s => s.split(' -- ')[0]),
        cover: realCover(dir),
        pictures: fs.existsSync(imgDir) && fs.readdirSync(imgDir).length > 2
      };
      console.log(`[${++done}/${picks.length}] ${out[k].title}`);
    }
  }));
  const books = out.filter(Boolean);
  fs.writeFileSync(path.join(LIB, 'assets', 'catalog.js'), '// Generated by tools/add-books.js — the list of books in this library\nwindow.LIBRARY = ' + JSON.stringify(books, null, 1) + ';\n');
  console.log(`\nDone. The library now has ${books.length} books.`);
})();
