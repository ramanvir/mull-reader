import {
  supportsFS, isMarkdownName,
  saveDirHandle, loadDirHandle, clearDirHandle, verifyPermission,
  buildTree, treeFromFileList, findByPath, firstFile, readNode,
  loadRecents, recordRecent, readRecentText, forgetRecent, clearRecents, MAX_RECENTS,
} from './fs.js';
import { renderMarkdownInto, buildToc } from './render.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  sidebar: $('#sidebar'),
  tree: $('#file-tree'),
  recents: $('#recents'),
  recentsList: $('#recents-list'),
  welcomeRecents: $('#welcome-recents'),
  welcomeRecentsList: $('#welcome-recents-list'),
  welcome: $('#welcome'),
  content: $('#content'),
  outline: $('#outline'),
  toc: $('#toc'),
  fileName: $('#current-file-name'),
  toastRoot: $('#toast-root'),
  dropVeil: $('#drop-veil'),
  dirInput: $('#dir-fallback-input'),
  fileInput: $('#file-fallback-input'),
  searchBar: $('#search-bar'),
  searchInput: $('#search-input'),
  searchCount: $('#search-count'),
  searchToggle: $('#search-toggle'),
  saveBtn: $('#save-btn'),
  editor: $('#editor'),
  editToggle: $('#edit-toggle'),
};

// Storage keys keep their original 'folio-' names (the app's former name)
// so existing users' preferences survive the rename to Mull Reader.
const LAST_FILE_KEY = 'folio-last-file';
const THEME_KEY = 'folio-theme';
const SIDEBAR_KEY = 'folio-sidebar';
const READER_KEY = 'folio-reader';
const EINK_KEY = 'folio-eink';
const COMPACT_KEY = 'folio-compact';
const TEXT_SIZE_KEY = 'folio-text-size';
const DIM_KEY = 'folio-brightness';
const SIDEBAR_W_KEY = 'folio-sidebar-w';
const POSITIONS_KEY = 'folio-positions';

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

let tree = null;          // current folder tree (or null)
let current = null;       // { node, name, lastModified, text }
let recents = [];         // most-recently-read documents, newest first
let docDirty = false;     // edits not yet written to the file
let writeDeclined = false; // write permission refused — stop re-asking per edit
let editing = false;      // the source editor is on screen

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

// ---------- Compact spacing ----------

function applyCompact() {
  const on = localStorage.getItem(COMPACT_KEY) === 'on';
  document.documentElement.toggleAttribute('data-compact', on);
  $('#compact-toggle').setAttribute('aria-pressed', String(on));
  // The page just got shorter or taller, so the reading percentage moved.
  updateProgress();
}

function toggleCompact() {
  localStorage.setItem(COMPACT_KEY, localStorage.getItem(COMPACT_KEY) === 'on' ? 'off' : 'on');
  applyCompact();
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

// Never let the sidebar squeeze the page below a readable column — except on
// phones, where it floats over the page rather than beside it, so there is no
// column to protect. Reserving 320px there pinned it to its minimum on every
// phone and left the stylesheet's 84vw cap unreachable.
function clampSidebarWidth(px) {
  const room = isPhone() ? SIDEBAR_W_MAX : window.innerWidth - 320;
  const max = Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, room));
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

// ---------- Reading position ----------
// Where you stopped reading each document, so reopening one puts you back
// there instead of at the top — the thing a Kindle does that a browser doesn't.
//
// Stored as a fraction of the scrollable height rather than a pixel offset:
// text size, compact spacing, and window width all change how tall a document
// is, and a fraction lands in roughly the right place through any of them.
// Identity is the same one recents uses — the path inside an open folder, or
// the document's name when there is no path (pasted text, a single file).

const MAX_POSITIONS = 100;
// Within a hair of either end isn't a place worth returning to: the top is
// where a document opens anyway, and the bottom means it was finished.
const POSITION_EDGE = 0.02;
const POSITION_DEBOUNCE = 500;

let pendingPosition = null;   // { key, fraction } captured at scroll time
let positionTimer = null;

const docKey = (node) => node.path || node.name || '';

function readPositions() {
  try {
    const map = JSON.parse(localStorage.getItem(POSITIONS_KEY));
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

function scrollFraction() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

// The key and the fraction are captured now, not at flush time: opening
// another document between the scroll and the write would otherwise file this
// position under the wrong name.
function schedulePositionSave() {
  if (!current || els.content.hidden) return;
  pendingPosition = { key: docKey(current.node), fraction: scrollFraction() };
  clearTimeout(positionTimer);
  positionTimer = setTimeout(flushPosition, POSITION_DEBOUNCE);
}

function flushPosition() {
  clearTimeout(positionTimer);
  positionTimer = null;
  const pending = pendingPosition;
  pendingPosition = null;
  if (!pending?.key) return;

  const map = readPositions();
  if (pending.fraction < POSITION_EDGE || pending.fraction > 1 - POSITION_EDGE) {
    if (!(pending.key in map)) return;
    delete map[pending.key];
  } else {
    map[pending.key] = { f: Math.round(pending.fraction * 1e4) / 1e4, ts: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > MAX_POSITIONS) {
      // Least-recently-saved entries fall off the end.
      keys.sort((a, b) => (map[b]?.ts || 0) - (map[a]?.ts || 0));
      for (const key of keys.slice(MAX_POSITIONS)) delete map[key];
    }
  }
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(map));
  } catch { /* private mode or quota — reading is unaffected */ }
}

