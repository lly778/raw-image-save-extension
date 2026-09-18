const DOWNLOAD_CONCURRENCY = 4;
const HOTLINK_RULE_ID = 1001;
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const pickButton = document.getElementById('pick');
const cancelButton = document.getElementById('cancel');
const chapterSelector = document.getElementById('chapter-selector');
const chapterList = document.getElementById('chapter-list');
const chapterSearch = document.getElementById('chapter-search');
const selectedCount = document.getElementById('selected-count');
const selectAllButton = document.getElementById('select-all');
const clearAllButton = document.getElementById('clear-all');
const changeFolderButton = document.getElementById('change-folder');
let pendingJob = null;
let abortController = null;
let lastChapterSelectionIndex = null;
let selectedDirectoryHandle = null;
let storedJobRemoved = false;

main().catch((error) => appendStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`));

async function main() {
  const jobId = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!jobId) throw new Error('Missing save job id.');
  const stored = await chrome.storage.local.get(jobId);
  const job = stored[jobId];
  if (!job) throw new Error('Save job was not found.');
  pendingJob = { jobId, job };
  metaEl.textContent = `${job.title || job.manifest?.title || 'Raw Images'} · ${job.mode || 'save'} job`;

  appendStatus('Job loaded.');
  if (job.mode === 'bulk') {
    setupChapterSelector(job.chapters);
    appendStatus('Choose the chapters to download, then choose a folder.');
  }
  appendStatus('This step needs one direct click in this page before Chrome will allow choosing a folder.');
  appendStatus(job.mode === 'bulk' ? 'Use the download button below when ready.' : 'Click "Choose Folder And Continue" below.');

  pickButton.hidden = false;
  pickButton.focus();
  pickButton.addEventListener('click', () => tryStartSave());
  changeFolderButton.addEventListener('click', () => chooseNewDirectory());
}

function appendStatus(text) {
  statusEl.textContent += `\n${text}`;
}

async function tryStartSave() {
  if (!pendingJob || pickButton.disabled) return;
  pickButton.disabled = true;

  try {
    const job = getSelectedJob(pendingJob.job);
    setChapterSelectorDisabled(true);
    changeFolderButton.hidden = true;
    if (!selectedDirectoryHandle) {
      selectedDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    }
    pickButton.hidden = true;
    cancelButton.hidden = false;
    cancelButton.disabled = false;
    abortController = new AbortController();
    cancelButton.onclick = () => {
      cancelButton.disabled = true;
      abortController.abort();
      appendStatus('Cancel requested. Finishing the current file...');
    };
    appendStatus('Folder selected. Saving files...');
    const result = await runSaveJob(job, selectedDirectoryHandle, abortController.signal);
    cancelButton.hidden = true;
    if (job.mode === 'bulk') {
      clearCompletedChapterSelections(result?.completedSequences || []);
      setChapterSelectorDisabled(false);
      pickButton.hidden = false;
      changeFolderButton.hidden = false;
      appendStatus('Batch finished. Choose more chapters to continue, or close this tab.');
      if (!storedJobRemoved) {
        await chrome.storage.local.remove(pendingJob.jobId).catch(() => {});
        storedJobRemoved = true;
      }
    } else {
      appendStatus('Done. You can close this tab.');
      await chrome.storage.local.remove(pendingJob.jobId).catch(() => {});
      pendingJob = null;
    }
  } catch (error) {
    pickButton.hidden = false;
    cancelButton.hidden = true;
    setChapterSelectorDisabled(false);
    changeFolderButton.hidden = !selectedDirectoryHandle || chapterSelector.hidden;
    if (chapterSelector.hidden) {
      pickButton.disabled = false;
    } else {
      updateSelectedChapterCount();
    }
    const message = error instanceof Error ? error.message : String(error);
    appendStatus(error?.name === 'AbortError' ? 'Canceled.' : `Save failed: ${message}`);
  }
}

async function chooseNewDirectory() {
  if (!pendingJob || changeFolderButton.disabled) return;
  changeFolderButton.disabled = true;
  try {
    selectedDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    appendStatus('Destination folder changed.');
    updateSelectedChapterCount();
  } catch (error) {
    if (error?.name !== 'AbortError') {
      appendStatus(`Folder selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    changeFolderButton.disabled = false;
  }
}

