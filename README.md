# Mull Reader

A lightweight, open-source, mobile-friendly markdown reader — built to consume knowledge created by AI agents. Installable as a PWA, with book-like typography, no build step, and no frameworks.

**Live:** https://mullreader.com

## Why

The challenge is no longer the availability of knowledge — AI agents produce it faster than anyone can keep up with. The challenge now is *understanding* it. And understanding cannot be outsourced: no agent can do the reading for you.

AI agents share what they know in markdown files, and we read on whatever is at hand — a phone in a queue, a tablet on the couch, a desktop at work. Mull Reader is a reading environment for exactly that — a place to mull things over. Grab a markdown file from wherever it landed (iCloud, Google Drive, a repo, an agent's output folder) and open it in a reader designed for focus, on any device.

**All documents remain local, always.** Files are read directly in your browser via the File System Access API; nothing is ever uploaded anywhere.

## Features

- **Open a file** — from the sidebar, the welcome screen, or `⌘O`
- **Open a folder** of `.md`/`.markdown` files (File System Access API) — the folder reconnects automatically on your next visit via a persisted handle in IndexedDB
- **File tree** in the sidebar showing only markdown files, with the current file highlighted; it appears once a folder is open and sits above the contents outline
- **Recent documents** — the last eight files read, in the sidebar and on the welcome screen. Where the File System Access API exists an entry stores only the file handle and re-reads from disk; where it doesn't (Safari, Firefox, anything arriving from Google Drive or iCloud on iOS) the browser gives no way back to the file, so the text is cached in IndexedDB instead. Documents over ~1 MB are skipped, and *Clear recent* removes every entry and cached copy
- **Paste markdown** from the clipboard — a sidebar action, or just paste anywhere on the page. Pasted documents are named from their first heading and kept in recents
- **Multi-select** — picking several files at once builds a session file tree from them and remembers them all, so one trip through a slow mobile file picker keeps paying off
- **Contents sidebar** (h2/h3) on the left with scroll-spy and hover anchor links on headings; it starts closed and `⌘B` brings it in, with the choice persisted. On phones it's a slide-over panel that tucks away when you pick a file and closes when you tap outside it
- **Resizable sidebar** — drag the edge between the sidebar and the page (or focus it and use ←/→); double-click resets it. The width is persisted and applied before first paint
- **Editorial typography** — serif body (Charter/Georgia stack) with 1.7 line height, styled blockquotes, zebra tables, inline-code pills, decorative horizontal rules
- **Settings panel** — a full-height panel sliding in from the right (replacing the old dropdown), dismissed by touching anywhere outside it, by `Esc`, or by its close button. Appearance controls leave it open so you can see what you are changing; reader mode and the links close it
- **Text size controls** — A−/A+ in the settings panel step the reading size through nine levels (14.5–32px), persisted
- **GFM rendering** via marked: tables, task lists, strikethrough, autolinks — sanitized with DOMPurify
- **Syntax highlighting** (highlight.js) with theme-aware colors and a copy button on every code block
- **Light & dark themes** — follows `prefers-color-scheme`, manual toggle persisted; dark is a warm dark gray, not pure black
- **E-ink mode** — a settings switch for a pure-grayscale, shadow-free, motion-free look suited to e-ink displays, with a reading progress % in the corner and justified, hyphenated text
- **Reader mode** — hides everything but the page, with progress % and justified text like e-ink mode; the topbar peeks back on hover (or scroll-up on touch), `Esc` exits
- **Compact spacing** — a settings toggle that tightens the vertical rhythm between blocks. Chiefly it collapses the browser-default paragraph margins that marked adds inside loose list items, which is where most of the dead space in agent-written markdown comes from; roughly 20% shorter on a typical document
- **Reading position** — each document reopens where you stopped reading. The position is kept per document (by path, or by name for pasted and single files) as a fraction of the page, so changing text size or compact spacing still lands in the right place; the last hundred are remembered, and a document left at the very start or read to the end isn't stored at all
- **Find in document** — a magnifier in the topbar, or `⌘/Ctrl+F`, opens a search bar with a match counter and prev/next. `Enter` and `Shift+Enter` step through hits, `Esc` closes. This exists because an installed iOS app has no browser find bar at all — there is otherwise no way to search a document on a phone. Matches are painted with the CSS Custom Highlight API, so the document itself is never rewritten; browsers without it still count and scroll to matches
- **Auto-resume** — where no folder can be reconnected (Safari, Firefox, or Chromium with no saved folder), launching reopens the most recent document at its saved position instead of showing the welcome screen. Only when it can be done without a permission prompt; otherwise the welcome screen appears as before
- **Live refresh** — the current file is re-read when the window regains focus, so external edits (say, from an agent still writing) show up
- **Drag & drop** a `.md` file (or a whole folder) anywhere on the window
- **Full offline support** — cache-first service worker that refreshes itself automatically when a new version deploys
- **File handler** — when installed, double-clicking a `.md` file can open it directly in Mull Reader (Chromium)
- Keyboard: `⌘/Ctrl+O` open file, `⇧⌘/Ctrl+O` open folder, `⌘/Ctrl+B` toggle sidebar, `⌘/Ctrl+F` find in document

## Images

Images with an `https://` address, and images embedded in the file as data URIs, render normally. Images sitting *next to* the markdown file — the usual `![diagram](./diagram.png)` — do not: the browser grants the page access to the one file you picked, not to its siblings, so there is nothing to resolve the relative path against. Embed images or host them to have them travel with a document.

## Browser support

Fully featured in Chrome and Edge. Firefox and Safari fall back to plain file and directory `<input>` pickers (no persistent reconnect, no file handling) — reading, rendering, themes, and offline all still work.

## Development

It's a static site — serve the folder and open it:

```sh
python3 -m http.server 8123
# → http://localhost:8123
```

No dependencies to install; marked, DOMPurify, and highlight.js are vendored in `vendor/`.

When changing any app-shell file, bump the `CACHE` version in `sw.js` so installed clients pick up the update.

## Files

```
index.html      app shell
about.html      what it is, shortcuts, browser support
privacy.html    privacy policy
terms.html      terms of use
404.html        not-found page (self-contained, no external assets)
robots.txt      crawler policy, points at the sitemap
sitemap.xml     the four indexable pages
llms.txt        summary for AI agents and LLM crawlers
styles.css      all styling, light/dark/e-ink themes, responsive layout
js/app.js       UI orchestration, folder/file opening, PWA wiring
js/fs.js        File System Access + IndexedDB persistence + fallbacks
js/prefs.js     applies saved appearance to the static pages
js/render.js    markdown → sanitized HTML, highlighting, TOC/scroll-spy
sw.js           cache-first service worker
manifest.json   PWA manifest (standalone, file handler)
```

## Contributing

Issues and pull requests are welcome. Keep the spirit of the project: no build step, no frameworks, no telemetry, and documents never leave the machine.

## License

[MIT](./LICENSE). Vendored libraries ([marked](https://github.com/markedjs/marked), [DOMPurify](https://github.com/cure53/DOMPurify), [highlight.js](https://github.com/highlightjs/highlight.js)) keep their own licenses.