function savedFraction(node) {
  const entry = readPositions()[docKey(node)];
  const f = entry?.f;
  return typeof f === 'number' && f > 0 && f < 1 ? f : null;
}

// An explicit #fragment — a contents link, or a shared link into a section —
// says where to go, and outranks anything remembered.
function hashTarget() {
  const id = location.hash.slice(1);
  if (!id) return null;
  try {
    return els.content.querySelector(`#${CSS.escape(decodeURIComponent(id))}`);
  } catch {
    return null;
  }
}

// ---------- Find in document ----------
// Installed on iOS the app runs without any browser chrome, so there is no
// find bar to fall back on: this is the only way to search a document there.
//
// Matches are painted with the CSS Custom Highlight API, which colours ranges
// without touching the DOM — no wrapper spans to insert, and none to unpick
// afterwards. Where it doesn't exist (older WebKit) the matches are still
// counted and scrolled to; the app never rewrites the document to fake it.

const SEARCH_DEBOUNCE = 150;
// A search across a very long document is linear work per keystroke; past this
// many hits the count stops being useful anyway.
const SEARCH_CAP = 5000;
const supportsHighlights = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';

let searchMatches = [];   // Ranges into #content, in document order
let searchAt = -1;        // index of the current match, -1 when there is none
let searchTimer = null;

const searchIsOpen = () => !els.searchBar.hidden;

function clearHighlights() {
  if (!supportsHighlights) return;
  CSS.highlights.delete('search');
  CSS.highlights.delete('search-current');
}

function paintHighlights() {
  if (!supportsHighlights) return;
  if (!searchMatches.length) {
    clearHighlights();
    return;
  }
  CSS.highlights.set('search', new Highlight(...searchMatches));
  const currentRange = searchMatches[searchAt];
  if (currentRange) {
    const one = new Highlight(currentRange);
    // Both highlights cover the current match; the current one paints on top.
    one.priority = 1;
    CSS.highlights.set('search-current', one);
  } else {
    CSS.highlights.delete('search-current');
  }
}

// Case-insensitive substring match over the rendered text, one text node at a
// time. Code blocks are included on purpose — a command or an identifier is
// exactly the kind of thing people come back to a document looking for.
// A match has to sit inside a single text node, so a phrase that straddles
// markup (**bold** in the middle of it, or two syntax-highlighted tokens)
// isn't found. Stitching text nodes together to catch those would cost a
// second index of the whole document on every keystroke, for a case nobody
// searches for.
function collectMatches(query) {
  const found = [];
  const needle = query.toLowerCase();
  if (!needle) return found;
  const walker = document.createTreeWalker(els.content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = node.nodeValue.toLowerCase();
    let from = hay.indexOf(needle);
    while (from >= 0) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      found.push(range);
      if (found.length >= SEARCH_CAP) return found;
      from = hay.indexOf(needle, from + needle.length);
    }
  }
  return found;
}

function updateSearchCount() {
  const total = searchMatches.length;
  els.searchCount.textContent = total ? `${searchAt + 1}/${total}` : '0';
  els.searchCount.classList.toggle('none', total === 0);
  els.searchCount.hidden = !els.searchInput.value;
  $('#search-prev').disabled = total === 0;
  $('#search-next').disabled = total === 0;
}

// Puts the match in the middle of the page. The range's own rectangle is used
// rather than its element's, so a hit deep inside a long paragraph still
// centres on the words themselves.
function revealMatch() {
  const range = searchMatches[searchAt];
  if (!range) return;
  const rect = range.getBoundingClientRect();
  if (rect.height || rect.width) {
    window.scrollTo(0, Math.max(0, window.scrollY + rect.top - (window.innerHeight / 2)));
  } else {
    range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }
}

function stepMatch(delta) {
  if (!searchMatches.length) return;
  searchAt = (searchAt + delta + searchMatches.length) % searchMatches.length;
  paintHighlights();
  updateSearchCount();
  revealMatch();
}

// `keepAt` holds the current match across a re-run (an external-edit refresh),
// so a document rewritten under you doesn't throw away where you were looking.
function runSearch({ keepAt = false } = {}) {
  const previous = searchAt;
  clearHighlights();
  searchMatches = els.content.hidden ? [] : collectMatches(els.searchInput.value.trim());
  if (!searchMatches.length) {
    searchAt = -1;
    updateSearchCount();
    return;
  }
  // Start from whatever is already on screen rather than from the top, so
  // typing a word finds the next one rather than sending you back to page one.
  if (keepAt && previous >= 0) {
    searchAt = Math.min(previous, searchMatches.length - 1);
  } else {
    searchAt = searchMatches.findIndex((r) => r.getBoundingClientRect().bottom > 0);
    if (searchAt < 0) searchAt = 0;
  }
  paintHighlights();
  updateSearchCount();
  revealMatch();
}

function openSearch() {
  if (els.content.hidden) return;
  els.searchBar.hidden = false;
  document.body.classList.add('search-open');
  els.searchToggle.setAttribute('aria-expanded', 'true');
  updateSearchCount();
  els.searchInput.focus();
  els.searchInput.select();
  if (els.searchInput.value.trim()) runSearch();
}

function closeSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  clearHighlights();
  searchMatches = [];
  searchAt = -1;
  els.searchInput.value = '';
  els.searchCount.textContent = '';
  els.searchBar.hidden = true;
  document.body.classList.remove('search-open');
  els.searchToggle.setAttribute('aria-expanded', 'false');
}

