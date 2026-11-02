const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const extensionDir = join(__dirname, '..', 'chrome-extension');
const source = (name) => readFileSync(join(extensionDir, name), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadContent(entries = [], pathname = '/manga/book/') {
  const document = {
    readyState: 'loading',
    addEventListener() {},
    querySelectorAll: () => entries
  };
  const context = vm.createContext({
    document, URL, location: { pathname, href: `https://mangaraw.ma${pathname}`, origin: 'https://mangaraw.ma' },
    chrome: { runtime: { onMessage: { addListener() {} } } }
  });
  vm.runInContext(source('content-mangaraw.js').replace(/\}\)\(\);\s*$/, `
    globalThis.api = { collectDirectoryChapters, getCurrentImageItems };
  })();`), context);
  return context.api;
}

function entry(path, label, button = false) {
  return {
    textContent: label,
    closest: () => button ? {} : null,
    getAttribute: (name) => name === 'href' && !button ? path
      : name === 'onclick' && button ? `navigate('${path}')` : null
  };
}

function loadRunner(fetch = () => { throw new Error('Unexpected fetch'); }) {
  const context = vm.createContext({
    URL, fetch, document: { getElementById: () => ({}) }
  });
  vm.runInContext(source('save-runner.js').replace(/^main\(\)\.catch\(.*\);\s*$/m, ''), context);
  return context;
}