function setupChapterSelector(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) throw new Error('No chapters were provided.');
  chapterSelector.hidden = false;
  const fragment = document.createDocumentFragment();
  list.forEach((chapter, index) => {
    const label = document.createElement('label');
    label.className = 'chapter-option';
    label.dataset.search = `${chapter.label || ''} ${chapter.url || ''}`.toLocaleLowerCase();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    checkbox.addEventListener('click', (event) => handleChapterCheckboxClick(event, index));
    checkbox.addEventListener('change', updateSelectedChapterCount);
    const text = document.createElement('span');
    text.textContent = chapter.label || `Chapter ${index + 1}`;
    label.append(checkbox, text);
    fragment.appendChild(label);
  });
  chapterList.replaceChildren(fragment);
  chapterSearch.addEventListener('input', filterChapterList);
  selectAllButton.addEventListener('click', () => setAllChaptersSelected(true));
  clearAllButton.addEventListener('click', () => setAllChaptersSelected(false));
  updateSelectedChapterCount();
}

function getChapterCheckboxes() {
  return [...chapterList.querySelectorAll('input[type="checkbox"]')];
}

function updateSelectedChapterCount() {
  const checkboxes = getChapterCheckboxes();
  const count = checkboxes.filter((checkbox) => checkbox.checked).length;
  selectedCount.textContent = `${count} / ${checkboxes.length} selected`;
  pickButton.textContent = count
    ? selectedDirectoryHandle ? `Download ${count} Selected` : `Choose Folder And Download ${count}`
    : 'Choose At Least One Chapter';
  pickButton.disabled = count === 0;
}

function handleChapterCheckboxClick(event, index) {
  const checkbox = event.currentTarget;
  if (event.shiftKey && lastChapterSelectionIndex !== null) {
    const checkboxes = getChapterCheckboxes();
    const start = Math.min(lastChapterSelectionIndex, index);
    const end = Math.max(lastChapterSelectionIndex, index);
    for (let current = start; current <= end; current += 1) {
      checkboxes[current].checked = checkbox.checked;
    }
  }
  lastChapterSelectionIndex = index;
  updateSelectedChapterCount();
}

function setAllChaptersSelected(checked) {
  for (const checkbox of getChapterCheckboxes()) checkbox.checked = checked;
  lastChapterSelectionIndex = null;
  updateSelectedChapterCount();
}

function clearCompletedChapterSelections(sequences) {
  const completed = new Set(sequences.map(Number));
  for (const checkbox of getChapterCheckboxes()) {
    if (completed.has(Number(checkbox.dataset.index) + 1)) checkbox.checked = false;
  }
  lastChapterSelectionIndex = null;
  updateSelectedChapterCount();
}

function filterChapterList() {
  const query = chapterSearch.value.trim().toLocaleLowerCase();
  for (const option of chapterList.querySelectorAll('.chapter-option')) {
    option.hidden = Boolean(query) && !option.dataset.search.includes(query);
  }
}

function setChapterSelectorDisabled(disabled) {
  if (chapterSelector.hidden) return;
  chapterSearch.disabled = disabled;
  selectAllButton.disabled = disabled;
  clearAllButton.disabled = disabled;
  for (const checkbox of getChapterCheckboxes()) checkbox.disabled = disabled;
}

function getSelectedJob(job) {
  if (job.mode !== 'bulk') return job;
  const chapters = getChapterCheckboxes()
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => {
      const index = Number(checkbox.dataset.index);
      return { ...job.chapters[index], sequence: index + 1 };
    });
  if (!chapters.length) throw new Error('Choose at least one chapter.');
  return { ...job, chapters, totalChapterCount: job.chapters.length };
}

async function runSaveJob(job, dirHandle, signal) {
  if (job.mode === 'bulk') {
    return saveBulk(job, dirHandle, signal);
  }
  if (job.mode === 'reconstructed') {
    await saveReconstructed(job.manifest, dirHandle);
    return;
  }
  await saveImages(job, dirHandle);
}

async function saveImages(job, dirHandle) {
  const items = dedupeDownloadItems(job.items);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    appendStatus(`Saving ${index + 1}/${items.length}...`);
    const response = await fetchImage(item.url, job);
    if (!response.ok) throw new Error(`fetch failed with HTTP ${response.status}`);
    const blob = await response.blob();
    await writeFile(dirHandle, flattenFilename(item.filename || `image-${index + 1}.png`), blob);
  }
}