function setupSearch() {
  els.searchToggle.addEventListener('click', () => {
    if (searchIsOpen()) closeSearch();
    else openSearch();
  });
  $('#search-close').addEventListener('click', closeSearch);
  $('#search-prev').addEventListener('click', () => stepMatch(-1));
  $('#search-next').addEventListener('click', () => stepMatch(1));
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    // The handle is cleared as it fires, so Enter below can tell "still
    // waiting to search" from "search already ran".
    searchTimer = setTimeout(() => { searchTimer = null; runSearch(); }, SEARCH_DEBOUNCE);
  });
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Enter before the debounce has fired should search what's typed now.
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
      runSearch();
      return;
    }
    stepMatch(e.shiftKey ? -1 : 1);
  });
}

// ---------- File tree ----------

function renderTree() {
  els.tree.innerHTML = '';
  // Opening or closing a folder changes whether the recents list should be
  // expanded, so the two stay in step.
  renderRecents();
  // With no folder open the tree is hidden outright — the sidebar still has
  // the open actions and the document contents to show.
  els.tree.hidden = !tree;
  if (!tree) return;
  if (!tree.children.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'No markdown files in this folder.';
    els.tree.appendChild(empty);
    return;
  }
  const rootLabel = document.createElement('div');
  rootLabel.className = 'tree-root-name';
  rootLabel.textContent = tree.name || 'Files';
  els.tree.appendChild(rootLabel);
  els.tree.appendChild(renderChildren(tree));
  highlightCurrentInTree();
}

function renderChildren(dirNode) {
  const list = document.createElement('div');
  list.className = 'tree-children';
  for (const child of dirNode.children) {
    if (child.kind === 'dir') {
      const details = document.createElement('details');
      details.className = 'tree-dir';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = child.name;
      details.appendChild(summary);
      details.appendChild(renderChildren(child));
      list.appendChild(details);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tree-file';
      btn.textContent = child.name.replace(/\.(md|markdown)$/i, '');
      btn.dataset.path = child.path;
      btn.addEventListener('click', () => openNode(child));
      list.appendChild(btn);
    }
  }
  return list;
}

function highlightCurrentInTree() {
  const path = current?.node?.path;
  for (const btn of els.tree.querySelectorAll('.tree-file')) {
    const active = !!path && btn.dataset.path === path;
    btn.classList.toggle('active', active);
    if (active) {
      let parent = btn.parentElement;
      while (parent && parent !== els.tree) {
        if (parent.tagName === 'DETAILS') parent.open = true;
        parent = parent.parentElement;
      }
    }
  }
}

// ---------- Recent documents ----------

// Two lists, one source: the sidebar's (for while you're reading) and the
// welcome screen's (for a returning reader who has no folder open, which is
// every launch on browsers without persistent file handles).
// Tracks what the disclosure was last opened/closed *for*, so re-rendering the
// list (which happens on every document opened) doesn't keep overriding a
// reader who collapsed it by hand.
let recentsOpenFor = null;

function renderRecents() {
  const has = recents.length > 0;
  els.recents.hidden = !has;
  els.welcomeRecents.hidden = !has;
  // A folder tree is the better way around its own files, so the sidebar list
  // folds away when one opens and comes back when it closes.
  const openFor = tree ? 'tree' : 'no-tree';
  if (recentsOpenFor !== openFor) {
    recentsOpenFor = openFor;
    els.recents.open = !tree;
  }
  fillRecents(els.recentsList);
  fillRecents(els.welcomeRecentsList);
}

function fillRecents(listEl) {
  listEl.innerHTML = '';
  for (const entry of recents) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-item';
    btn.title = entry.dirName ? `${entry.dirName}/${entry.path}` : entry.path || entry.name;

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = entry.name.replace(/\.(md|markdown)$/i, '');
    btn.appendChild(name);

    // Say where it will come back from — the folder it lives in, or, for a
    // file the browser can't hand back, the copy this app kept.
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    meta.textContent = entry.dirName || (entry.handle ? 'Opened directly' : 'Saved copy');
    btn.appendChild(meta);

    btn.addEventListener('click', () => openRecent(entry));
    listEl.appendChild(btn);
  }
}

async function openRecent(entry) {
  if (entry.handle) {
    // The click is the user gesture a permission prompt needs. Files reached
    // through a folder are already covered by that folder's grant.
    if (!(await verifyPermission(entry.handle, { ask: true }))) {
      toast(`Permission denied for “${entry.name}”.`);
      return;
    }
    // A file that's been moved or deleted since can't be opened again, and a
    // row that leads nowhere is worse than no row — drop it.
    if (!(await openNode({ name: entry.name, path: entry.path, kind: 'file', handle: entry.handle }))) {
      recents = await forgetRecent(entry.id);
      renderRecents();
    }
    return;
  }
  const text = await readRecentText(entry.id);
  if (typeof text !== 'string') {
    toast(`“${entry.name}” is no longer saved. Open it again.`);
    recents = await forgetRecent(entry.id);
    renderRecents();
    return;
  }
  await openNode({ name: entry.name, path: entry.path, kind: 'file', text, lastModified: entry.ts });
}

// ---------- Welcome / empty states ----------

