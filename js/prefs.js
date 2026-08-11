// Applies the reader's saved appearance to the static pages (about, privacy,
// terms) so they match the app instead of flashing default styling. The reader
// itself owns these keys in js/app.js; this is a read-only mirror of them.
// Loaded synchronously in <head> — it must run before first paint.

(function () {
  try {
    const root = document.documentElement;
    const theme = localStorage.getItem('folio-theme');
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    if (localStorage.getItem('folio-eink') === 'on') root.setAttribute('data-eink', '');
    if (localStorage.getItem('folio-compact') === 'on') root.setAttribute('data-compact', '');

    // Mirrors PROSE_SIZES / DEFAULT_SIZE_INDEX in js/app.js.
    const sizes = [14.5, 16, 17.5, 19, 21, 23.5, 26, 29, 32];
    const stored = parseInt(localStorage.getItem('folio-text-size'), 10);
    if (Number.isInteger(stored)) {
      root.style.setProperty('--prose-size', sizes[Math.min(Math.max(stored, 0), sizes.length - 1)] + 'px');
    }
  } catch (e) { /* private mode or blocked storage — the defaults look fine */ }
})();