async function saveBulk(job, dirHandle, signal) {
  const chapters = Array.isArray(job.chapters) ? job.chapters : [];
  if (!chapters.length) throw new Error('No chapters were provided.');
  const failures = [];
  const completedSequences = [];
  const sequenceWidth = Math.max(4, String(job.totalChapterCount || chapters.length).length);

  for (let index = 0; index < chapters.length; index += 1) {
    throwIfAborted(signal);
    const chapter = chapters[index];
    const sequence = Number(chapter.sequence || index + 1);
    const prefix = `${String(sequence).padStart(sequenceWidth, '0')} - ${sanitizeFilenamePart(chapter.label || `Chapter ${sequence}`)}`;
    appendStatus(`Chapter ${index + 1}/${chapters.length}: ${chapter.label || chapter.url}`);
    try {
      if (job.site === 'soraraw') {
        const items = await getSorarawChapterItems(chapter.url, signal);
        await saveBulkItems(items, dirHandle, prefix, 'soraraw', chapter.url, signal);
      } else if (job.site === 'mangaraw') {
        const capture = await collectMangarawChapterState(chapter.url, signal);
        try {
          const pages = normalizeMangarawPages(capture.state);
          if (pages.length) {
            await saveBulkReconstructed(pages, dirHandle, prefix, capture.state.location || chapter.url, signal);
          } else {
            const items = getMangarawImageItems(capture.state);
            if (!items.length) throw new Error('No complete image data was captured.');
            await saveBulkItems(items, dirHandle, prefix, 'mangaraw', capture.state.location || chapter.url, signal);
          }
        } finally {
          await chrome.tabs.remove(capture.tabId).catch(() => {});
        }
      } else {
        throw new Error(`Unsupported bulk site: ${job.site}`);
      }
      completedSequences.push(sequence);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${chapter.label || chapter.url}: ${message}`);
      appendStatus(`  Failed: ${message}`);
    }
  }

  appendStatus(`Bulk result: ${chapters.length - failures.length} succeeded, ${failures.length} failed.`);
  if (failures.length) {
    appendStatus(`Failed chapters:\n${failures.join('\n')}`);
  }
  return { completedSequences, failedCount: failures.length };
}

async function saveBulkItems(items, dirHandle, prefix, site, pageUrl, signal) {
  for (let index = 0; index < items.length; index += 1) {
    throwIfAborted(signal);
    const item = items[index];
    const ext = getImageExtension(item.url, item.filename);
    const filename = `${prefix} - ${String(index + 1).padStart(3, '0')}.${ext}`;
    const response = site === 'soraraw'
      ? await fetch(item.url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal })
      : await fetchWithHotlinkHeaders(item.url, pageUrl, signal);
    if (!response.ok) throw new Error(`fetch failed with HTTP ${response.status}`);
    await writeFile(dirHandle, filename, await response.blob());
  }
}

async function saveBulkReconstructed(pages, dirHandle, prefix, pageUrl, signal) {
  const sourceMap = await fetchSourceBitmaps(pages, pageUrl, signal);
  for (let index = 0; index < pages.length; index += 1) {
    throwIfAborted(signal);
    const blob = await renderReconstructedPage(pages[index], sourceMap);
    await writeFile(dirHandle, `${prefix} - ${String(index + 1).padStart(3, '0')}.png`, blob);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
}

function sanitizeFilenamePart(value) {
  return String(value || 'chapter')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'chapter';
}

function getImageExtension(url, filename) {
  const dataMatch = String(url || '').match(/^data:image\/(jpeg|png|webp|gif|bmp|avif)[;,]/i);
  if (dataMatch) return dataMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : dataMatch[1].toLowerCase();
  const match = String(url || filename || '').match(/\.(jpg|jpeg|png|webp|gif|bmp|avif)(?:$|[?#])/i);
  if (!match) return 'webp';
  return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
}

async function getSorarawChapterItems(chapterUrl, signal) {
  const response = await fetch(chapterUrl, { cache: 'no-store', credentials: 'include', signal });
  if (!response.ok) throw new Error(`chapter page failed with HTTP ${response.status}`);
  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Chapter metadata was not found.');
  const data = JSON.parse(match[1]);
  const chapter = data?.props?.pageProps?.data?.chapter;
  if (!chapter?.id || !chapter?.manga?.id || !chapter?.uuid) throw new Error('Chapter metadata is incomplete.');

  const timestamp = Date.parse(chapter.updated_at || chapter.published_at || '') || Date.now();
  const manifestResponse = await fetch(`https://api.mangarawgo.site/${chapter.manga.id}/${chapter.id}.json?t=${timestamp}`, {
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal
  });
  if (!manifestResponse.ok) throw new Error(`image manifest failed with HTTP ${manifestResponse.status}`);
  const payload = await manifestResponse.json();
  const images = decryptSorarawImageList(payload?.d);
  const sorted = [...images].sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));
  const items = [];
  for (const image of sorted) {
    throwIfAborted(signal);
    const serverKey = image?.b ? 'b' : image?.d ? 'd' : image?.t ? 't' : image?.p ? 'p' : '';
    if (!serverKey) continue;
    const encodedPath = image[serverKey];
    const path = String(encodedPath).startsWith('http')
      ? encodedPath
      : await decodeSorarawImagePath(encodedPath, chapter.uuid);
    const base = getSorarawImageBase(chapter, serverKey);
    items.push({ url: path.startsWith('http') ? path : `${base}/${path.replace(/^\/+/, '')}` });
  }
  if (!items.length) throw new Error('No downloadable images were decoded.');
  return items;
}