function showWelcome(mode = 'default', dirName = '') {
  if (searchIsOpen()) closeSearch();
  stopEditingUi();
  els.content.hidden = true;
  els.outline.hidden = true;
  els.searchToggle.hidden = true;
  els.saveBtn.hidden = true;
  els.editToggle.hidden = true;
  els.welcome.hidden = false;
  els.fileName.textContent = '';
  els.fileName.removeAttribute('title');
  updateProgress();
  document.title = 'Mull Reader - Markdown Reader';
  const inner = els.welcome.querySelector('.welcome-inner');
  const cta = inner.querySelector('.cta');
  const sub = inner.querySelector('.welcome-sub');
  // The secondary folder CTA only belongs to the default state — reconnect and
  // empty-folder already put a folder action in the primary button.
  for (const alt of inner.querySelectorAll('.cta-secondary')) alt.hidden = mode !== 'default';
  // Each mode owns both the label and the action so they can't drift apart.
  if (mode === 'reconnect') {
    sub.innerHTML = `Welcome back. Reconnect to <strong>${escapeHtml(dirName)}</strong> to keep reading.`;
    cta.textContent = `Reconnect “${dirName}”`;
    // The caller wires up the reconnect handler.
  } else if (mode === 'empty-folder') {
    sub.textContent = 'That folder has no markdown files. Try another one.';
    cta.textContent = 'Open a folder';
    cta.onclick = openFolder;
  } else {
    sub.innerHTML = 'A lightweight, open-source markdown reader for knowledge created by AI agents — and a place to edit it or write your own. Mobile friendly, and all documents remain local, always. A progressive web app: install it and it works offline.';
    cta.textContent = 'Open a file';
    cta.onclick = openFile;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Editable checklists ----------
// The one edit the reader supports: ticking a task-list checkbox. A tick is
// written into the markdown source held in memory and cached in recents, so
// it survives a reload even in browsers that can't write files. Where the
// browser hands out writable handles (Chrome, Edge) it is also saved straight
// back to the file after a one-time permission prompt; elsewhere the topbar
// save button exports an updated copy.

const TASK_LINE_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])(?=[ \t])/;

// Line numbers of every task marker, skipping fenced code blocks where a
// task-looking line is just text.
function scanTaskLines(text) {
  const lines = text.split('\n');
  const found = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open) {
      if (!fence) fence = open[1];
      else if (open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (TASK_LINE_RE.test(lines[i])) found.push(i);
  }
  return found;
}

// The checkbox square is a small target on a phone — let the whole task row
// take the tap. Wired once on the container; the rows inside come and go.
function setupTaskRowTaps() {
  els.content.addEventListener('click', (e) => {
    if (e.target.closest('a, input, button, pre')) return;
    const li = e.target.closest('li');
    if (!li || !li.classList.contains('task-item')) return;
    const box = li.querySelector(':scope > input[type="checkbox"]');
    if (!box || box.disabled) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  });
}

function wireTaskCheckboxes() {
  const boxes = [...els.content.querySelectorAll('input[type="checkbox"]')];
  if (!boxes.length) return;
  const taskLines = scanTaskLines(current.text);
  // The nth checkbox on screen is the nth task marker in the source. If the
  // counts disagree — a task-looking line in indented code, or checkbox HTML
  // written straight into the markdown — the mapping is unsafe, so the boxes
  // stay read-only rather than risk ticking the wrong line.
  if (taskLines.length !== boxes.length) return;
  boxes.forEach((box, i) => {
    box.disabled = false;
    box.addEventListener('change', () => toggleTask(taskLines[i], box.checked));
  });
}

function toggleTask(lineIndex, checked) {
  const lines = current.text.split('\n');
  const updated = lines[lineIndex]?.replace(TASK_LINE_RE, `$1${checked ? 'x' : ' '}$3`);
  if (typeof updated !== 'string') return;
  lines[lineIndex] = updated;
  current.text = lines.join('\n');
  // A node restored from the recents cache reads from its own text — keep it
  // in step so reopening within this session shows the tick too.
  if (typeof current.node.text === 'string') current.node.text = current.text;
  docDirty = true;
  // The browser-side save: the recents cache holds the updated text for any
  // document without a file handle behind it.
  recordRecent(current.node, { dirName: tree?.name || '', text: current.text })
    .then((list) => { recents = list; renderRecents(); })
    .catch(() => { /* the in-memory text still has the tick */ });
  saveCurrent({ auto: true });
  updateSaveUi();
}

const canWriteBack = () => typeof current?.node?.handle?.createWritable === 'function';

function updateSaveUi() {
  els.saveBtn.hidden = !current || !docDirty;
  const label = canWriteBack() ? 'Save changes to the file' : 'Save an updated copy';
  els.saveBtn.title = `${label} (⌘S)`;
  els.saveBtn.setAttribute('aria-label', label);
}

