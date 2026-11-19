/* Runs inside each book page: receives reading settings from the library and reports reading progress. */
(function () {
  'use strict';
  var root = document.documentElement;
  var parentWin = window.parent !== window ? window.parent : null;
  var restoring = false, lastRestore = null, userMoved = false;

  function apply(d) {
    if (d.fontSize) root.style.setProperty('--book-fs', d.fontSize + 'px');
    if (d.page) root.setAttribute('data-page', d.page);
  }

  function maxScroll() { return Math.max(1, document.documentElement.scrollHeight - window.innerHeight); }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.elib !== 'settings') return;
    // Keep the reader at the same place in the book when the text size changes.
    var frac = window.scrollY / maxScroll();
    apply(d);
    if (typeof d.restore === 'number') lastRestore = d.restore;
    var target = typeof d.restore === 'number' ? d.restore : frac;
    restoring = true;
    setTimeout(function () {
      window.scrollTo(0, target * maxScroll());
      setTimeout(function () { restoring = false; }, 200);
    }, 0);
  });

  var t;
  window.addEventListener('scroll', function () {
    if (restoring || !parentWin) return;
    userMoved = true;
    clearTimeout(t);
    t = setTimeout(function () {
      parentWin.postMessage({ elib: 'progress', frac: window.scrollY / maxScroll() }, '*');
    }, 300);
  }, { passive: true });

  // Pressing Escape inside the book also closes it.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && parentWin) parentWin.postMessage({ elib: 'close' }, '*');
  });

  // Links to other parts of the same book stay inside; links to the web open in a new tab.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (a && /^https?:/i.test(a.getAttribute('href'))) a.setAttribute('target', '_blank');
  });

  function ready() { if (parentWin) parentWin.postMessage({ elib: 'ready' }, '*'); }
  if (document.readyState !== 'loading') ready(); else document.addEventListener('DOMContentLoaded', ready);
  // Pictures change the page height as they load, so return to the saved place once everything is in.
  window.addEventListener('load', function () {
    if (lastRestore && !userMoved) { restoring = true; window.scrollTo(0, lastRestore * maxScroll()); setTimeout(function () { restoring = false; }, 200); }
  });
})();
