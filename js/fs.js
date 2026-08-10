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

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

export async function readNode(node) {
  const file = node.handle ? await node.handle.getFile() : node.file;
  const text = await file.text();
  return { file, text };
}