async function saveCurrent({ auto = false } = {}) {
  if (!current || !docDirty) return;
  if (canWriteBack()) {
    const handle = current.node.handle;
    if (auto && writeDeclined) return;
    try {
      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        writeDeclined = true;
        if (!auto) toast('No permission to write the file.');
        updateSaveUi();
        return;
      }
      const writable = await handle.createWritable();
      await writable.write(current.text);
      await writable.close();
      docDirty = false;
      writeDeclined = false;
      // Our own write moved the modification time; recording it stops the
      // focus-refresh from re-reading a file that hasn't changed under us.
      try { current.lastModified = (await handle.getFile()).lastModified; } catch { /* next refresh re-reads, same content */ }
      updateSaveUi();
      if (!auto) toast('Saved.');
    } catch {
      updateSaveUi();
      if (!auto) toast('Couldn’t save the file.');
    }
    return;
  }
  // No writable handle (Firefox, Safari, a cached recent, pasted text): the
  // ticks already live in the recents cache; an explicit save exports a copy.
  if (auto) return;
  const blob = new Blob([current.text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = current.name || 'document.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  docDirty = false;
  updateSaveUi();
  toast('Saved an updated copy.');
}

// ---------- Source editor ----------
// The pencil in the topbar flips the open document between its rendered form
// and its raw markdown in a plain textarea. Edits flow through the same pipe
// as checkbox ticks: into memory, into the recents cache, and — with a
// writable handle — back into the file itself.

const EDITOR_COMMIT_DEBOUNCE = 500;
let editorTimer = null;

function deriveDocName(text, fallback = 'Pasted note') {
  const heading = text.match(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/m);
  const name = (heading?.[1] || fallback).trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
  return `${name || fallback}.md`;
}

function setDocTitle(name) {
  els.fileName.textContent = name;
  els.fileName.title = current?.node?.path || name;
  document.title = `${name} - Mull Reader`;
}

// Fold whatever is in the textarea into the document and its saves. The
// snapshot survives a document switch: the async tail must file the text
// under the document that was edited, never whatever is on screen by then.
function commitEditor() {
  clearTimeout(editorTimer);
  editorTimer = null;
  // A late blur or timer can fire after the editor was put away and another
  // document took the screen — folding the stale textarea into it would
  // replace that document's text wholesale.
  if (!editing || !current || els.editor.value === current.text) return;
  current.text = els.editor.value;
  if (typeof current.node.text === 'string') current.node.text = current.text;
  docDirty = true;
  const snap = current;
  if (snap.text.trim()) {
    recordRecent(snap.node, { dirName: tree?.name || '', text: snap.text })
      .then((list) => { recents = list; renderRecents(); })
      .catch(() => { /* the in-memory text still has the edit */ });
  }
  saveSnapshot(snap);
  updateSaveUi();
}

// The document on screen saves through the full path, permission prompt and
// all; one that was switched away from gets a quiet best-effort write.
async function saveSnapshot(snap) {
  if (snap === current) {
    saveCurrent({ auto: true });
    return;
  }
  const handle = snap.node.handle;
  if (typeof handle?.createWritable !== 'function') return;
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
    const writable = await handle.createWritable();
    await writable.write(snap.text);
    await writable.close();
  } catch { /* the recents cache still holds the text */ }
}

function scheduleEditorCommit() {
  clearTimeout(editorTimer);
  editorTimer = setTimeout(commitEditor, EDITOR_COMMIT_DEBOUNCE);
}

function enterEdit() {
  if (!current || editing) return;
  if (searchIsOpen()) closeSearch();
  editing = true;
  els.editor.value = current.text;
  els.welcome.hidden = true;
  els.content.hidden = true;
  els.searchToggle.hidden = true;
  els.editor.hidden = false;
  els.editToggle.hidden = false;
  els.editToggle.setAttribute('aria-pressed', 'true');
  updateProgress();
  els.editor.focus();
}

function exitEdit() {
  if (!editing) return;
  commitEditor();
  stopEditingUi();
  renderCurrentText();
}

// Puts the editor away without rendering — for when another document is
// about to take the screen anyway.
function stopEditingUi() {
  if (!editing) return;
  commitEditor();
  editing = false;
  els.editor.hidden = true;
  els.editToggle.setAttribute('aria-pressed', 'false');
}

function toggleEdit() {
  if (editing) exitEdit();
  else enterEdit();
}

// Re-render the current document from the text in memory — same layout work
// as openNode, minus the file read and the bookkeeping.
function renderCurrentText() {
  const scrollY = window.scrollY;
  els.welcome.hidden = true;
  els.content.hidden = false;
  els.searchToggle.hidden = false;
  const headings = renderMarkdownInto(els.content, current.text);
  buildToc(els.toc, els.outline, headings);
  wireTaskCheckboxes();
  updateSaveUi();
  window.scrollTo(0, scrollY);
  setDocTitle(current.name);
  highlightCurrentInTree();
  updateProgress();
}

// ---------- Renaming ----------
// Tapping the file name in the topbar swaps it for an input. A document with
// a real file behind it is renamed on disk (or not at all — the display name
// never lies about the file); notes and pasted documents rename their recents
// entry, which is where they live.

