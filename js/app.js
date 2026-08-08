import { isMarkdownName, readNode } from './fs.js';
import { renderMarkdownInto, buildToc } from './render.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  sidebar: $('#sidebar'),
  welcome: $('#welcome'),
  content: $('#content'),
  outline: $('#outline'),
  toc: $('#toc'),
  fileName: $('#current-file-name'),
  toastRoot: $('#toast-root'),
  dropVeil: $('#drop-veil'),
  fileInput: $('#file-fallback-input'),
};

// Storage keys keep their original 'folio-' names (the app's former name)
// so existing users' preferences survive the rename to Mull Reader.
const THEME_KEY = 'folio-theme';
const SIDEBAR_KEY = 'folio-sidebar';
const READER_KEY = 'folio-reader';
const EINK_KEY = 'folio-eink';
const TEXT_SIZE_KEY = 'folio-text-size';
const DIM_KEY = 'folio-brightness';
const SIDEBAR_W_KEY = 'folio-sidebar-w';

const PROSE_SIZES = [14.5, 16, 17.5, 19, 21, 23.5, 26, 29, 32];
const DEFAULT_SIZE_INDEX = 2;

// Software brightness: opacity of the black veil over the page, 0 = full brightness.
const DIM_LEVELS = [0, 0.12, 0.24, 0.36, 0.48, 0.6];

// Color temperature: multiply-blended tint from cold (blue) through neutral to
// warm (amber = blue-light filter) and on into red for night reading.
const TONE_KEY = 'folio-tone';
const TONE_LEVELS = [
  { c: '#8ab4ff', o: 0.39 },   // coldest
  { c: '#8ab4ff', o: 0.26 },
  { c: '#8ab4ff', o: 0.13 },
  { c: 'transparent', o: 0 },  // neutral
  { c: '#ffb45e', o: 0.18 },   // gentle warmth
  { c: '#ff9632', o: 0.3 },    // blue-light filter
  { c: '#ff9632', o: 0.45 },
  { c: '#ff5a1f', o: 0.5 },    // red-light
  { c: '#ff2d00', o: 0.6 },    // deepest night mode
];
const TONE_NEUTRAL_INDEX = 3;

let current = null;       // { node, name, lastModified }

// ---------- Toasts ----------

let activeToast = null;

function toast(message) {
  // Rate limit: while a toast with this exact message is showing (e.g. from
  // repeated taps on the topbar file name), don't stack another one.
  if (activeToast?.isConnected && activeToast.textContent === message) return;
  const el = document.createElement('div');
  activeToast = el;
  el.className = 'toast';
  el.textContent = message;
  els.toastRoot.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ---------- Theme ----------

function effectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const eink = document.documentElement.hasAttribute('data-eink');
  const bg = eink ? '#ffffff' : effectiveTheme() === 'dark' ? '#1c1b1a' : '#faf9f7';
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', bg);
  }
}

function toggleTheme() {
  // The e-ink palette wins over both themes, so switching while it's on
  // would change nothing visible. Leave e-ink so the switch always shows.
  if (document.documentElement.hasAttribute('data-eink')) {
    localStorage.setItem(EINK_KEY, 'off');
    applyEink();
    toast('E-ink mode off');
  }
  localStorage.setItem(THEME_KEY, effectiveTheme() === 'dark' ? 'light' : 'dark');
  applyTheme();
}

// ---------- E-ink mode ----------

function applyEink() {
  const on = localStorage.getItem(EINK_KEY) === 'on';
  document.documentElement.toggleAttribute('data-eink', on);
  $('#eink-toggle').setAttribute('aria-pressed', String(on));
  applyTheme();
  updateProgress();
}

function toggleEink() {
  const on = localStorage.getItem(EINK_KEY) !== 'on';
  localStorage.setItem(EINK_KEY, on ? 'on' : 'off');
  applyEink();
  // In the light theme the e-ink palette is a near-invisible change on a
  // normal screen, so say out loud that the toggle took effect.
  toast(on ? 'E-ink mode on' : 'E-ink mode off');
}

