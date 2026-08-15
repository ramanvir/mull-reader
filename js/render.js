// Markdown rendering: marked (GFM) → DOMPurify → enhancements
// (heading anchors, syntax highlighting, copy buttons, TOC data).

/* global marked, DOMPurify, hljs */

marked.use({ gfm: true, breaks: false });

// YAML frontmatter (--- ... ---) is metadata, not content — agent-written
// files often start with it, and marked would render the fences as a
// horizontal rule plus a stray heading.
function stripFrontmatter(text) {
  const m = text.match(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  return m ? text.slice(m[0].length) : text;
}

export function renderMarkdownInto(container, text) {
  const raw = marked.parse(stripFrontmatter(text));
  container.innerHTML = DOMPurify.sanitize(raw);
  addHeadingAnchors(container);
  highlightCode(container);
  markTaskLists(container);
  explainBrokenImages(container);
  return collectHeadings(container);
}

// A document's own images usually sit beside it on disk, and those can never
// load: the browser grants this page access to the single file the reader
// picked, not to its neighbours. Left alone that renders as a broken-image
// glyph, which reads like a bug in the app. Say what actually happened.
function explainBrokenImages(container) {
  for (const img of container.querySelectorAll('img')) {
    // A stripped or empty src counts as complete with no intrinsic size, so
    // sanitiser-rejected sources fall into the same path as failed loads.
    if (img.complete) {
      if (img.naturalWidth === 0) replaceWithImageNotice(img);
    } else {
      img.addEventListener('error', () => replaceWithImageNotice(img), { once: true });
    }
  }
}

function replaceWithImageNotice(img) {
  if (!img.isConnected) return;
  const src = (img.getAttribute('src') || '').trim();
  const local = src !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);

  const note = document.createElement('span');
  note.className = 'img-missing';
  note.title = local
    ? 'This image sits next to the document on disk. A browser only gives this page the one file you opened, so images beside it can’t be reached. Embed the image in the file or host it online to have it travel with the document.'
    : 'The image could not be loaded from its address.';

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '15');
  icon.setAttribute('height', '15');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.innerHTML = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 16l5-4 4 3 3-2 6 4"/><path d="M3 3l18 18"/>';
  note.appendChild(icon);

  const label = document.createElement('span');
  const alt = (img.getAttribute('alt') || '').trim();
  label.textContent = alt || src.split(/[\\/]/).pop() || 'image';
  note.appendChild(label);

  const reason = document.createElement('em');
  reason.textContent = local ? 'not available beside the file' : 'could not be loaded';
  note.appendChild(reason);

  img.replaceWith(note);
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section';
}

function addHeadingAnchors(container) {
  const used = new Map();
  for (const h of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    let id = slugify(h.textContent);
    const n = used.get(id) || 0;
    used.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    h.id = id;
    const a = document.createElement('a');
    a.className = 'h-anchor';
    a.href = `#${id}`;
    a.textContent = '#';
    a.setAttribute('aria-label', 'Link to this section');
    h.appendChild(a);
  }
}

function highlightCode(container) {
  for (const code of container.querySelectorAll('pre > code')) {
    try {
      hljs.highlightElement(code);
    } catch { /* unknown language — leave as plain text */ }
    wrapWithCopyButton(code.parentElement);
  }
}

function wrapWithCopyButton(pre) {
  const wrap = document.createElement('div');
  wrap.className = 'codeblock';
  pre.parentNode.insertBefore(wrap, pre);
  wrap.appendChild(pre);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector('code').innerText);
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1600);
    } catch {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    }
  });
  wrap.appendChild(btn);
}

function markTaskLists(container) {
  for (const input of container.querySelectorAll('li > input[type="checkbox"]')) {
    input.closest('li').classList.add('task-item');
    input.closest('ul')?.classList.add('task-list');
    // The label goes into its own element so it forms a shrinkable column
    // beside the checkbox: long text then wraps within that column (hanging
    // indent) instead of dropping to a full-width line under the box.
    const label = document.createElement('span');
    label.className = 'task-label';
    let node = input.nextSibling;
    while (node && !(node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL'))) {
      const next = node.nextSibling;
      label.appendChild(node);
      node = next;
    }
    input.after(label);
  }
}

function collectHeadings(container) {
  return [...container.querySelectorAll('h2, h3')].map((h) => ({
    id: h.id,
    level: Number(h.tagName[1]),
    text: h.textContent.replace(/#$/, '').trim(),
    el: h,
  }));
}

// ---------- Table of contents + scroll-spy ----------

let spyObserver = null;

export function buildToc(tocEl, outlineEl, headings) {
  tocEl.innerHTML = '';
  if (spyObserver) { spyObserver.disconnect(); spyObserver = null; }

  if (headings.length < 2) {
    outlineEl.hidden = true;
    return;
  }
  outlineEl.hidden = false;

  const links = new Map();
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.text;
    a.className = `toc-link toc-h${h.level}`;
    tocEl.appendChild(a);
    links.set(h.id, a);
  }

  const visible = new Set();
  const setActive = (id) => {
    for (const [key, a] of links) a.classList.toggle('active', key === id);
  };

  spyObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      if (visible.size) {
        // Highlight the topmost visible heading.
        const first = headings.find((h) => visible.has(h.id));
        if (first) setActive(first.id);
      } else {
        // Nothing in view: highlight the last heading above the viewport.
        let last = null;
        for (const h of headings) {
          if (h.el.getBoundingClientRect().top < 120) last = h;
        }
        if (last) setActive(last.id);
      }
    },
    { rootMargin: '-64px 0px -60% 0px' }
  );
  for (const h of headings) spyObserver.observe(h.el);
}
