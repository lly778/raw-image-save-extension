const DOWNLOAD_CONCURRENCY = 4;
const HOTLINK_RULE_ID = 1001;
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const pickButton = document.getElementById('pick');
let pendingJob = null;

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
  appendStatus('This step needs one direct click in this page before Chrome will allow choosing a folder.');
  appendStatus('Click "Choose Folder And Continue" below.');

  pickButton.hidden = false;
  pickButton.focus();
  pickButton.addEventListener('click', () => tryStartSave(), { once: true });
}

function appendStatus(text) {
  statusEl.textContent += `\n${text}`;
}

async function tryStartSave() {
  if (!pendingJob) return;
  pickButton.disabled = true;

  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    pickButton.hidden = true;
    appendStatus('Folder selected. Saving files...');
    await runSaveJob(pendingJob.job, dirHandle);
    appendStatus('Done. You can close this tab.');
    await chrome.storage.local.remove(pendingJob.jobId).catch(() => {});
    pendingJob = null;
  } catch (error) {
    pickButton.disabled = false;
    appendStatus(`Folder selection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runSaveJob(job, dirHandle) {
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

async function fetchSourceBitmaps(pages, pageUrl) {
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

  const result = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const current = urls[cursor++];
      const response = await fetchWithHotlinkHeaders(current, pageUrl);
      const blob = await response.blob();
      result.set(current, await createImageBitmap(blob));
    }
  }
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, urls.length) }, () => worker());
  await Promise.all(workers);
  return result;
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

async function fetchWithHotlinkHeaders(url, pageUrl) {
  return withTemporaryHotlinkRule(pageUrl, async () => {
    const response = await fetch(url, { credentials: 'include' });
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
