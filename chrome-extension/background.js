chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'start-save-job') {
    startSaveJob(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
});

async function startSaveJob(payload) {
  if (!payload || (!payload.items && !payload.manifest && !payload.chapters)) {
    throw new Error('No save job payload was provided.');
  }

  const jobId = `raw_image_save_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.local.set({
    [jobId]: {
      ...payload,
      createdAt: new Date().toISOString()
    }
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`save-runner.html#${encodeURIComponent(jobId)}`),
    active: true
  });

  const count = payload.chapters?.length || payload.manifest?.pages?.length || payload.items?.length || 0;
  return { jobId, count };
}