function loadBridge(slotClass, pageCount, tainted = true) {
  const listeners = new Map();
  class Element {
    constructor(parent = null) { this.parent = parent; this.dataset = {}; }
    setAttribute(name, value) { if (name === 'data-i') this.index = Number(value); }
    getAttribute(name) { return name === 'data-i' ? String(this.index) : null; }
    closest(selector) {
      if (this.isSlot && selector.includes(`.${slotClass}[data-i]`)) return this;
      return this.parent?.closest(selector) || null;
    }
    querySelectorAll(selector) {
      if (selector.includes(`.${slotClass}[data-i]`)) return this.slots || [];
      if (selector === 'canvas') return this.slots ? this.slots.map(s => s.canvas) : [];
      return [];
    }
    contains(element) { return element.parent?.parent === this; }
  }
  class HTMLImageElement extends Element {
    get src() { return this.url; }
    set src(value) { this.url = value; }
  }
  class HTMLCanvasElement extends Element {
    constructor(parent) { super(parent); this.width = 4; this.height = 4; }
    toDataURL() {
      if (tainted) throw new Error('SecurityError: tainted canvas');
      return `data:image/png;base64,page${this.parent.index}`;
    }
  }
  class CanvasRenderingContext2D {
    constructor(canvas) { this.canvas = canvas; }
    drawImage() {}
  }
  const root = new Element();
  root.className = 'chapter_boxImages';
  root.slots = Array.from({ length: pageCount }, (_, index) => {
    const slot = new Element(root);
    slot.isSlot = true;
    slot.index = index;
    slot.canvas = new HTMLCanvasElement(slot);
    return slot;
  });
  const document = {
    body: root, title: 'Reader fixture',
    querySelector: (selector) => selector === '#chapter_boxImages' ? root : null,
    addEventListener: (name, listener) => listeners.set(name, listener),
    dispatchEvent: (event) => listeners.get(event.type)?.(event)
  };
  const context = vm.createContext({
    document, Element, HTMLImageElement, HTMLCanvasElement, CanvasRenderingContext2D,
    URL, location: { href: 'https://mangaraw.ma/manga/book/chapter/' }, navigator: { userAgent: 'test' },
    window: { fetch() {} }, XMLHttpRequest: class { open() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, console
  });
  vm.runInContext(source('page-bridge.js'), context);
  return {
    draw(index, permutation) {
      const image = new HTMLImageElement();
      image.src = `https://img-cdn.stackpathcdn.app/public/key/?id=${index}`;
      const painter = new CanvasRenderingContext2D(root.slots[index].canvas);
      permutation.forEach((destination, sourceIndex) => {
        painter.drawImage(image, sourceIndex % 4, Math.floor(sourceIndex / 4), 1, 1,
          destination % 4, Math.floor(destination / 4), 1, 1);
      });
    },
    state() {
      let result;
      listeners.set('codex-mangaraw-response', (event) => { result = event.detail.payload; });
      document.dispatchEvent({ type: 'codex-mangaraw-command', detail: { type: 'get-state', requestId: 'test' } });
      return plain(result);
    }
  };
}

test('new directory buttons are collected even when the site canonicalizes the manga slug', () => {
  const api = loadContent([
    entry('/manga/canonical-book/ch-3/', 'Chapter 3', true),
    entry('/manga/canonical-book/ch-2/', 'Chapter 2', true),
    entry('/manga/canonical-book/ch-1/', 'Chapter 1', true),
    entry('https://unrelated.example/manga/book/ch-4/', 'External', true),
    entry('/manga/other/ch-5/', 'Recommendation')
  ]);
  const chapters = plain(api.collectDirectoryChapters());
  assert.deepEqual(chapters.map(c => c.label), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
  assert.ok(chapters.every(c => c.requiresReaderToken));
});

test('legacy chapter links remain ordered and deduplicated', () => {
  const api = loadContent([
    entry('/manga/book/ch-2/', 'Chapter 2'),
    entry('/manga/book/ch-1/', 'Chapter 1'),
    entry('/manga/book/ch-1/?ignored=true', 'Duplicate')
  ]);
  const chapters = plain(api.collectDirectoryChapters());
  assert.deepEqual(chapters.map(c => c.label), ['Chapter 1', 'Chapter 2']);
  assert.ok(chapters.every(c => !c.requiresReaderToken));
});

for (const slotClass of ['imageChap', 'cz']) {
  test(`${slotClass}: tainted canvases reconstruct all 18 pages in slot order`, () => {
    const bridge = loadBridge(slotClass, 18);
    const permutation = [7, 2, 13, 0, 8, 15, 4, 11, 1, 12, 6, 9, 14, 3, 10, 5];
    for (let index = 17; index >= 0; index--) bridge.draw(index, permutation);
    const state = bridge.state();
    assert.equal(state.slotCount, 18);
    assert.equal(state.pages.length, 18);
    assert.equal(state.canvasUrls.length, 0);
    assert.deepEqual(state.imageUrls, [], 'shuffled source URLs must never become a download fallback');
    assert.deepEqual(state.pages.map(p => p.slotIndex), Array.from({ length: 18 }, (_, i) => i));
    const pixels = [];
    const painter = { drawImage(_bitmap, sx, sy, _sw, _sh, dx, dy) { pixels[dy * 4 + dx] = permutation[sy * 4 + sx]; } };
    const runner = loadRunner();
    for (const piece of state.pages[0].pieces) runner.drawPiece(painter, {}, piece);
    assert.deepEqual(pixels, Array.from({ length: 16 }, (_, i) => i), 'saved pixels must be in readable order');
  });
}

test('canvas fallback keeps more than the 10 debug samples and excludes raw sources', () => {
  const bridge = loadBridge('imageChap', 18, false);
  for (let i = 0; i < 18; i++) bridge.draw(i, [0]);
  const state = bridge.state();
  assert.equal(state.canvasSample.length, 10);
  assert.equal(state.canvasUrls.length, 18);
  assert.equal(loadContent().getCurrentImageItems(state).length, 18);
  assert.equal(loadRunner().getMangarawImageItems(state).length, 18);
  const incomplete = { slotCount: 18, imageUrls: ['https://example.com/shuffled.jpg'] };
  assert.equal(loadContent().getCurrentImageItems(incomplete).length, 0);
  assert.equal(loadRunner().getMangarawImageItems(incomplete).length, 0);
});

test('batch chapters receive fresh reader tokens without losing cancellation', async () => {
  const calls = [];
  const runner = loadRunner(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ t: `fresh-${calls.length}` }) };
  });
  const signal = new AbortController().signal;
  const chapter = { url: 'https://mangaraw.ma/manga/book/ch-1/', requiresReaderToken: true };
  assert.equal(new URL(await runner.getMangarawChapterUrl(chapter, signal)).searchParams.get('t'), 'fresh-1');
  assert.equal(new URL(await runner.getMangarawChapterUrl(chapter, signal)).searchParams.get('t'), 'fresh-2');
  assert.equal(calls[0].url, 'https://mangaraw.ma/api/v1/m/t');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal, signal);
  assert.equal(await runner.getMangarawChapterUrl({ url: chapter.url }, signal), chapter.url);
  assert.equal(calls.length, 2);
});

test('missing reader tokens fail clearly', async () => {
  const runner = loadRunner(async () => ({ ok: true, json: async () => ({}) }));
  await assert.rejects(runner.getMangarawChapterUrl({
    url: 'https://mangaraw.ma/manga/book/ch-1/', requiresReaderToken: true
  }), /reader token is missing/);
});