// ---------- Text size ----------

function textSizeIndex() {
  const stored = parseInt(localStorage.getItem(TEXT_SIZE_KEY), 10);
  if (!Number.isInteger(stored)) return DEFAULT_SIZE_INDEX;
  return Math.min(Math.max(stored, 0), PROSE_SIZES.length - 1);
}

function applyTextSize() {
  const idx = textSizeIndex();
  document.documentElement.style.setProperty('--prose-size', `${PROSE_SIZES[idx]}px`);
  $('#font-dec').disabled = idx === 0;
  $('#font-inc').disabled = idx === PROSE_SIZES.length - 1;
}

function stepTextSize(delta) {
  localStorage.setItem(TEXT_SIZE_KEY, String(textSizeIndex() + delta));
  applyTextSize();
}

// ---------- Brightness (software dimmer) ----------

function dimIndex() {
  const stored = parseInt(localStorage.getItem(DIM_KEY), 10);
  if (!Number.isInteger(stored)) return 0;
  return Math.min(Math.max(stored, 0), DIM_LEVELS.length - 1);
}

function applyDim() {
  const idx = dimIndex();
  document.documentElement.style.setProperty('--dim', String(DIM_LEVELS[idx]));
  $('#dim-inc').disabled = idx === 0;
  $('#dim-dec').disabled = idx === DIM_LEVELS.length - 1;
}

// delta is in brightness terms: +1 brighter (less veil), -1 dimmer (more veil).
function stepDim(delta) {
  localStorage.setItem(DIM_KEY, String(dimIndex() - delta));
  applyDim();
}

// ---------- Color temperature (blue-light / red-light filter) ----------

function toneIndex() {
  const stored = parseInt(localStorage.getItem(TONE_KEY), 10);
  if (!Number.isInteger(stored)) return TONE_NEUTRAL_INDEX;
  return Math.min(Math.max(stored, 0), TONE_LEVELS.length - 1);
}

function applyTone() {
  const idx = toneIndex();
  const { c, o } = TONE_LEVELS[idx];
  document.documentElement.style.setProperty('--tone-color', c);
  document.documentElement.style.setProperty('--tone-opacity', String(o));
  $('#tone-dec').disabled = idx === 0;
  $('#tone-inc').disabled = idx === TONE_LEVELS.length - 1;
}

function stepTone(delta) {
  localStorage.setItem(TONE_KEY, String(toneIndex() + delta));
  applyTone();
}

// Back to the defaults for everything the steppers control.
function resetAppearance() {
  localStorage.removeItem(TEXT_SIZE_KEY);
  localStorage.removeItem(DIM_KEY);
  localStorage.removeItem(TONE_KEY);
  applyTextSize();
  applyDim();
  applyTone();
}

// ---------- Sidebar ----------

const isPhone = () => matchMedia('(max-width: 720px)').matches;

function applySidebarState() {
  // Closed is the default — reading comes first, and the sidebar is one ⌘B away.
  // On phones it's a fixed overlay that would cover the page, so it always
  // starts closed there regardless of the stored preference.
  const collapsed = isPhone() || localStorage.getItem(SIDEBAR_KEY) !== 'open';
  document.body.classList.toggle('sidebar-collapsed', collapsed);
}

function toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  // Phone toggles are transient overlay show/hides — don't let them
  // overwrite the desktop preference.
  if (!isPhone()) localStorage.setItem(SIDEBAR_KEY, collapsed ? 'closed' : 'open');
}

// ---------- Sidebar resizing ----------

const SIDEBAR_W_DEFAULT = 272;   // matches --sidebar-w in styles.css
const SIDEBAR_W_MIN = 170;
const SIDEBAR_W_MAX = 560;
const SIDEBAR_KEY_STEP = 16;     // arrow-key nudge

// Never let the sidebar squeeze the page below a readable column.
function clampSidebarWidth(px) {
  const max = Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, window.innerWidth - 320));
  return Math.round(Math.min(Math.max(px, SIDEBAR_W_MIN), max));
}

