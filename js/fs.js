// File access: File System Access API, IndexedDB handle persistence,
// and a webkitdirectory fallback for browsers without the API.

export const supportsFS = 'showDirectoryPicker' in window;

const MD_RE = /\.(md|markdown)$/i;
const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'vendor', '__pycache__', 'dist', 'build']);

export function isMarkdownName(name) {
  return MD_RE.test(name);
}

// ---------- IndexedDB handle persistence ----------

const DB_NAME = 'folio'; // pre-rename name kept so saved folder handles survive
const STORE = 'handles';

// One connection for the page's lifetime. Recents touch the database on every
// document opened, and a fresh connection per call would pile up open handles
// that a later version upgrade would then have to wait on.
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // A failed open shouldn't be cached as the permanent answer.
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function withStore(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

export function saveDirHandle(handle) {
  return withStore('readwrite', (store) => store.put(handle, 'dir'));
}

export function loadDirHandle() {
  return withStore('readonly', (store) => store.get('dir')).catch(() => null);
}

export function clearDirHandle() {
  return withStore('readwrite', (store) => store.delete('dir')).catch(() => {});
}

// ---------- Recent documents ----------
// A short list of what was read last, so getting back to a document doesn't
// mean picking it out of the file system again.
//
// Where the browser has the File System Access API, an entry stores the file's
// handle and nothing else — reopening re-reads from disk, so the document is
// always current and no copy of it is kept. Where it doesn't (iOS Safari, and
// anything that arrives as a plain File from a cloud provider, a drop, or the
// launch queue) there is no handle and therefore no way back to the file at
// all, so the text itself is cached under a separate key. That copy is the
// only thing that makes recents work on iOS/Google Drive. It stays in this
// origin's IndexedDB and is dropped when the entry falls off the list.

export const MAX_RECENTS = 8;

// Big documents aren't worth the storage; they're skipped rather than cached.
const MAX_CACHED_TEXT = 1_000_000;

const RECENTS_KEY = 'recents';
const textKey = (id) => `text:${id}`;
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function loadRecents() {
  return withStore('readonly', (store) => store.get(RECENTS_KEY))
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => []);
}

export function readRecentText(id) {
  return withStore('readonly', (store) => store.get(textKey(id))).catch(() => null);
}

// Same file as an existing entry? Handles know the answer authoritatively;
// cached-text entries have only their name to go on.
async function findExisting(list, node) {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (node.handle) {
      if (!entry.handle) continue;
      try {
        if (await entry.handle.isSameEntry(node.handle)) return i;
      } catch {
        if (entry.name === node.name && entry.path === (node.path || '')) return i;
      }
    } else if (!entry.handle && entry.name === node.name) {
      return i;
    }
  }
  return -1;
}

// Records `node` as the most recent document and returns the updated list.
// `text` is only used for entries that have no handle to come back through;
// if such an entry can't be cached it isn't recorded at all, since a recent
// that can't be reopened is just a dead row.
export async function recordRecent(node, { dirName = '', text = null } = {}) {
  let list = await loadRecents();
  const at = await findExisting(list, node);
  const id = at >= 0 ? list[at].id : newId();

  if (!node.handle) {
    if (typeof text !== 'string' || text.length > MAX_CACHED_TEXT) return list;
    try {
      await withStore('readwrite', (store) => store.put(text, textKey(id)));
    } catch {
      return list; // quota, private mode — leave the list as it was
    }
  }

  const prev = at >= 0 ? list[at] : null;
  if (prev) list.splice(at, 1);
  list.unshift({
    id,
    name: node.name,
    path: node.path || '',
    // Reopening a folder's file from the recents list happens with no folder
    // loaded, so an empty dirName means "unknown", not "none" — keep the one
    // recorded when the file was first read through its folder.
    dirName: node.path ? (dirName || prev?.dirName || '') : '',
    handle: node.handle || null,
    ts: Date.now(),
  });

  const dropped = list.slice(MAX_RECENTS);
  list = list.slice(0, MAX_RECENTS);
  try {
    await withStore('readwrite', (store) => {
      for (const entry of dropped) if (!entry.handle) store.delete(textKey(entry.id));
      store.put(list, RECENTS_KEY);
    });
  } catch { /* the in-memory list is still correct for this session */ }
  return list;
}

