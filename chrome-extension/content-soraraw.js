(function () {
  'use strict';

  const BUTTON_ID = 'codex-soraraw-save-folder';
  const ALL_BUTTON_ID = 'codex-soraraw-save-all';
  const LABEL_IDLE = 'Save To Folder';
  const LABEL_ALL = 'Download Chapters';
  const LABEL_BUSY = 'Preparing...';
  const API_IMAGE = 'https://api.mangarawgo.site';
  const IMAGE_LIST_KEY = '/fuCkYou!!!';
  const IMAGE_PATH_SECRET = '202508055d0db38bae2e86cc41649f90';

  let capturedNextData = null;
  let capturedNextDataUrl = '';
  let running = false;
  let lastObservedPageKey = '';
  let countPollTimer = 0;
  let countPollRequestId = 0;

  function getPageKey() {
    return `${location.origin}${location.pathname}`;
  }

  function isReaderUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length >= 3 && parts[0] === 'manga' && /^ch-[^/]+$/i.test(parts[2]);
  }

  function isDirectoryUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 'manga';
  }

  function captureNextDataFromNode(node) {
    if (!node || node.id !== '__NEXT_DATA__' || capturedNextData) {
      return;
    }
    try {
      capturedNextData = JSON.parse(node.textContent || '{}');
      capturedNextDataUrl = getPageKey();
    } catch (error) {
      console.warn('[soraraw-save] Failed to parse __NEXT_DATA__', error);
    }
  }

  function resetCapturedNextData() {
    capturedNextData = null;
    capturedNextDataUrl = '';
    captureNextDataFromNode(document.getElementById('__NEXT_DATA__'));
  }

  function handleRouteChange() {
    const currentPageKey = getPageKey();
    if (currentPageKey === lastObservedPageKey) {
      return;
    }
    lastObservedPageKey = currentPageKey;
    removeUi();
    window.setTimeout(() => {
      resetCapturedNextData();
      initializePage();
    }, 0);
  }

  function watchRouteChanges() {
    const notify = () => {
      window.setTimeout(handleRouteChange, 0);
    };
    lastObservedPageKey = getPageKey();
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      notify();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      notify();
      return result;
    };
    window.addEventListener('popstate', notify);
    window.setInterval(handleRouteChange, 250);
  }

  function startNextDataCapture() {
    captureNextDataFromNode(document.getElementById('__NEXT_DATA__'));
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            captureNextDataFromNode(node);
            const nested = node.querySelector?.('#__NEXT_DATA__');
            captureNextDataFromNode(nested);
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 15000);
  }

  async function fetchNextDataForCurrentUrl() {
    const response = await fetch(location.href, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to load current chapter metadata with HTTP ${response.status}.`);
    }
    const html = await response.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) {
      throw new Error('Current chapter metadata was not found in the page HTML.');
    }
    capturedNextData = JSON.parse(match[1]);
    capturedNextDataUrl = getPageKey();
  }

  function getSafeBaseName(title) {
    return String(title || 'soraraw')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'soraraw';
  }

  async function getChapterData() {
    if (!capturedNextData || capturedNextDataUrl !== getPageKey()) {
      await fetchNextDataForCurrentUrl();
    }
    const data = capturedNextData?.props?.pageProps?.data;
    const chapter = data?.chapter;
    if (!chapter?.id || !chapter?.manga?.id) {
      throw new Error('Chapter metadata was not found. Refresh the page and retry.');
    }
    return { data, chapter };
  }

  async function getDirectoryData() {
    if (!capturedNextData || capturedNextDataUrl !== getPageKey()) {
      await fetchNextDataForCurrentUrl();
    }
    const data = capturedNextData?.props?.pageProps?.data;
    const manga = data?.manga;
    if (!manga?.id || !Array.isArray(manga?.chapters)) {
      throw new Error('Manga chapter list was not found. Refresh the page and retry.');
    }
    return { data, manga };
  }

  function normalizeBase(base, fallback) {
    return String(base || fallback || '').replace(/\/+$/, '');
  }

  function getImageBase(chapter, serverKey) {
    const fallback = `https://lh${Number(chapter.id) % 4 + 1}.rawcontent.top`;
    if (serverKey === 'd') return normalizeBase(chapter._d, fallback);
    if (serverKey === 't') return normalizeBase(chapter._t, fallback);
    if (serverKey === 'p') return normalizeBase(chapter._p, fallback);
    return normalizeBase(chapter._b, fallback);
  }

  function base64UrlToBytes(value) {
    let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/').trim();
    text = text.padEnd(text.length + (4 - text.length % 4) % 4, '=');
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function textToBytes(value) {
    return new TextEncoder().encode(String(value || ''));
  }

  function xorBytes(bytes, keyBytes) {
    if (!keyBytes.length) {
      return bytes;
    }
    const output = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      output[index] = bytes[index] ^ keyBytes[index % keyBytes.length];
    }
    return output;
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(clean)) {
      throw new Error('Invalid chapter uuid for image URL decoding.');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  async function decryptAesCtr(cipherBytes, keyHex) {
    const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'AES-CTR' }, false, ['decrypt']);
    const counter = cipherBytes.slice(0, 16);
    const body = cipherBytes.slice(16);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, key, body);
    return new TextDecoder().decode(plain);
  }

  function decryptImageList(value) {
    const raw = base64UrlToBytes(value);
    const plainBytes = xorBytes(raw, textToBytes(IMAGE_LIST_KEY));
    const text = new TextDecoder().decode(plainBytes).replace(/^\uFEFF/, '').replace(/\u0000/g, '').trim();
    return JSON.parse(text);
  }

  async function decodeImagePath(encodedPath, uuid) {
    const raw = base64UrlToBytes(encodedPath);
    const cipherBytes = xorBytes(raw, textToBytes(IMAGE_PATH_SECRET));
    return decryptAesCtr(cipherBytes, uuid);
  }

  async function fetchChapterImages(chapter) {
    const timestamp = Date.parse(chapter.updated_at || chapter.published_at || '') || Date.now();
    const url = `${API_IMAGE}/${chapter.manga.id}/${chapter.id}.json?t=${timestamp}`;
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
    if (!response.ok) {
      throw new Error(`Image API failed with HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (!payload?.d) {
      throw new Error('Image API response did not contain the encrypted image list.');
    }
    const images = decryptImageList(payload.d);
    if (!Array.isArray(images) || !images.length) {
      throw new Error('No chapter images were returned.');
    }
    return images;
  }

  function pickServerKey(image) {
    if (image?.b) return 'b';
    if (image?.d) return 'd';
    if (image?.t) return 't';
    if (image?.p) return 'p';
    return '';
  }

  function getFilename(title, image, index, url) {
    const extMatch = String(url || '').match(/\.(jpg|jpeg|png|webp|gif|bmp|avif)(?:$|[?#])/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'webp';
    const order = Number(image?.order || index + 1);
    return `${getSafeBaseName(title)} - ${String(order).padStart(3, '0')}.${ext}`;
  }

  async function buildDownloadItems() {
    const { chapter } = await getChapterData();
    const images = await fetchChapterImages(chapter);
    const title = `${chapter.manga?.name || 'soraraw'} ${chapter.name || chapter.title || chapter.order || ''}`.trim();
    const sorted = [...images].sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));
    const items = [];

    for (let index = 0; index < sorted.length; index += 1) {
      const image = sorted[index];
      const serverKey = pickServerKey(image);
      if (!serverKey) {
        continue;
      }
      const encodedPath = image[serverKey];
      const path = String(encodedPath).startsWith('http')
        ? encodedPath
        : await decodeImagePath(encodedPath, chapter.uuid);
      const url = path.startsWith('http') ? path : `${getImageBase(chapter, serverKey)}/${path.replace(/^\/+/, '')}`;
      items.push({
        url,
        order: Number(image?.order || index + 1),
        filename: getFilename(title, image, index, url)
      });
    }

    if (!items.length) {
      throw new Error('No downloadable image URLs could be decoded.');
    }

    return {
      title: getSafeBaseName(title),
      pageUrl: location.href,
      site: 'soraraw',
      items
    };
  }

  function setButtonState(button, text, disabled) {
    button.textContent = text;
    button.disabled = disabled;
  }

  function removeUi() {
    if (running) {
      return;
    }
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(ALL_BUTTON_ID)?.remove();
    window.clearTimeout(countPollTimer);
    countPollTimer = 0;
  }

  async function pollImageCount() {
    if (!isReaderUrl()) {
      countPollTimer = 0;
      return;
    }

    const requestId = ++countPollRequestId;
    try {
      const { chapter } = await getChapterData();
      const images = await fetchChapterImages(chapter);
      if (requestId !== countPollRequestId || !isReaderUrl()) {
        return;
      }
      const button = createUi();
      if (button && Array.isArray(images) && images.length > 0 && !running) {
        button.textContent = `${LABEL_IDLE} (${images.length})`;
      }
    } catch (error) {
      console.debug('[soraraw-save] image count poll failed', error);
    }

    countPollTimer = window.setTimeout(pollImageCount, 3000);
  }

  function startCountPolling() {
    window.clearTimeout(countPollTimer);
    countPollTimer = window.setTimeout(pollImageCount, 100);
  }

  async function handleSave(button) {
    const job = await buildDownloadItems();
    setButtonState(button, `Queueing ${job.items.length}...`, true);
    const response = await chrome.runtime.sendMessage({
      type: 'start-save-job',
      payload: {
        mode: 'images',
        ...job
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Save worker launch failed.');
    }
    setButtonState(button, `Folder ${response.count} items`, true);
    window.setTimeout(() => {
      setButtonState(button, `${LABEL_IDLE} (${job.items.length})`, false);
    }, 1800);
  }

  async function buildBulkJob() {
    const { manga } = await getDirectoryData();
    const chapters = manga.chapters
      .filter((chapter) => chapter?.path && chapter?.mode !== 'spoiler')
      .map((chapter) => {
        const rawLabel = chapter.name ?? chapter.title ?? chapter.order ?? chapter.id;
        return {
          url: `${location.origin}/manga/${manga.slug}/${String(chapter.path).replace(`${manga.slug}-`, '')}`,
          label: `Chapter ${rawLabel}`,
          order: Number(chapter.order ?? chapter.name ?? 0)
        };
      })
      .sort((a, b) => Number(a.order) - Number(b.order) || a.label.localeCompare(b.label, undefined, { numeric: true }));
    if (!chapters.length) {
      throw new Error('No downloadable chapters were found.');
    }
    return {
      mode: 'bulk',
      site: 'soraraw',
      title: getSafeBaseName(manga.name || document.title),
      pageUrl: location.href,
      chapters
    };
  }

  async function handleSaveAll(button) {
    setButtonState(button, 'Preparing chapters...', true);
    const job = await buildBulkJob();
    setButtonState(button, `Queueing ${job.chapters.length} chapters...`, true);
    const response = await chrome.runtime.sendMessage({ type: 'start-save-job', payload: job });
    if (!response?.ok) {
      throw new Error(response?.error || 'Bulk save worker launch failed.');
    }
    setButtonState(button, `Folder ${response.count} chapters`, true);
    window.setTimeout(() => setButtonState(button, `${LABEL_ALL} (${job.chapters.length})`, false), 1800);
  }

  async function createBulkUi() {
    if (!isDirectoryUrl()) {
      return null;
    }
    const existingButton = document.getElementById(ALL_BUTTON_ID);
    if (existingButton) {
      return existingButton;
    }
    if (!document.body) {
      return null;
    }
    let chapterCount = 0;
    try {
      const { manga } = await getDirectoryData();
      chapterCount = manga.chapters.filter((chapter) => chapter?.path && chapter?.mode !== 'spoiler').length;
    } catch (error) {
      console.debug('[soraraw-bulk-save] chapter count failed', error);
    }
    const button = document.createElement('button');
    button.id = ALL_BUTTON_ID;
    button.type = 'button';
    button.textContent = chapterCount > 0 ? `${LABEL_ALL} (${chapterCount})` : LABEL_ALL;
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
      'background:linear-gradient(135deg,#0ea5a4,#0f766e)'
    ].join(';');
    button.addEventListener('click', () => {
      if (running) return;
      running = true;
      Promise.resolve(handleSaveAll(button)).catch((error) => {
        console.error('[soraraw-bulk-save]', error);
        alert(error instanceof Error ? error.message : String(error));
        setButtonState(button, 'Failed, retry', false);
      }).finally(() => {
        running = false;
      });
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
      'background:linear-gradient(135deg,#0ea5a4,#0f766e)'
    ].join(';');

    button.addEventListener('click', () => {
      if (running) {
        return;
      }
      running = true;
      setButtonState(button, LABEL_BUSY, true);
      Promise.resolve(handleSave(button)).catch((error) => {
        console.error('[soraraw-save]', error);
        alert(error instanceof Error ? error.message : String(error));
        setButtonState(button, 'Failed, retry', true);
        window.setTimeout(() => setButtonState(button, LABEL_IDLE, false), 1800);
      }).finally(() => {
        running = false;
      });
    });

    document.body.appendChild(button);
    return button;
  }

  function initializePage() {
    if (isReaderUrl()) {
      createUi();
      startCountPolling();
    } else if (isDirectoryUrl()) {
      createBulkUi();
    }
  }

  startNextDataCapture();
  watchRouteChanges();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePage, { once: true });
  } else {
    initializePage();
  }
})();