function storedSidebarWidth() {
  const stored = parseInt(localStorage.getItem(SIDEBAR_W_KEY), 10);
  return Number.isFinite(stored) ? stored : SIDEBAR_W_DEFAULT;
}

// `persist` is false while dragging (we only write on release) and when a
// narrow window forces a temporary clamp, which shouldn't lose the preference.
function setSidebarWidth(px, persist) {
  const w = clampSidebarWidth(px);
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  const handle = $('#sidebar-resizer');
  handle.setAttribute('aria-valuenow', String(w));
  handle.setAttribute('aria-valuemin', String(SIDEBAR_W_MIN));
  handle.setAttribute('aria-valuemax', String(clampSidebarWidth(SIDEBAR_W_MAX)));
  if (persist) localStorage.setItem(SIDEBAR_W_KEY, String(w));
  return w;
}

function applySidebarWidth() {
  setSidebarWidth(storedSidebarWidth(), false);
}

function resetSidebarWidth() {
  localStorage.removeItem(SIDEBAR_W_KEY);
  setSidebarWidth(SIDEBAR_W_DEFAULT, false);
}

function setupSidebarResizer() {
  const handle = $('#sidebar-resizer');
  let startX = 0;
  let startW = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = els.sidebar.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('sidebar-resizing');
  });

  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    setSidebarWidth(startW + (e.clientX - startX), false);
  });

  const endDrag = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove('sidebar-resizing');
    setSidebarWidth(els.sidebar.getBoundingClientRect().width, true);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  handle.addEventListener('dblclick', resetSidebarWidth);

  handle.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -SIDEBAR_KEY_STEP : e.key === 'ArrowRight' ? SIDEBAR_KEY_STEP : 0;
    if (step) {
      setSidebarWidth(els.sidebar.getBoundingClientRect().width + step, true);
    } else if (e.key === 'Home') {
      resetSidebarWidth();
    } else {
      return;
    }
    e.preventDefault();
  });
}

// ---------- Reader mode ----------

function applyReaderState() {
  const on = localStorage.getItem(READER_KEY) === 'on';
  document.body.classList.toggle('reader-mode', on);
  if (on) document.body.classList.add('reader-bar-show');
  $('#reader-toggle').setAttribute('aria-pressed', String(on));
  updateProgress();
}

function toggleReader() {
  localStorage.setItem(READER_KEY, localStorage.getItem(READER_KEY) === 'on' ? 'off' : 'on');
  applyReaderState();
}

// On touch screens the reader-mode topbar can't be revealed by hover, so it
// follows scroll: hidden while reading down, back when scrolling up or at the top.
function setupTouchReaderBar() {
  if (!matchMedia('(hover: none)').matches) return;
  let lastY = window.scrollY;
  document.body.classList.add('reader-bar-show');
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y < 8 || y < lastY - 4) document.body.classList.add('reader-bar-show');
    else if (y > lastY + 4) document.body.classList.remove('reader-bar-show');
    lastY = y;
  }, { passive: true });
}

// ---------- Kindle-style reading aids ----------

const readingAidsActive = () =>
  document.documentElement.hasAttribute('data-eink') || document.body.classList.contains('reader-mode');

function updateProgress() {
  const el = $('#progress');
  const active = !els.content.hidden && readingAidsActive();
  el.hidden = !active;
  if (!active) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  el.textContent = `${max > 0 ? Math.min(100, Math.max(0, Math.round((window.scrollY / max) * 100))) : 100}%`;
}

// ---------- Welcome / empty states ----------

function showWelcome() {
  els.content.hidden = true;
  els.outline.hidden = true;
  els.welcome.hidden = false;
  els.fileName.textContent = '';
  els.fileName.removeAttribute('title');
  updateProgress();
  document.title = 'Mull Reader - Markdown Reader';
  const inner = els.welcome.querySelector('.welcome-inner');
  inner.querySelector('.welcome-sub').innerHTML = 'A lightweight, open-source markdown reader to consume knowledge created by AI agents. Mobile friendly, and all documents remain local, always. A progressive web app: install it and it works offline.';
  const cta = inner.querySelector('.cta');
  cta.textContent = 'Open a file';
  cta.onclick = openFile;
}