function startRename() {
  if (!current || document.querySelector('.file-rename')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-rename';
  input.value = current.name;
  input.setAttribute('aria-label', 'Rename document');
  els.fileName.hidden = true;
  els.fileName.after(input);
  input.focus();
  const dot = input.value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = input.value;
    input.remove();
    els.fileName.hidden = false;
    if (commit) commitRename(value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function commitRename(raw) {
  if (!current) return;
  let name = raw.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
  if (!name) return;
  if (!/\.(md|markdown)$/i.test(name)) name += '.md';
  if (name === current.name) return;
  const node = current.node;
  const oldName = current.name;
  const oldKey = docKey(node);

  if (node.handle) {
    if (typeof node.handle.move !== 'function') {
      toast('This browser can’t rename files on disk.');
      return;
    }
    try {
      let perm = await node.handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await node.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        toast('No permission to rename the file.');
        return;
      }
      await node.handle.move(name);
    } catch {
      toast('Couldn’t rename the file.');
      return;
    }
  }

  node.name = name;
  if (node.path) node.path = node.path.replace(/[^/]*$/, name);
  current.name = name;
  setDocTitle(name);

  // Recents identity for handle-less documents is the name — move the row
  // rather than leave a twin behind under the old one.
  const stale = recents.find((r) => !r.handle && r.name === oldName);
  if (stale) {
    try { recents = await forgetRecent(stale.id); } catch { /* twin stays, harmless */ }
  }
  recordRecent(node, { dirName: tree?.name || '', text: current.text })
    .then((list) => { recents = list; renderRecents(); })
    .catch(() => { /* the rename itself already happened */ });

  // The reading position was filed under the old name or path.
  const positions = readPositions();
  if (positions[oldKey]) {
    positions[docKey(node)] = positions[oldKey];
    delete positions[oldKey];
    try { localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions)); } catch { /* position simply resets */ }
  }
  if (node.path) localStorage.setItem(LAST_FILE_KEY, node.path);

  // A renamed folder file still sits in the tree under its old name.
  if (node.handle && tree?.handle) {
    try {
      tree = await buildTree(tree.handle);
      renderTree();
      highlightCurrentInTree();
    } catch { /* the tree catches up when the folder is next opened */ }
  }
  toast('Renamed.');
}

// ---------- Opening files ----------

// Resolves true once the document is on screen, false if it couldn't be read —
// the recents list uses that to drop entries that no longer lead anywhere.
async function openNode(node, { keepScroll = false } = {}) {
  let file, text;
  try {
    ({ file, text } = await readNode(node));
  } catch {
    toast(`Couldn't read “${node.name}”`);
    return false;
  }
  // Anything still owed to the outgoing document is written before `current`
  // moves on, since the pending save was filed under its key.
  stopEditingUi();
  flushPosition();
  // The old document's ranges point into markup that is about to be replaced.
  clearHighlights();
  current = { node, name: file.name, lastModified: file.lastModified, text };
  docDirty = false;
  writeDeclined = false;
  if (node.path) localStorage.setItem(LAST_FILE_KEY, node.path);

  const scrollY = keepScroll ? window.scrollY : 0;
  const resumeAt = keepScroll ? null : savedFraction(node);
  els.welcome.hidden = true;
  els.content.hidden = false;
  els.searchToggle.hidden = false;
  els.editToggle.hidden = false;
  const headings = renderMarkdownInto(els.content, text);
  buildToc(els.toc, els.outline, headings);
  wireTaskCheckboxes();
  updateSaveUi();
  // One scroll, set synchronously now that the document is laid out — reading
  // scrollHeight flushes layout, so the fraction lands against the real height
  // rather than the previous document's. Anything later would fight the
  // browser's own scroll restoration.
  const anchor = keepScroll ? null : hashTarget();
  if (anchor) anchor.scrollIntoView();
  else if (resumeAt !== null) {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.max(0, Math.round(resumeAt * max)));
  } else {
    window.scrollTo(0, scrollY);
  }

  // A refresh of the same document keeps the search running over the new text;
  // a different document closes it, since the query belonged to the old one.
  if (keepScroll) { if (searchIsOpen()) runSearch({ keepAt: true }); }
  else if (searchIsOpen()) closeSearch();

  els.fileName.textContent = file.name;
  els.fileName.title = node.path || file.name;
  document.title = `${file.name} - Mull Reader`;
  highlightCurrentInTree();
  updateProgress();

  // Recording is storage work the reader shouldn't wait on, and a failure to
  // remember a document should never stop it from being displayed.
  recordRecent(node, { dirName: tree?.name || '', text })
    .then((list) => { recents = list; renderRecents(); })
    .catch(() => { /* recents stay as they are */ });

  // On phones the sidebar is a fixed overlay — tuck it away once a file is picked.
  if (isPhone() && !document.body.classList.contains('sidebar-collapsed')) {
    toggleSidebar();
  }
  return true;
}

// A single file from drop / file-handler / fallback input (not part of a tree).
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

// iOS (and iPadOS, which reports itself as a Mac with a touch screen) resolves
// an `accept` list to UTIs and hides everything that doesn't match. Files served
// by the Google Drive and iCloud providers frequently carry a generic UTI, so
// any filter at all can leave a folder of markdown greyed out and unpickable.
// An unfiltered picker is noisier but always openable; isMarkdownName() in
// openSingleFile() still decides what the app will actually read.
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Installed from the Home Screen, the app runs in its own WebKit container.
// A file input there reaches the Files app and nothing else — the Google Drive
// entry seen in Chrome for iOS is Chrome's own native integration, and no web
// API can summon it. Both facts are worth telling the reader once, in place.
const isStandalone = window.navigator.standalone === true ||
  matchMedia('(display-mode: standalone)').matches;