function getSorarawImageBase(chapter, serverKey) {
  const fallback = `https://lh${Number(chapter.id) % 4 + 1}.rawcontent.top`;
  const selected = serverKey === 'd' ? chapter._d : serverKey === 't' ? chapter._t : serverKey === 'p' ? chapter._p : chapter._b;
  return String(selected || fallback).replace(/\/+$/, '');
}

function base64UrlToBytes(value) {
  let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/').trim();
  text = text.padEnd(text.length + (4 - text.length % 4) % 4, '=');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function xorBytes(bytes, keyBytes) {
  const output = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) output[index] = bytes[index] ^ keyBytes[index % keyBytes.length];
  return output;
}

function decryptSorarawImageList(value) {
  if (!value) throw new Error('Encrypted image manifest is missing.');
  const plain = xorBytes(base64UrlToBytes(value), new TextEncoder().encode('/fuCkYou!!!'));
  const text = new TextDecoder().decode(plain).replace(/^\uFEFF/, '').replace(/\u0000/g, '').trim();
  const images = JSON.parse(text);
  if (!Array.isArray(images) || !images.length) throw new Error('Image manifest is empty.');
  return images;
}

function hexToBytes(hex) {
  const clean = String(hex || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(clean)) throw new Error('Invalid chapter UUID.');
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function decodeSorarawImagePath(value, uuid) {
  const encrypted = xorBytes(base64UrlToBytes(value), new TextEncoder().encode('202508055d0db38bae2e86cc41649f90'));
  const key = await crypto.subtle.importKey('raw', hexToBytes(uuid), { name: 'AES-CTR' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: encrypted.slice(0, 16), length: 64 }, key, encrypted.slice(16));
  return new TextDecoder().decode(plain);
}

async function collectMangarawChapterState(chapterUrl, signal) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: chapterUrl, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error('Failed to create chapter tab.');
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    await waitForTabComplete(tabId, signal);
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass > 0) {
        await chrome.tabs.reload(tabId);
        await waitForTabComplete(tabId, signal);
      }
      let lastCount = -1;
      let stableRounds = 0;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        throwIfAborted(signal);
        try {
          const response = await chrome.tabs.sendMessage(tabId, { type: 'collect-mangaraw-state' });
          if (response?.ok && response.state) {
            const state = response.state;
            const pages = normalizeMangarawPages(state);
            const items = getMangarawImageItems(state);
            const count = pages.length || items.length;
            const target = Number(state.slotCount || 0);
            stableRounds = count > 0 && count === lastCount ? stableRounds + 1 : 0;
            lastCount = count;
            const complete = target > 0 ? count >= target : stableRounds >= 2;
            if (count > 0 && complete) return { state, tabId };
          }
        } catch {
          // The content script may not be ready immediately after tab completion.
        }
        await delay(1000, signal);
      }
    }
    throw new Error('Timed out waiting for MangaRaw images to render.');
  } catch (error) {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    throw error;
  }
}

async function waitForTabComplete(tabId, signal) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('Chapter tab load timed out.')), 30000);
    const onAbort = () => finish(new DOMException('Download aborted', 'AbortError'));
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    function finish(error) {
      window.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Download aborted', 'AbortError'));
    }, { once: true });
  });
}

function normalizeMangarawPages(state) {
  const pages = [];
  const seen = new Set();
  for (const page of state?.pages || []) {
    const pieces = Array.isArray(page?.pieces) ? page.pieces : [];
    const key = JSON.stringify([Number(page?.width || 0), Number(page?.height || 0), pieces]);
    if (!pieces.length || seen.has(key)) continue;
    seen.add(key);
    pages.push(page);
  }
  const limit = Number(state?.slotCount || 0);
  return limit > 0 ? pages.slice(0, limit) : pages;
}