// ---------- Opening files ----------

async function openNode(node, { keepScroll = false } = {}) {
  let file, text;
  try {
    ({ file, text } = await readNode(node));
  } catch {
    toast(`Couldn't read “${node.name}”`);
    return;
  }
  current = { node, name: file.name, lastModified: file.lastModified };

  const scrollY = keepScroll ? window.scrollY : 0;
  els.welcome.hidden = true;
  els.content.hidden = false;
  const headings = renderMarkdownInto(els.content, text);
  buildToc(els.toc, els.outline, headings);
  window.scrollTo(0, scrollY);

  els.fileName.textContent = file.name;
  els.fileName.title = node.path || file.name;
  document.title = `${file.name} - Mull Reader`;
  updateProgress();

  // On phones the sidebar is a fixed overlay — tuck it away once a file is picked.
  if (isPhone() && !document.body.classList.contains('sidebar-collapsed')) {
    toggleSidebar();
  }
}

// A single file from drop / file-handler / fallback input.
async function openSingleFile(fileOrHandle) {
  const node = fileOrHandle instanceof File
    ? { name: fileOrHandle.name, path: '', kind: 'file', file: fileOrHandle }
    : { name: fileOrHandle.name, path: '', kind: 'file', handle: fileOrHandle };
  if (!isMarkdownName(node.name)) {
    toast('That doesn’t look like a markdown file.');
    return;
  }
  await openNode(node);
}

async function openFile() {
  if (!('showOpenFilePicker' in window)) {
    els.fileInput.click();
    return;
  }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
    });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Couldn’t open that file.');
    return;
  }
  await openSingleFile(handle);
}

// ---------- External-edit refresh ----------

async function refreshCurrent() {
  if (!current?.node?.handle) return;
  try {
    const file = await current.node.handle.getFile();
    if (file.lastModified === current.lastModified) return;
    await openNode(current.node, { keepScroll: true });
  } catch { /* file may have been deleted or permission revoked */ }
}

// ---------- Drag and drop ----------

let dragDepth = 0;

function setupDragDrop() {
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    els.dropVeil.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; els.dropVeil.hidden = true; }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropVeil.hidden = true;
    const item = [...(e.dataTransfer?.items || [])].find((i) => i.kind === 'file');
    if (!item) return;
    // getAsFile() must be called synchronously, before any await invalidates the DataTransfer.
    const file = item.getAsFile();
    if (item.getAsFileSystemHandle) {
      try {
        const handle = await item.getAsFileSystemHandle();
        if (handle?.kind === 'directory') {
          toast('Drop a single markdown file.');
          return;
        }
        if (handle?.kind === 'file') {
          await openSingleFile(handle);
          return;
        }
      } catch { /* fall through to the plain File */ }
    }
    if (file) await openSingleFile(file);
  });
}

// ---------- PWA: service worker + file handler ----------

function setupPwa() {
  if ('serviceWorker' in navigator) {
    // When an updated service worker takes over (skipWaiting + claim), reload
    // once so the page picks up the freshly cached assets instead of needing
    // a second manual refresh. Skipped on first-ever install (no previous
    // controller) so the initial visit doesn't flash.
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline still works next time */ });
    // The repo was renamed (mull, Mull-Reader) and GitHub Pages serves the
    // path case-insensitively, so workers registered under old scopes can
    // linger and keep installs pointing at a wrong URL. Unregister any scope
    // that is a casing variant of ours, or the legacy /mull/ scope — but
    // nothing else, since other project sites share this origin.
    if (navigator.serviceWorker.getRegistrations) {
      const scope = new URL('./', location.href).href;
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) {
          const s = reg.scope;
          const stale = (s !== scope && s.toLowerCase() === scope.toLowerCase()) ||
                        s === 'https://ramanvir.github.io/mull/' ||
                        s === 'https://ramanvir.github.io/folio/';
          if (stale) reg.unregister();
        }
      }).catch(() => { /* best effort */ });
    }
  }
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      try {
        await openSingleFile(params.files[0]);
      } catch {
        toast('Couldn’t open the launched file.');
      }
    });
  }
}