async function openFile() {
  if (!('showOpenFilePicker' in window)) {
    if (isIos) els.fileInput.removeAttribute('accept');
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

// Several files picked in one go. Reaching a cloud folder through the iOS
// Files app is slow enough that a multi-select is worth treating as a small
// reading list rather than as one file plus discards: the whole selection goes
// into recents — which caches their text, the only way back to a file the
// browser won't hand over a second time — and the sidebar lists them.
async function openFileSelection(files) {
  const markdown = files.filter((f) => isMarkdownName(f.name));
  if (!markdown.length) {
    toast('No markdown files in that selection.');
    return;
  }
  tree = treeFromFileList(markdown);
  renderTree();
  revealSidebar();

  // Recorded before the first file is opened so that one ends up on top.
  const first = firstFile(tree);
  for (const file of markdown.slice(0, MAX_RECENTS)) {
    if (file === first?.file) continue;
    try {
      recents = await recordRecent(
        { name: file.name, path: file.name, kind: 'file', file },
        { text: await file.text() },
      );
    } catch { /* unreadable, or too big to cache — it's still in the sidebar */ }
  }
  if (first) await openNode(first);
  renderRecents();
}

// ---------- Pasted markdown ----------

// A second way in that never touches a file picker: copy a document in the
// Drive app (or anywhere else) and paste it here. Pasted text has no file
// behind it, so recents keeps it the same way it keeps any other handle-less
// document — which means it survives a reload.
function openPastedText(text) {
  return openNode({ name: deriveDocName(text), path: '', kind: 'file', text });
}

async function pasteFromClipboard() {
  if (!navigator.clipboard?.readText) {
    toast('Copy some markdown, then paste it into this page.');
    return;
  }
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast('Clipboard access was denied.');
    return;
  }
  if (!text?.trim()) {
    toast('There’s no text on the clipboard.');
    return;
  }
  await openPastedText(text);
}

// ---------- Opening folders ----------

async function openFolder() {
  if (!supportsFS) {
    els.dirInput.click();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Couldn’t open that folder.');
    return;
  }
  try {
    await saveDirHandle(handle);
  } catch { /* persistence is best-effort */ }
  await loadFolder(handle);
  revealSidebar();
}

async function loadFolder(handle) {
  try {
    tree = await buildTree(handle);
  } catch {
    toast('Couldn’t read that folder.');
    return;
  }
  renderTree();
  const last = findByPath(tree, localStorage.getItem(LAST_FILE_KEY));
  const target = last || firstFile(tree);
  if (target) await openNode(target);
  else showWelcome('empty-folder');
}

// A folder is only useful with its tree in view, so an explicit open (picker,
// drop, fallback input) pops the sidebar out. Startup reconnect deliberately
// doesn't, so the collapsed-by-default preference still holds on load.
function revealSidebar() {
  if (!isPhone() && document.body.classList.contains('sidebar-collapsed')) toggleSidebar();
}

function loadFolderFromFileList(fileList) {
  tree = treeFromFileList(fileList);
  renderTree();
  revealSidebar();
  const target = firstFile(tree);
  if (target) openNode(target);
  else showWelcome('empty-folder');
}

// ---------- Startup reconnect ----------

async function tryRestore() {
  if (!supportsFS) return false;
  const saved = await loadDirHandle();
  if (!saved) return false;
  if (await verifyPermission(saved)) {
    await loadFolder(saved);
    return true;
  }
  // Permission needs a user gesture — offer a reconnect button.
  showWelcome('reconnect', saved.name);
  const cta = els.welcome.querySelector('.cta');
  cta.onclick = async () => {
    if (await verifyPermission(saved, { ask: true })) {
      cta.onclick = null;
      await loadFolder(saved);
    } else {
      toast('Permission denied. Pick the folder again.');
      cta.onclick = null;
      showWelcome();
      await clearDirHandle();
    }
  };
  return true;
}

// ---------- Startup auto-resume ----------
// Where no folder can be reconnected — every launch on Safari and Firefox, and
// on Chromium when no folder was ever opened — landing on the welcome screen
// makes a reader dig their document out again. Reopen the newest recent
// instead, the way an e-reader opens the book you were in.
//
// Only if it can be done without asking for anything: this runs on load, with
// no user gesture behind it, and a permission prompt there either fails
// outright or reads as the app grabbing at files on its own.
//
// A failure here never prunes the entry: a document that can't be opened
// unattended — a folder whose permission has lapsed, say — is still perfectly
// openable from the list with a click behind it. Entries are dropped only when
// a reader clicks one and it leads nowhere.
async function resumeLastDocument() {
  const entry = recents[0];
  if (!entry) return false;
  try {
    if (entry.handle) {
      if (!(await verifyPermission(entry.handle, { ask: false }))) return false;
      return await openNode({ name: entry.name, path: entry.path, kind: 'file', handle: entry.handle });
    }
    const text = await readRecentText(entry.id);
    if (typeof text !== 'string') return false;
    return await openNode({ name: entry.name, path: entry.path, kind: 'file', text, lastModified: entry.ts });
  } catch {
    return false;
  }
}

// ---------- External-edit refresh ----------

async function refreshCurrent() {
  if (!current?.node?.handle) return;
  // Edits not yet written to disk would be clobbered by a re-read, and a
  // re-render would pull the document out from under the open editor.
  if (docDirty || editing) return;
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
          try { await saveDirHandle(handle); } catch { /* best-effort */ }
          await loadFolder(handle);
          revealSidebar();
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
  applyCompact();
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
  const menuScrim = $('#menu-scrim');
  const menuIsOpen = () => document.body.classList.contains('menu-open');
  // Where focus should land when the panel closes. Held from open time rather
  // than read at close time, because dismissing by tapping the scrim blurs to
  // <body> before the handler runs.
  let menuReturnFocus = null;
  const setMenu = (open) => {
    if (open === menuIsOpen()) return;
    document.body.classList.toggle('menu-open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      menuReturnFocus = document.activeElement;
      // The panel is `visibility: hidden` until the class lands, and a hidden
      // element silently refuses focus, so read layout to flush the change.
      menu.getBoundingClientRect();
      menu.focus();
    } else {
      menuReturnFocus?.focus?.();
      menuReturnFocus = null;
    }
  };
  menuToggle.addEventListener('click', () => setMenu(!menuIsOpen()));
  $('#menu-close').addEventListener('click', () => setMenu(false));
  // The scrim spans the whole page while the panel is open, so anything the
  // reader touches outside the panel — the topbar included — lands here.
  menuScrim.addEventListener('click', () => setMenu(false));
  menu.addEventListener('click', (e) => {
    // A settings panel should stay put while you try things out, so the
    // appearance controls all leave it open. Only the two things that take you
    // out of it close it: reader mode, whose whole point is hiding the chrome,
    // and the links that navigate away.
    if (e.target.closest('#reader-toggle, a')) setMenu(false);
  });

  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#eink-toggle').addEventListener('click', toggleEink);
  $('#compact-toggle').addEventListener('click', toggleCompact);
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
  els.saveBtn.addEventListener('click', () => saveCurrent());
  $('#open-folder-btn').addEventListener('click', openFolder);
  $('#recents-clear').addEventListener('click', async () => {
    recents = await clearRecents();
    renderRecents();
    toast('Recent documents cleared.');
  });
  // Tapping the topbar file name renames the document in place; the hover
  // title still carries the full folder path for truncated names.
  els.fileName.addEventListener('click', startRename);
  // The welcome CTA's label and action are owned by showWelcome() per mode,
  // so it gets no static listener here.
  $('#welcome-open-file-btn').onclick = openFile;
  $('#welcome-open-folder-btn').addEventListener('click', openFolder);
  els.editToggle.addEventListener('click', toggleEdit);
  els.editor.addEventListener('input', scheduleEditorCommit);
  // A backgrounded tab may never see another input event — commit what's there.
  els.editor.addEventListener('blur', commitEditor);
  // Where picking a file means a slow trip through the Files app, pasting is
  // the faster door — so put it on the welcome screen rather than behind the
  // sidebar, which starts collapsed on a phone anyway.
  $('#welcome-paste-btn').onclick = pasteFromClipboard;
  $('#welcome-hint').hidden = !(isIos && isStandalone);

  els.dirInput.addEventListener('change', () => {
    if (els.dirInput.files?.length) loadFolderFromFileList(els.dirInput.files);
    els.dirInput.value = '';
  });
  els.fileInput.addEventListener('change', () => {
    const files = [...(els.fileInput.files || [])];
    els.fileInput.value = '';
    if (files.length === 1) openSingleFile(files[0]);
    else if (files.length > 1) openFileSelection(files);
  });

  $('#paste-btn').addEventListener('click', pasteFromClipboard);
  // Pasting anywhere on the page opens the clipboard as a document, so a
  // hardware keyboard doesn't need the menu. Fields keep their own paste.
  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text?.trim()) return;
    e.preventDefault();
    openPastedText(text);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuIsOpen()) {
      setMenu(false);
      return;
    }
    // Before reader mode: Esc while searching should put the search away,
    // not throw you out of the page you were reading.
    if (e.key === 'Escape' && searchIsOpen()) {
      closeSearch();
      return;
    }
    if (e.key === 'Escape' && editing) {
      exitEdit();
      return;
    }
    if (e.key === 'Escape' && document.body.classList.contains('reader-mode')) {
      toggleReader();
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'o') { e.preventDefault(); if (e.shiftKey) openFolder(); else openFile(); }
    else if (key === 'b') { e.preventDefault(); toggleSidebar(); }
    // Claimed whenever a document is open so the browser's save-page dialog
    // never appears over one; with nothing to save it simply does nothing.
    else if (key === 's' && (!els.content.hidden || editing)) { e.preventDefault(); commitEditor(); saveCurrent(); }
    else if (key === 'e' && current) { e.preventDefault(); toggleEdit(); }
    // Only claim ⌘F when there's a document to search — on the welcome screen
    // the browser's own find bar is the more useful thing to leave alone.
    else if (key === 'f' && !els.content.hidden) { e.preventDefault(); openSearch(); }
  });

  window.addEventListener('focus', refreshCurrent);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCurrent();
  });

  window.addEventListener('scroll', () => requestAnimationFrame(updateProgress), { passive: true });
  window.addEventListener('scroll', schedulePositionSave, { passive: true });
  // A phone can be closed, swiped away, or backgrounded without ever firing
  // unload, so the debounce is flushed on the events that do arrive.
  window.addEventListener('pagehide', flushPosition);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushPosition();
  });
  window.addEventListener('resize', () => {
    updateProgress();
    // A shrinking window can push the stored width past its cap; re-clamp
    // without persisting so the preference returns when there's room again.
    applySidebarWidth();
  });

  setupDragDrop();
  setupTaskRowTaps();
  setupTouchReaderBar();
  setupSearch();
  setupPwa();
  renderTree();
  // The recents list is useful even while a folder reconnects, so it loads
  // alongside rather than after.
  const recentsReady = loadRecents()
    .then((list) => { recents = list; renderRecents(); })
    .catch(() => {});
  tryRestore().then(async (restored) => {
    if (restored) return;
    // No folder came back, so the way back into a document is the recents
    // list. Reopen the newest one if that can be done unattended; the welcome
    // screen is what's left when it can't, never a blank page.
    await recentsReady;
    if (!(await resumeLastDocument())) showWelcome();
  });
}

init();