function getMangarawImageItems(state) {
  const urls = Array.isArray(state?.imageUrls) ? state.imageUrls : [];
  const seen = new Set();
  return urls.filter((url) => {
    const value = String(url || '').trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  }).map((url) => ({ url }));
}

async function saveReconstructed(manifest, dirHandle) {
  const pages = Array.isArray(manifest?.pages) ? manifest.pages : [];
  if (!pages.length) throw new Error('No reconstruction pages were provided.');
  const sourceMap = await fetchSourceBitmaps(pages, manifest.location);
  for (let index = 0; index < pages.length; index += 1) {
    appendStatus(`Saving ${index + 1}/${pages.length}...`);
    const blob = await renderReconstructedPage(pages[index], sourceMap);
    await writeFile(dirHandle, flattenFilename(buildOutputFilename(manifest.title, index)), blob);
  }
}

async function writeFile(dirHandle, filename, blob) {
  const handle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function flattenFilename(filename) {
  return String(filename || 'image.png').split('/').pop() || 'image.png';
}

function dedupeDownloadItems(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({ url, filename: item.filename || 'image.png' });
  }
  return result;
}

async function fetchSourceBitmaps(pages, pageUrl, signal) {
  const urls = [];
  const seen = new Set();
  pages.forEach((page) => {
    page.pieces.forEach((piece) => {
      if (piece?.sourceUrl && !seen.has(piece.sourceUrl)) {
        seen.add(piece.sourceUrl);
        urls.push(piece.sourceUrl);
      }
    });
  });

  return withTemporaryHotlinkRule(pageUrl, async () => {
    const result = new Map();
    let cursor = 0;
    async function worker() {
      while (cursor < urls.length) {
        throwIfAborted(signal);
        const current = urls[cursor++];
        const response = await fetch(current, { credentials: 'include', signal });
        if (!response.ok) throw new Error(`fetch failed with HTTP ${response.status}`);
        const blob = await response.blob();
        result.set(current, await createImageBitmap(blob));
      }
    }
    const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, urls.length) }, () => worker());
    await Promise.all(workers);
    return result;
  });
}

async function renderReconstructedPage(page, sourceMap) {
  const canvas = new OffscreenCanvas(page.width, page.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to create canvas context.');
  for (const piece of page.pieces) {
    const bitmap = sourceMap.get(piece.sourceUrl);
    if (!bitmap) throw new Error(`Missing source bitmap for ${piece.sourceUrl}`);
    drawPiece(context, bitmap, piece);
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

function drawPiece(context, bitmap, piece) {
  const argCount = Number(piece.argCount || 0);
  if (argCount >= 9) {
    context.drawImage(bitmap, Number(piece.sx || 0), Number(piece.sy || 0), Number(piece.sw || 0), Number(piece.sh || 0), Number(piece.dx || 0), Number(piece.dy || 0), Number(piece.dw || 0), Number(piece.dh || 0));
    return;
  }
  if (argCount === 5) {
    context.drawImage(bitmap, Number(piece.dx || 0), Number(piece.dy || 0), Number(piece.dw || bitmap.width), Number(piece.dh || bitmap.height));
    return;
  }
  context.drawImage(bitmap, Number(piece.dx || 0), Number(piece.dy || 0));
}

async function fetchImage(url, job) {
  if (job.site === 'soraraw') {
    return fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
  }
  return fetchWithHotlinkHeaders(url, job.pageUrl);
}

async function fetchWithHotlinkHeaders(url, pageUrl, signal) {
  return withTemporaryHotlinkRule(pageUrl, async () => {
    const response = await fetch(url, { credentials: 'include', signal });
    if (!response.ok) throw new Error(`fetch failed with HTTP ${response.status}`);
    return response;
  });
}

async function withTemporaryHotlinkRule(pageUrl, fn) {
  const referer = pageUrl || 'https://mangaraw.ac/';
  const origin = new URL(referer).origin;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [HOTLINK_RULE_ID],
    addRules: [{
      id: HOTLINK_RULE_ID,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'referer', operation: 'set', value: referer },
        { header: 'origin', operation: 'set', value: origin }
      ]},
      condition: { requestDomains: ['img-cdn.stackpathcdn.app'], resourceTypes: ['xmlhttprequest'] }
    }]
  });
  try {
    return await fn();
  } finally {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [HOTLINK_RULE_ID] });
  }
}

function buildOutputFilename(title, index) {
  const safeTitle = buildArchiveBaseName(title);
  return `${safeTitle} - ${String(index + 1).padStart(3, '0')}.png`;
}

function buildArchiveBaseName(title) {
  return String(title || 'mangaraw').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'mangaraw';
}