// ---------- Wire-up ----------

function init() {
  applyEink();
  applySidebarState();
  applyReaderState();
  applyTextSize();
  applyDim();
  applyTone();
  applySidebarWidth();
  setupSidebarResizer();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  matchMedia('(max-width: 720px)').addEventListener('change', applySidebarState);

  const menu = $('#app-menu');
  const menuToggle = $('#menu-toggle');
  const setMenu = (open) => {
    menu.hidden = !open;
    menuToggle.setAttribute('aria-expanded', String(open));
  };
  menuToggle.addEventListener('click', () => setMenu(menu.hidden));
  menu.addEventListener('click', (e) => {
    // The size steppers stay open for repeated taps; any other choice closes the menu.
    if (e.target.closest('button, a') && !e.target.closest('#font-dec, #font-inc, #dim-dec, #dim-inc, #tone-dec, #tone-inc, #appearance-reset')) setMenu(false);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('.menu-wrap')) setMenu(false);
  });

  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#eink-toggle').addEventListener('click', toggleEink);
  $('#reader-toggle').addEventListener('click', toggleReader);
  $('#sidebar-toggle').addEventListener('click', toggleSidebar);
  // Tapping a contents link should tuck the phone overlay away so the reader
  // lands on the section, not behind the panel.
  els.toc.addEventListener('click', (e) => {
    if (e.target.closest('a') && isPhone() && !document.body.classList.contains('sidebar-collapsed')) {
      toggleSidebar();
    }
  });
  // Tapping anywhere outside the open overlay closes it. Only applies
  // at widths where the panel floats over the page, never to the column.
  document.addEventListener('click', (e) => {
    if (isPhone() && !document.body.classList.contains('sidebar-collapsed')
        && !e.target.closest('#sidebar, #sidebar-toggle')) {
      toggleSidebar();
    }
  });
  $('#font-dec').addEventListener('click', () => stepTextSize(-1));
  $('#font-inc').addEventListener('click', () => stepTextSize(1));
  $('#dim-dec').addEventListener('click', () => stepDim(-1));
  $('#dim-inc').addEventListener('click', () => stepDim(1));
  $('#tone-dec').addEventListener('click', () => stepTone(-1));
  $('#tone-inc').addEventListener('click', () => stepTone(1));
  $('#appearance-reset').addEventListener('click', resetAppearance);
  $('#open-file-btn').addEventListener('click', openFile);
  // The topbar file name can truncate on narrow screens — tapping it shows
  // the full name (with its folder path when one is open) as a toast.
  els.fileName.addEventListener('click', () => {
    if (els.fileName.textContent) toast(current?.node?.path || els.fileName.textContent);
  });
  // The welcome CTA's label and action are owned by showWelcome() per mode,
  // so it gets no static listener here.
  $('#welcome-open-file-btn').onclick = openFile;

  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files?.[0]) openSingleFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setMenu(false);
      return;
    }
    if (e.key === 'Escape' && document.body.classList.contains('reader-mode')) {
      toggleReader();
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'o') { e.preventDefault(); openFile(); }
    else if (key === 'b') { e.preventDefault(); toggleSidebar(); }
  });

  window.addEventListener('focus', refreshCurrent);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCurrent();
  });

  window.addEventListener('scroll', () => requestAnimationFrame(updateProgress), { passive: true });
  window.addEventListener('resize', () => {
    updateProgress();
    // A shrinking window can push the stored width past its cap; re-clamp
    // without persisting so the preference returns when there's room again.
    applySidebarWidth();
  });

  setupDragDrop();
  setupTouchReaderBar();
  setupPwa();
  showWelcome();
}

init();