export async function forgetRecent(id) {
  const list = (await loadRecents()).filter((entry) => entry.id !== id);
  try {
    await withStore('readwrite', (store) => {
      store.delete(textKey(id));
      store.put(list, RECENTS_KEY);
    });
  } catch { /* best effort */ }
  return list;
}

export async function clearRecents() {
  const list = await loadRecents();
  try {
    await withStore('readwrite', (store) => {
      for (const entry of list) store.delete(textKey(entry.id));
      store.delete(RECENTS_KEY);
    });
  } catch { /* best effort */ }
  return [];
}

// ---------- Permissions ----------

export async function verifyPermission(handle, { ask = false } = {}) {
  const opts = { mode: 'read' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (ask && (await handle.requestPermission(opts)) === 'granted') return true;
  } catch {
    return false;
  }
  return false;
}

// ---------- Tree building ----------
// Node shape: { name, path, kind: 'dir'|'file', handle?, file?, children? }

export async function buildTree(dirHandle, path = '') {
  const node = { name: dirHandle.name, path, kind: 'dir', handle: dirHandle, children: [] };
  for await (const entry of dirHandle.values()) {
    if (entry.name.startsWith('.')) continue;
    const childPath = path ? `${path}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(entry.name)) continue;
      const sub = await buildTree(entry, childPath);
      if (sub.children.length) node.children.push(sub);
    } else if (isMarkdownName(entry.name)) {
      node.children.push({ name: entry.name, path: childPath, kind: 'file', handle: entry });
    }
  }
  sortChildren(node);
  return node;
}

// Fallback: build the same tree shape from a FileList (webkitdirectory input).
export function treeFromFileList(fileList) {
  const root = { name: '', path: '', kind: 'dir', children: [] };
  for (const file of fileList) {
    if (!isMarkdownName(file.name)) continue;
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    if (parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p))) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let child = node.children.find((c) => c.kind === 'dir' && c.name === dirName);
      if (!child) {
        child = {
          name: dirName,
          path: node.path ? `${node.path}/${dirName}` : dirName,
          kind: 'dir',
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ name: file.name, path: rel, kind: 'file', file });
  }
  // The picker wraps everything in the chosen folder; unwrap that single top dir.
  let top = root;
  if (top.children.length === 1 && top.children[0].kind === 'dir') top = top.children[0];
  sortTreeDeep(top);
  return top;
}

function sortChildren(node) {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function sortTreeDeep(node) {
  sortChildren(node);
  for (const child of node.children) if (child.kind === 'dir') sortTreeDeep(child);
}

export function findByPath(node, path) {
  if (!node || !path) return null;
  if (node.path === path && node.kind === 'file') return node;
  if (!node.children) return null;
  for (const child of node.children) {
    const found = findByPath(child, path);
    if (found) return found;
  }
  return null;
}

export function firstFile(node) {
  if (!node) return null;
  if (node.kind === 'file') return node;
  for (const child of node.children || []) {
    const found = firstFile(child);
    if (found) return found;
  }
  return null;
}

// A single file node carries `handle` when it came from a picker/drop with the
// File System Access API, `file` when it arrived as a plain File (fallback
// input, drag-and-drop, launch queue), or `text` when it was restored from the
// recents cache and there is nothing on disk left to read.
export async function readNode(node) {
  if (typeof node.text === 'string') {
    return { file: { name: node.name, lastModified: node.lastModified || 0 }, text: node.text };
  }
  const file = node.handle ? await node.handle.getFile() : node.file;
  const text = await file.text();
  return { file, text };
}
