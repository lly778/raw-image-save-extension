(function () {
  'use strict';

  const BUTTON_ID = 'codex-mangaraw-save-folder';
  const ALL_BUTTON_ID = 'codex-mangaraw-save-all';
  const LABEL_IDLE = 'Save To Folder';
  const LABEL_ALL = 'Download Chapters';
  const LABEL_BUSY = 'Preparing...';

  let requestCounter = 0;
  const pending = new Map();
  const runningButtons = new WeakSet();
  let countPollTimer = 0;
  let countLastValue = '';
  let countIdleRounds = 0;
  let bulkWarmupPromise = null;
  let bulkWarmupDone = false;

  function isReaderUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length >= 3 && parts[0] === 'manga';
  }

  function isDirectoryUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 'manga';
  }

  function requestState() {
    return new Promise((resolve, reject) => {
      const requestId = `req-${Date.now()}-${++requestCounter}`;
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Timed out waiting for page state. Refresh the chapter page and retry.'));
      }, 2500);
      pending.set(requestId, { resolve, timer });
      document.dispatchEvent(new CustomEvent('codex-mangaraw-command', {
        detail: { type: 'get-state', requestId }
      }));
    });
  }

  document.addEventListener('codex-mangaraw-response', (event) => {
    const detail = event.detail || {};
    const item = pending.get(detail.requestId);
    if (!item) {
      return;
    }
    window.clearTimeout(item.timer);
    pending.delete(detail.requestId);
    item.resolve(detail.payload);
  });

  function wait(delay) {
    return new Promise((resolve) => window.setTimeout(resolve, delay));
  }

  async function warmUpReader() {
    const previousY = window.scrollY;
    const slots = [...document.querySelectorAll('.cz[data-i]')]
      .sort((a, b) => Number(a.getAttribute('data-i')) - Number(b.getAttribute('data-i')));
    for (const slot of slots) {
      slot.scrollIntoView({ block: 'center' });
      await wait(120);
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await wait(800);
    window.scrollTo(0, previousY);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'collect-mangaraw-state' || !isReaderUrl()) {
      return false;
    }
    if (!bulkWarmupDone && !bulkWarmupPromise) {
      bulkWarmupPromise = warmUpReader()
        .then(() => {
          bulkWarmupDone = true;
        })
        .finally(() => {
          bulkWarmupPromise = null;
        });
    }
    Promise.resolve(bulkWarmupPromise)
      .then(() => requestState())
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  function setButtonState(button, text, disabled) {
    button.textContent = text;
    button.disabled = disabled;
  }

  function getSafeBaseName(title) {
    return (title || 'mangaraw')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'mangaraw';
  }

  function getSafeFilename(title, index, source) {
    let ext = 'png';
    if (source && !source.startsWith('data:image/')) {
      const extMatch = source.match(/\.(jpg|jpeg|png|webp|gif|bmp|avif)(?:$|[?#])/i);
      ext = extMatch ? extMatch[1].toLowerCase() : 'png';
    }
    return `${getSafeBaseName(title)} - ${String(index + 1).padStart(3, '0')}.${ext}`;
  }

  function getUrlDedupeKey(url) {
    const value = String(url || '').trim();
    if (!value) {
      return '';
    }
    if (/^data:image\//i.test(value)) {
      const commaIndex = value.indexOf(',');
      return commaIndex >= 0 ? `data:${value.slice(commaIndex + 1)}` : `data:${value}`;
    }
    return value;
  }

  function uniqueItems(items) {
    const seen = new Set();
    const result = [];
    for (const item of items || []) {
      const url = item?.url || '';
      const key = getUrlDedupeKey(url);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ url, filename: item.filename || 'image.png' });
    }
    return result;
  }

  function getCurrentImageItems(state) {
    if (state?.canvasSample?.length) {
      return uniqueItems(state.canvasSample.map((url, index) => ({
        url,
        filename: getSafeFilename(state.title, index, url)
      })));
    }
    if (state?.imageUrls?.length) {
      return uniqueItems(state.imageUrls.map((url, index) => ({
        url,
        filename: getSafeFilename(state.title, index, url)
      })));
    }
    return [];
  }

  function getReconstructionPieceKey(piece) {
    return [
      piece?.sourceUrl || '',
      Number(piece?.argCount || 0),
      Number(piece?.sx || 0),
      Number(piece?.sy || 0),
      Number(piece?.sw || 0),
      Number(piece?.sh || 0),
      Number(piece?.dx || 0),
      Number(piece?.dy || 0),
      Number(piece?.dw || 0),
      Number(piece?.dh || 0)
    ].join('|');
  }

  function getNormalizedReconstructionPages(state) {
    const rawPages = Array.isArray(state?.pages) ? state.pages : [];
    if (!rawPages.length) {
      return [];
    }

    const seen = new Set();
    const pages = [];
    for (const page of rawPages) {
      const pieces = Array.isArray(page?.pieces) ? page.pieces : [];
      const key = [
        Number(page?.width || 0),
        Number(page?.height || 0),
        ...pieces.map(getReconstructionPieceKey)
      ].join('::');
      if (!pieces.length || seen.has(key)) {
        continue;
      }
      seen.add(key);
      pages.push(page);
    }

    const limit = Number(state?.slotCount || 0);
    return limit > 0 ? pages.slice(0, limit) : pages;
  }

  function getLiveSaveCount(state) {
    const pages = getNormalizedReconstructionPages(state);
    if (pages.length) {
      return pages.length;
    }

    const items = getCurrentImageItems(state);
    if (items.length) {
      return items.length;
    }

    return 0;
  }

  function refreshSaveButtonLabel(state) {
    if (!isReaderUrl()) {
      document.getElementById(BUTTON_ID)?.remove();
      return 0;
    }
    const count = getLiveSaveCount(state);
    const existingButton = document.getElementById(BUTTON_ID);
    if (count <= 0) {
      countIdleRounds = countLastValue === '0' ? countIdleRounds + 1 : 0;
      countLastValue = '0';
      if (existingButton && !runningButtons.has(existingButton)) {
        existingButton.textContent = LABEL_IDLE;
      }
      return 0;
    }

    const button = existingButton || createUi();
    if (!button || runningButtons.has(button)) {
      return count;
    }
    const text = count > 0 ? `${LABEL_IDLE} (${count})` : LABEL_IDLE;
    countIdleRounds = text === countLastValue ? countIdleRounds + 1 : 0;
    countLastValue = text;
    button.textContent = text;
    return count;
  }

  async function pollSaveCount() {
    let count = 0;
    try {
      const state = await requestState();
      count = refreshSaveButtonLabel(state) || 0;
    } catch (error) {
      console.debug('[mangaraw-rebuilder] save count poll failed', error);
    }

    const shouldContinue = countIdleRounds < 120;
    if (shouldContinue) {
      countPollTimer = window.setTimeout(pollSaveCount, count > 0 ? 1000 : 250);
    } else {
      countPollTimer = 0;
    }
  }

  function startSaveCountPolling() {
    if (countPollTimer) {
      window.clearTimeout(countPollTimer);
      countPollTimer = 0;
    }
    countLastValue = '';
    countIdleRounds = 0;
    pollSaveCount();
  }

  async function handleSaveToFolder(button) {
    const state = await requestState();
    const pages = getNormalizedReconstructionPages(state);

    if (pages.length) {
      setButtonState(button, `Queueing ${pages.length} pages...`, true);
      const response = await chrome.runtime.sendMessage({
        type: 'start-save-job',
        payload: {
          mode: 'reconstructed',
          manifest: { ...state, pages }
        }
      });
      if (!response?.ok) {
        throw new Error(response?.error || 'Save worker launch failed.');
      }
      setButtonState(button, `Folder ${response.count} pages`, true);
      window.setTimeout(() => {
        setButtonState(button, LABEL_IDLE, false);
        startSaveCountPolling();
      }, 1800);
      return;
    }

    const items = getCurrentImageItems(state);
    if (items.length) {
      setButtonState(button, `Queueing ${items.length}...`, true);
      const response = await chrome.runtime.sendMessage({
        type: 'start-save-job',
        payload: {
          mode: 'images',
          items,
          pageUrl: state.location,
          title: state.title
        }
      });
      if (!response?.ok) {
        throw new Error(response?.error || 'Save worker launch failed.');
      }
      setButtonState(button, `Folder ${response.count} items`, true);
      window.setTimeout(() => {
        setButtonState(button, LABEL_IDLE, false);
        startSaveCountPolling();
      }, 1800);
      return;
    }

    throw new Error('No saveable image data was found. Wait for the chapter to finish rendering and retry.');
  }

  function collectDirectoryChapters() {
    const parts = location.pathname.split('/').filter(Boolean);
    const slug = decodeURIComponent(parts[1] || '');
    const seen = new Set();
    const chapters = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      let url;
      try {
        url = new URL(anchor.href, location.href);
      } catch {
        continue;
      }
      const urlParts = url.pathname.split('/').filter(Boolean);
      const candidateSlug = decodeURIComponent(urlParts[1] || '');
      if (url.origin !== location.origin || urlParts.length < 3 || urlParts[0] !== 'manga' || candidateSlug !== slug) {
        continue;
      }
      url.search = '';
      url.hash = '';
      const normalizedUrl = url.href.endsWith('/') ? url.href : `${url.href}/`;
      if (seen.has(normalizedUrl)) {
        continue;
      }
      seen.add(normalizedUrl);
      const fallback = decodeURIComponent(urlParts[urlParts.length - 1]);
      const label = (anchor.textContent || fallback).replace(/\s+/g, ' ').trim() || fallback;
      chapters.push({
        url: normalizedUrl,
        label,
        order: chapters.length + 1
      });
    }
    return chapters.reverse().map((chapter, index) => ({ ...chapter, order: index + 1 }));
  }

  async function handleSaveAll(button, chapters) {
    setButtonState(button, `Queueing ${chapters.length} chapters...`, true);
    const response = await chrome.runtime.sendMessage({
      type: 'start-save-job',
      payload: {
        mode: 'bulk',
        site: 'mangaraw',
        title: getSafeBaseName(document.querySelector('h1')?.textContent || document.title),
        pageUrl: location.href,
        chapters
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Bulk save worker launch failed.');
    }
    setButtonState(button, `Folder ${response.count} chapters`, true);
    window.setTimeout(() => setButtonState(button, `${LABEL_ALL} (${chapters.length})`, false), 1800);
  }

  function createBulkUi() {
    if (!isDirectoryUrl()) {
      return null;
    }
    const existingButton = document.getElementById(ALL_BUTTON_ID);
    if (existingButton) {
      return existingButton;
    }
    const chapters = collectDirectoryChapters();
    if (!chapters.length || !document.body) {
      return null;
    }
    const button = document.createElement('button');
    button.id = ALL_BUTTON_ID;
    button.type = 'button';
    button.textContent = `${LABEL_ALL} (${chapters.length})`;
    button.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'border:none',
      'border-radius:999px',
      'padding:12px 18px',
      'color:#fff',
      'font:700 14px/1 "Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.35)',
      'cursor:pointer',
      'background:linear-gradient(135deg,#c46b16,#8f4b0f)'
    ].join(';');
    button.addEventListener('click', () => {
      if (runningButtons.has(button)) return;
      runningButtons.add(button);
      Promise.resolve(handleSaveAll(button, chapters)).catch((error) => {
        console.error('[mangaraw-bulk-save]', error);
        alert(error instanceof Error ? error.message : String(error));
        setButtonState(button, 'Failed, retry', false);
      }).finally(() => runningButtons.delete(button));
    });
    document.body.appendChild(button);
    return button;
  }

  function createUi() {
    if (!isReaderUrl()) {
      return null;
    }
    const existingButton = document.getElementById(BUTTON_ID);
    if (existingButton) {
      return existingButton;
    }
    if (!document.body) {
      return null;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = LABEL_IDLE;
    button.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'border:none',
      'border-radius:999px',
      'padding:12px 18px',
      'color:#fff',
      'font:700 14px/1 "Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.35)',
      'cursor:pointer',
      'background:linear-gradient(135deg,#c46b16,#8f4b0f)'
    ].join(';');

    button.addEventListener('click', () => {
      if (runningButtons.has(button)) {
        return;
      }
      runningButtons.add(button);
      setButtonState(button, LABEL_BUSY, true);
      Promise.resolve(handleSaveToFolder(button)).catch((error) => {
        console.error('[mangaraw-rebuilder]', error);
        alert(error instanceof Error ? error.message : String(error));
        setButtonState(button, 'Failed, retry', true);
        window.setTimeout(() => {
          setButtonState(button, LABEL_IDLE, false);
          startSaveCountPolling();
        }, 1800);
      }).finally(() => {
        window.setTimeout(() => runningButtons.delete(button), 0);
      });
    });

    document.body.appendChild(button);
    return button;
  }

  function initializePage() {
    if (isReaderUrl()) {
      createUi();
      startSaveCountPolling();
    } else if (isDirectoryUrl()) {
      createBulkUi();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePage, { once: true });
  } else {
    initializePage();
  }
})();
