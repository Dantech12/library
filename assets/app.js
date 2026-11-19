/* School eLibrary — runs fully in the browser, no server needed. */
(function () {
  'use strict';

  // ---- Settings the school can change ------------------------------------
  var LIBRARY_NAME = 'School eLibrary';

  var CATEGORIES = [
    { key: 'novels',    label: 'Novels',                 emoji: '📖', blurb: 'Classic novels: adventure, mystery, science fiction and more.' },
    { key: 'stories',   label: 'Stories & Folktales',    emoji: '🦊', blurb: 'Fairy tales, fables, myths and folktales from Africa and around the world.' },
    { key: 'comics',    label: 'Comics & Picture Books', emoji: '🎨', blurb: 'Illustrated books, comic strips, cartoons and picture books for younger readers.' },
    { key: 'poetry',    label: 'Poetry & Plays',         emoji: '🎭', blurb: 'Poems, verse for children, Shakespeare and epic poetry.' },
    { key: 'textbooks', label: 'Textbooks',              emoji: '🧮', blurb: 'Learning books for Mathematics, Science, History, Geography and English.' },
    { key: 'reference', label: 'Encyclopedia',           emoji: '🌍', blurb: 'Search the online encyclopedia, or open the encyclopedias and dictionaries kept in the library.' }
  ];

  var ONLINE = [
    { name: 'OpenStax', url: 'https://openstax.org/subjects', tag: 'Modern textbooks', text: 'Free, up-to-date textbooks for Maths, Science, Biology, Physics, Chemistry, Economics and more.' },
    { name: 'African Storybook', url: 'https://www.africanstorybook.org/', tag: 'Picture stories', text: 'Thousands of illustrated stories for children, in English and many African languages.' },
    { name: 'StoryWeaver', url: 'https://storyweaver.org.in/', tag: 'Picture stories', text: 'Free illustrated storybooks for early readers in hundreds of languages.' },
    { name: 'Project Gutenberg', url: 'https://www.gutenberg.org/', tag: '70,000+ books', text: 'Where this library’s books come from. Thousands more free classic books to read online.' },
    { name: 'Open Library', url: 'https://openlibrary.org/', tag: 'Borrow books', text: 'Borrow millions of books online with a free account.' },
    { name: 'Wikijunior', url: 'https://en.wikibooks.org/wiki/Wikijunior', tag: 'Kids non-fiction', text: 'Free non-fiction books written for children aged 8 to 11.' },
    { name: 'Simple English Wikipedia', url: 'https://simple.wikipedia.org/', tag: 'Encyclopedia', text: 'The encyclopedia written in easy English, good for younger learners.' },
    { name: 'Internet Archive Books', url: 'https://archive.org/details/texts', tag: 'Books & comics', text: 'A huge digital archive of books, magazines and old comics.' }
  ];

  var WIKI_TOPICS = ['Ghana', 'Solar System', 'Photosynthesis', 'Human body', 'Volcano', 'Africa', 'Computer', 'Kwame Nkrumah', 'Water cycle', 'Dinosaur', 'Electricity', 'Ancient Egypt'];

  // ---- State ---------------------------------------------------------------
  var BOOKS = (window.LIBRARY || []).slice();
  var byId = {};
  BOOKS.forEach(function (b) { byId[b.id] = b; });

  // Who is signed in (set by the server; empty in the offline copy).
  function meta(name) {
    var m = document.querySelector('meta[name="' + name + '"]');
    var v = m ? m.getAttribute('content') : '';
    return v && v.indexOf('{{') !== 0 ? v : '';
  }
  var USER = { key: meta('elib-user'), name: meta('elib-user-name'), kind: meta('elib-user-kind'), school: meta('elib-school') };
  // Each signed-in student keeps their own progress and favourites, even on a shared device.
  var STORE_KEY = USER.key ? 'elibrary:' + USER.key : 'elibrary';

  var store = load();
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage blocked */ }
  }
  store.progress = store.progress || {};
  store.favs = store.favs || [];
  store.fontSize = store.fontSize || 19;
  store.page = store.page || 'light';

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var view = $('#view');
  var displayName = USER.school ? USER.school + ' Library' : LIBRARY_NAME;
  document.title = displayName;
  $('#libName').textContent = displayName;
  if (USER.key) {
    $('#userBox').hidden = false;
    $('#userName').textContent = USER.name;
    $('#adminLink').hidden = USER.kind !== 'admin';
    $('#signOut').addEventListener('click', function () {
      fetch('/api/logout', { method: 'POST' }).catch(function () {}).then(function () { location.href = '/login.html'; });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Site theme -------------------------------------------------------------
  if (store.siteTheme) document.documentElement.setAttribute('data-theme', store.siteTheme);
  $('#themeBtn').addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    store.siteTheme = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', store.siteTheme);
    save();
  });

  // ---- Tabs ------------------------------------------------------------------
  var TABS = [{ key: 'home', label: 'Home' }].concat(CATEGORIES.map(function (c) { return { key: c.key, label: c.label }; }))
    .concat([{ key: 'shelf', label: 'My Shelf' }, { key: 'online', label: 'More Online' }]);
  $('#tabs').innerHTML = TABS.map(function (t) {
    return '<a class="tab" style="--c:var(--c-' + t.key + ')" href="#' + t.key + '" data-tab="' + t.key + '">' + esc(t.label) + '</a>';
  }).join('');

  // ---- Covers & cards -------------------------------------------------------
  var PALETTE = ['#2563eb', '#f97316', '#ec4899', '#8b5cf6', '#10b981', '#0ea5e9', '#ef4444', '#14b8a6', '#6366f1', '#f59e0b'];
  var COVER_COLOURS = {
    novels: ['#2563eb', '#7c3aed'], stories: ['#f97316', '#e11d48'], comics: ['#ec4899', '#8b5cf6'],
    poetry: ['#8b5cf6', '#2563eb'], textbooks: ['#10b981', '#0ea5e9'], reference: ['#0ea5e9', '#4f46e5']
  };
  function coverHTML(b) {
    var p = store.progress[b.id];
    var prog = p && p.frac > 0.01 ? '<div class="prog"><i style="width:' + Math.round(p.frac * 100) + '%"></i></div>' : '';
    var badge = b.pictures ? '<span class="badge">Illustrated</span>' : '';
    if (b.cover) {
      return '<div class="cover"><img loading="lazy" src="books/' + b.id + '/cover.jpg" alt="">' + badge + prog + '</div>';
    }
    // Designed cover for books without a real one: the section's colours, varied a little per book.
    var g = COVER_COLOURS[b.cat] || [PALETTE[b.id % PALETTE.length], '#1e1b4b'];
    var angle = 140 + (b.id % 5) * 12;
    var title = b.title.length > 60 ? b.title.slice(0, 57) + '…' : b.title;
    return '<div class="cover gen" style="background:linear-gradient(' + angle + 'deg,' + g[0] + ',' + g[1] + ')">' +
      '<span class="gen-cat">' + esc(catLabel(b.cat)) + '</span><b>' + esc(title) + '</b><small>' + esc(b.author) + '</small>' + badge + prog + '</div>';
  }
  function cardHTML(b) {
    var fav = store.favs.indexOf(b.id) >= 0;
    return '<div class="card">' +
      '<button class="card-open" data-open="' + b.id + '" style="all:unset;cursor:pointer;display:flex;flex-direction:column;gap:8px" aria-label="Read ' + esc(b.title) + ' by ' + esc(b.author) + '">' +
      coverHTML(b) +
      '<div class="card-title">' + esc(b.title) + '</div>' +
      '<div class="card-author">' + esc(b.author) + '</div></button>' +
      '<button class="fav" data-fav="' + b.id + '" aria-pressed="' + fav + '" title="' + (fav ? 'Remove from My Shelf' : 'Add to My Shelf') + '" aria-label="' + (fav ? 'Remove from My Shelf' : 'Add to My Shelf') + '">' + (fav ? '♥' : '♡') + '</button>' +
      '</div>';
  }
  function cards(list) { return list.map(cardHTML).join(''); }
  function ico(emoji, key) { return '<span class="sec-ico" style="--c:var(--c-' + key + ')" aria-hidden="true">' + emoji + '</span>'; }
  function head(emoji, key, title, text) {
    return '<div class="page-head" style="--c:var(--c-' + key + ')"><span class="sec-ico" aria-hidden="true">' + emoji + '</span><div><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p></div></div>';
  }

  // ---- Search -----------------------------------------------------------------
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function searchBooks(q) {
    var words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return BOOKS.map(function (b) {
      var hay = norm([b.title, b.subtitle, b.author, (b.subjects || []).join(' '), b.subject, catLabel(b.cat)].join(' '));
      var t = norm(b.title + ' ' + b.author);
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        if (hay.indexOf(words[i]) < 0) return null;
        score += t.indexOf(words[i]) >= 0 ? 3 : 1;
      }
      return { b: b, score: score };
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).map(function (x) { return x.b; });
  }
  function catLabel(k) { var c = CATEGORIES.filter(function (c) { return c.key === k; })[0]; return c ? c.label : ''; }

  $('#searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('#searchInput').value.trim();
    location.hash = q ? 'search/' + encodeURIComponent(q) : 'home';
  });
  var typing;
  $('#searchInput').addEventListener('input', function () {
    clearTimeout(typing);
    var q = this.value.trim();
    typing = setTimeout(function () {
      if (q.length >= 2) history.replaceState(null, '', '#search/' + encodeURIComponent(q)), route();
      else if (!q && location.hash.indexOf('#search/') === 0) location.hash = 'home';
    }, 250);
  });

  // ---- Pages -----------------------------------------------------------------
  function sortTitle(a, b) { return a.title.replace(/^(the|a|an) /i, '').localeCompare(b.title.replace(/^(the|a|an) /i, '')); }

  function renderHome() {
    var reading = Object.keys(store.progress)
      .map(function (id) { return { b: byId[id], p: store.progress[id] }; })
      .filter(function (x) { return x.b && x.p.frac < 0.98; })
      .sort(function (a, b) { return b.p.ts - a.p.ts; })
      .map(function (x) { return x.b; }).slice(0, 12);

    var pictures = BOOKS.filter(function (b) { return b.pictures; }).length;
    var html = '<section class="hero"><div><h1>Welcome to the ' + esc(LIBRARY_NAME) + '</h1>' +
      '<p>Pick a book and start reading. Everything here is free and works without internet. Use the search box to find a title, an author or a topic.</p></div>' +
      '<div class="stats"><div class="stat"><b>' + BOOKS.length + '</b><span>books</span></div>' +
      '<div class="stat"><b>' + CATEGORIES.length + '</b><span>sections</span></div>' +
      '<div class="stat"><b>' + pictures + '</b><span>illustrated</span></div></div></section>';

    html += '<div class="quick">' + CATEGORIES.map(function (c) {
      var n = BOOKS.filter(function (b) { return b.cat === c.key; }).length;
      return '<a href="#' + c.key + '" style="--c:var(--c-' + c.key + ')"><span class="emoji" aria-hidden="true">' + c.emoji + '</span><span>' + esc(c.label) + '<small>' + n + ' book' + (n === 1 ? '' : 's') + '</small></span></a>';
    }).join('') + '</div>';

    if (reading.length) {
      html += '<div class="section-head"><h2>' + ico('📌', 'shelf') + 'Continue reading</h2><a href="#shelf">My Shelf →</a></div><div class="shelf">' + cards(reading) + '</div>';
    }
    CATEGORIES.forEach(function (c) {
      var list = BOOKS.filter(function (b) { return b.cat === c.key; });
      if (!list.length) return;
      html += '<div class="section-head"><h2>' + ico(c.emoji, c.key) + esc(c.label) + '</h2><a href="#' + c.key + '">See all ' + list.length + ' →</a></div>' +
        '<div class="shelf">' + cards(list.slice(0, 14)) + '</div>';
    });
    view.innerHTML = html;
  }

  var catState = {};
  function renderCategory(key) {
    var c = CATEGORIES.filter(function (x) { return x.key === key; })[0];
    var st = catState[key] = catState[key] || { subject: 'All', sort: 'default' };
    var all = BOOKS.filter(function (b) { return b.cat === key; });
    var subjects = [];
    all.forEach(function (b) { if (b.subject && subjects.indexOf(b.subject) < 0) subjects.push(b.subject); });

    var html = head(c.emoji, key, c.label, c.blurb);
    if (key === 'reference') html += wikiHTML() + '<div class="section-head"><h2>Encyclopedias & dictionaries in the library</h2></div>';

    var list = all.filter(function (b) { return st.subject === 'All' || b.subject === st.subject; });
    if (st.sort === 'title') list.sort(sortTitle);
    if (st.sort === 'author') list.sort(function (a, b) { return a.author.split(' ').pop().localeCompare(b.author.split(' ').pop()); });

    html += '<div class="controls">';
    if (subjects.length) {
      html += ['All'].concat(subjects).map(function (s) {
        return '<button class="chip" data-subject="' + esc(s) + '" aria-pressed="' + (st.subject === s) + '">' + esc(s) + '</button>';
      }).join('');
    }
    html += '<select id="sortSel" aria-label="Sort books"><option value="default">Recommended order</option><option value="title">Title A–Z</option><option value="author">Author A–Z</option></select></div>';
    html += '<div class="grid">' + cards(list) + '</div>';
    if (key === 'textbooks') html += '<p style="color:var(--muted);margin-top:24px">Looking for modern textbooks? <a href="#online">OpenStax and other free sites are in More Online →</a></p>';
    view.innerHTML = html;

    $('#sortSel').value = st.sort;
    $('#sortSel').addEventListener('change', function () { st.sort = this.value; renderCategory(key); });
    view.querySelectorAll('[data-subject]').forEach(function (b) {
      b.addEventListener('click', function () { st.subject = b.getAttribute('data-subject'); renderCategory(key); });
    });
    if (key === 'reference') bindWiki();
  }

  function renderSearch(q) {
    $('#searchInput').value = q;
    var list = searchBooks(q);
    view.innerHTML = head('🔎', 'home', 'Search: “' + q + '”', list.length + ' book' + (list.length === 1 ? '' : 's') + ' found.') +
      (list.length ? '<div class="grid">' + cards(list) + '</div>' :
        '<div class="empty">No books matched. Try another word, or <a href="#reference" data-wikiq="' + esc(q) + '">look it up in the Encyclopedia</a>.</div>');
    var w = view.querySelector('[data-wikiq]');
    if (w) w.addEventListener('click', function () { pendingWiki = q; });
  }

  function renderShelf() {
    var reading = Object.keys(store.progress).map(function (id) { return { b: byId[id], p: store.progress[id] }; })
      .filter(function (x) { return x.b; }).sort(function (a, b) { return b.p.ts - a.p.ts; }).map(function (x) { return x.b; });
    var favs = store.favs.map(function (id) { return byId[id]; }).filter(Boolean);
    view.innerHTML = head('❤️', 'shelf', 'My Shelf', 'Books you have opened and books you saved with ♡. This is kept on this device only.') +
      '<div class="section-head"><h2>Saved books</h2></div>' +
      (favs.length ? '<div class="grid">' + cards(favs) + '</div>' : '<div class="empty">Tap ♡ on any book to save it here.</div>') +
      '<div class="section-head"><h2>Recently read</h2></div>' +
      (reading.length ? '<div class="grid">' + cards(reading) + '</div>' : '<div class="empty">Books you open will appear here, with your reading progress.</div>');
  }

  function renderOnline() {
    view.innerHTML = head('🌐', 'online', 'More free books online', 'These free websites have many more books. They need an internet connection and open in a new tab.') +
      '<div class="links">' + ONLINE.map(function (o) {
        return '<a class="link-card" href="' + o.url + '" target="_blank" rel="noopener"><b>' + esc(o.name) + '</b><span>' + esc(o.text) + '</span><br><em>' + esc(o.tag) + '</em></a>';
      }).join('') + '</div>';
  }

  // ---- Encyclopedia (Wikipedia) ---------------------------------------------
  var wikiLang = store.wikiLang || 'simple';
  var pendingWiki = null;
  function wikiHTML() {
    return '<section class="wiki-box"><form class="wiki-form" id="wikiForm"><input id="wikiQ" type="search" placeholder="Look up anything: planets, countries, animals, people…" aria-label="Encyclopedia search"><button class="btn">Search</button></form>' +
      '<div class="wiki-lang">Language: ' +
      '<button class="chip" data-lang="simple" aria-pressed="' + (wikiLang === 'simple') + '">Simple English</button>' +
      '<button class="chip" data-lang="en" aria-pressed="' + (wikiLang === 'en') + '">Full English</button>' +
      '<span>· needs internet</span></div>' +
      '<div class="topics">' + WIKI_TOPICS.map(function (t) { return '<button class="chip" data-topic="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') + '</div>' +
      '<ul class="results" id="wikiResults"></ul></section>';
  }
  function bindWiki() {
    $('#wikiForm').addEventListener('submit', function (e) { e.preventDefault(); wikiSearch($('#wikiQ').value.trim()); });
    view.querySelectorAll('[data-lang]').forEach(function (b) {
      b.addEventListener('click', function () {
        wikiLang = store.wikiLang = b.getAttribute('data-lang'); save();
        view.querySelectorAll('[data-lang]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
        if ($('#wikiQ').value.trim()) wikiSearch($('#wikiQ').value.trim());
      });
    });
    view.querySelectorAll('[data-topic]').forEach(function (b) {
      b.addEventListener('click', function () { $('#wikiQ').value = b.getAttribute('data-topic'); wikiSearch(b.getAttribute('data-topic')); });
    });
    if (pendingWiki) { $('#wikiQ').value = pendingWiki; wikiSearch(pendingWiki); pendingWiki = null; }
  }
  function wikiApi(params) {
    var url = 'https://' + wikiLang + '.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*&' + params;
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function wikiSearch(q) {
    var out = $('#wikiResults');
    if (!q || !out) return;
    out.innerHTML = '<li class="empty">Searching…</li>';
    wikiApi('action=query&list=search&srlimit=12&srsearch=' + encodeURIComponent(q)).then(function (d) {
      var hits = (d.query && d.query.search) || [];
      if (!hits.length) { out.innerHTML = '<li class="empty">Nothing found for “' + esc(q) + '”. Try a different word.</li>'; return; }
      out.innerHTML = hits.map(function (h) {
        var snip = h.snippet.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'");
        return '<li><button data-article="' + esc(h.title) + '"><b>' + esc(h.title) + '</b><span>' + esc(snip) + '…</span></button></li>';
      }).join('');
      out.querySelectorAll('[data-article]').forEach(function (b) {
        b.addEventListener('click', function () { openArticle(b.getAttribute('data-article')); });
      });
    }).catch(function () {
      out.innerHTML = '<li class="empty">The encyclopedia needs an internet connection. Please check the connection and try again — or open one of the encyclopedia books below, which work offline.</li>';
    });
  }

  function sanitizeWiki(html) {
    var doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    doc.querySelectorAll('script,style,link,meta,iframe,object,embed,form,input,button,.mw-editsection,.navbox,.vertical-navbox,.metadata,.ambox,.hatnote,.reflist,.references,.mw-references-wrap,sup.reference,.noprint,.sistersitebox').forEach(function (n) { n.remove(); });
    doc.querySelectorAll('*').forEach(function (el) {
      for (var i = el.attributes.length - 1; i >= 0; i--) {
        var a = el.attributes[i].name;
        if (/^on/i.test(a) || a === 'style' && el.tagName !== 'IMG') el.removeAttribute(a);
      }
      if (el.tagName === 'IMG') {
        ['src', 'srcset'].forEach(function (k) { var v = el.getAttribute(k); if (v) el.setAttribute(k, v.replace(/(^|\s)\/\//g, '$1https://')); });
        el.removeAttribute('style'); el.setAttribute('loading', 'lazy');
      }
      if (el.tagName === 'A') {
        var href = el.getAttribute('href') || '';
        var m = href.match(/^\/wiki\/([^#?]+)/);
        if (m && !/^(File|Special|Help|Category|Template|Wikipedia|Portal|Talk):/i.test(decodeURIComponent(m[1]))) {
          el.setAttribute('href', '#'); el.setAttribute('data-wiki', decodeURIComponent(m[1]).replace(/_/g, ' '));
        } else if (/^https?:\/\//.test(href)) {
          el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener');
        } else if (href.charAt(0) !== '#') {
          el.replaceWith.apply(el, Array.prototype.slice.call(el.childNodes));
        }
      }
    });
    return doc.body.firstChild;
  }

  function openArticle(title) {
    openReaderShell(title, (wikiLang === 'simple' ? 'Simple English ' : '') + 'Wikipedia', null);
    var art = $('#wikiArticle');
    art.hidden = false; $('#rFrame').hidden = true;
    art.innerHTML = '<div><p>Loading…</p></div>';
    art.scrollTop = 0;
    wikiApi('action=parse&prop=text&redirects=1&disableeditsection=1&page=' + encodeURIComponent(title)).then(function (d) {
      if (!d.parse) throw new Error('missing');
      var wrap = document.createElement('div');
      wrap.innerHTML = '<h1>' + esc(d.parse.title) + '</h1>';
      wrap.appendChild(sanitizeWiki(d.parse.text));
      var credit = document.createElement('p');
      credit.className = 'wiki-credit';
      credit.innerHTML = 'From Wikipedia, the free encyclopedia. Text available under the Creative Commons Attribution-ShareAlike License. ' +
        '<a target="_blank" rel="noopener" href="https://' + wikiLang + '.wikipedia.org/wiki/' + encodeURIComponent(d.parse.title.replace(/ /g, '_')) + '">View original</a>';
      wrap.appendChild(credit);
      art.innerHTML = ''; art.appendChild(wrap);
      $('#rTitle').textContent = d.parse.title;
      wrap.querySelectorAll('[data-wiki]').forEach(function (a) {
        a.addEventListener('click', function (e) { e.preventDefault(); openArticle(a.getAttribute('data-wiki')); });
      });
      applyWikiFont();
    }).catch(function () {
      art.innerHTML = '<div><p>Could not load this article. Please check the internet connection.</p></div>';
    });
  }
  function applyWikiFont() { $('#wikiArticle').style.setProperty('--wfs', store.fontSize + 'px'); }

  // ---- Reader ------------------------------------------------------------------
  var reader = $('#reader'), frame = $('#rFrame'), current = null, lastFocus = null, pushed = false, savedScroll = 0, restoreScroll = null;
  var PAGES = ['light', 'sepia', 'dark'];

  function openReaderShell(title, author, book) {
    if (reader.hidden) { lastFocus = document.activeElement; savedScroll = window.scrollY; }
    current = book;
    $('#rTitle').textContent = title;
    $('#rAuthor').textContent = author;
    $('#rProgress').style.width = book && store.progress[book.id] ? (store.progress[book.id].frac * 100) + '%' : '0';
    $('#rFav').hidden = !book;
    $('#rTheme').hidden = !book;
    updateFavBtn();
    reader.hidden = false;
    document.body.classList.add('noscroll');
    $('#rClose').focus();
  }

  function openBook(id) {
    var b = byId[id];
    if (!b) return;
    openReaderShell(b.title, b.author, b);
    $('#wikiArticle').hidden = true;
    frame.hidden = false;
    frame.src = 'books/' + b.id + '/index.html';
    if (location.hash !== '#read/' + id) { history.pushState(null, '', '#read/' + id); pushed = true; }
  }

  function closeReader(fromHistory) {
    if (reader.hidden) return;
    reader.hidden = true;
    frame.src = 'about:blank';
    document.body.classList.remove('noscroll');
    current = null;
    restoreScroll = savedScroll;
    if (!fromHistory && location.hash.indexOf('#read/') === 0) {
      if (pushed) { pushed = false; history.back(); return; }
      history.replaceState(null, '', '#' + lastPage);
    }
    route(true);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }

  function sendSettings(restore) {
    if (!current || !frame.contentWindow) return;
    var msg = { elib: 'settings', fontSize: store.fontSize, page: store.page };
    if (restore) msg.restore = store.progress[current.id] ? store.progress[current.id].frac : 0;
    frame.contentWindow.postMessage(msg, '*');
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !current || e.source !== frame.contentWindow) return;
    if (d.elib === 'ready') sendSettings(true);
    if (d.elib === 'close') closeReader(false);
    if (d.elib === 'progress' && typeof d.frac === 'number') {
      store.progress[current.id] = { frac: Math.max(0, Math.min(1, d.frac)), ts: Date.now() };
      $('#rProgress').style.width = (d.frac * 100) + '%';
      save();
    }
  });

  $('#rClose').addEventListener('click', function () { closeReader(false); });
  $('#rBigger').addEventListener('click', function () { store.fontSize = Math.min(32, store.fontSize + 2); save(); sendSettings(); applyWikiFont(); });
  $('#rSmaller').addEventListener('click', function () { store.fontSize = Math.max(13, store.fontSize - 2); save(); sendSettings(); applyWikiFont(); });
  $('#rTheme').addEventListener('click', function () {
    store.page = PAGES[(PAGES.indexOf(store.page) + 1) % PAGES.length]; save(); sendSettings();
  });
  $('#rFav').addEventListener('click', function () { if (current) toggleFav(current.id); updateFavBtn(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !reader.hidden) closeReader(false); });

  function updateFavBtn() {
    var on = current && store.favs.indexOf(current.id) >= 0;
    $('#rFav').textContent = on ? '♥' : '♡';
    $('#rFav').title = on ? 'Remove from My Shelf' : 'Add to My Shelf';
  }
  function toggleFav(id) {
    var i = store.favs.indexOf(id);
    if (i >= 0) store.favs.splice(i, 1); else store.favs.unshift(id);
    save();
  }

  // Clicks on cards (delegated)
  view.addEventListener('click', function (e) {
    var f = e.target.closest('[data-fav]');
    if (f) {
      var id = +f.getAttribute('data-fav');
      toggleFav(id);
      var on = store.favs.indexOf(id) >= 0;
      view.querySelectorAll('[data-fav="' + id + '"]').forEach(function (x) {
        x.setAttribute('aria-pressed', on); x.textContent = on ? '♥' : '♡';
        x.title = x.ariaLabel = on ? 'Remove from My Shelf' : 'Add to My Shelf';
      });
      return;
    }
    var o = e.target.closest('[data-open]');
    if (o) openBook(+o.getAttribute('data-open'));
  });

  // ---- Router ------------------------------------------------------------------
  var lastPage = 'home';
  function route(keepScroll) {
    var h = decodeURIComponent(location.hash.slice(1)) || 'home';
    if (h.indexOf('read/') === 0) {
      var id = +h.slice(5);
      if (reader.hidden || !current || current.id !== id) { renderPage(lastPage); openBook(id); }
      return;
    }
    if (!reader.hidden) { closeReader(true); return; }
    renderPage(h);
    lastPage = h;
    if (restoreScroll != null) { window.scrollTo(0, restoreScroll); restoreScroll = null; }
    else if (!keepScroll) window.scrollTo(0, 0);
  }
  function renderPage(h) {
    var tabKey = h.indexOf('search/') === 0 ? '' : h;
    document.querySelectorAll('.tab').forEach(function (t) {
      if (t.getAttribute('data-tab') === tabKey) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (h.indexOf('search/') === 0) return renderSearch(h.slice(7));
    if (h !== 'home' && $('#searchInput').value && document.activeElement !== $('#searchInput')) $('#searchInput').value = '';
    if (h === 'shelf') return renderShelf();
    if (h === 'online') return renderOnline();
    if (CATEGORIES.some(function (c) { return c.key === h; })) return renderCategory(h);
    renderHome();
  }
  window.addEventListener('hashchange', function () { route(); });
  route();
})();
