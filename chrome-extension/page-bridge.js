(() => {
  const observedImageUrls = new Set();
  const observedCanvasEntries = [];
  const drawImageLogs = [];
  const canvasExportErrors = [];
  let canvasIdCounter = 1;

  function normalizeImageUrl(url) {
    if (typeof url !== 'string') return null;
    const value = url.trim();
    if (!value) return null;
    if (
      value.startsWith('data:image/') ||
      value.startsWith('blob:') ||
      value.startsWith('http://') ||
      value.startsWith('https://')
    ) {
      return value;
    }
    try {
      return new URL(value, location.href).href;
    } catch {
      return null;
    }
  }

  function getUrlDedupeKey(url) {
    const value = normalizeImageUrl(url);
    if (!value) return '';
    if (/^data:image\//i.test(value)) {
      const commaIndex = value.indexOf(',');
      return commaIndex >= 0 ? `data:${value.slice(commaIndex + 1)}` : `data:${value}`;
    }
    return value;
  }

  function isLikelyChapterImage(url) {
    if (!url) return false;
    if (url.startsWith('data:image/') || url.startsWith('blob:')) return true;
    if (/img-cdn\.stackpathcdn\.app\/public\/key\/\?id=/i.test(url)) return true;
    if (/\/public\/key\/\?id=/i.test(url)) return true;
    if (/\/images\/logo\.png(?:$|[?#])/i.test(url)) return false;
    if (/\.(js|css|json|txt|html?)(?:$|[?#])/i.test(url)) return false;
    if (/\.(jpg|jpeg|png|webp|gif|bmp|avif)(?:$|[?#])/i.test(url)) return true;
    return false;
  }

  function rememberObservedUrl(url) {
    const normalized = normalizeImageUrl(url);
    if (normalized && isLikelyChapterImage(normalized)) {
      observedImageUrls.add(normalized);
    }
  }

  function getCanvasDebugId(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return '';
    if (!canvas.dataset.codexCanvasId) {
      canvas.dataset.codexCanvasId = `canvas-${canvasIdCounter++}`;
    }
    return canvas.dataset.codexCanvasId;
  }

  function getCanvasSlotIndex(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return Number.MAX_SAFE_INTEGER;
    return Number(canvas.closest('.cz[data-i]')?.getAttribute('data-i') ?? Number.MAX_SAFE_INTEGER);
  }

  function getReaderRoot() {
    return document.querySelector('.chapter-comic') ||
      document.querySelector('.chapter-main') ||
      document.querySelector('#cchapter') ||
      document.body;
  }

  function getChapterSlots(root) {
    return [...root.querySelectorAll('.cz[data-i]')]
      .sort((a, b) => Number(a.getAttribute('data-i')) - Number(b.getAttribute('data-i')));
  }

  function uniqueUrls(urls) {
    const seen = new Set();
    const result = [];
    for (const url of urls) {
      const key = getUrlDedupeKey(url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(normalizeImageUrl(url));
    }
    return result.filter(Boolean);
  }

  function uniqueCanvasElements(root) {
    const set = new Set();
    [...root.querySelectorAll('canvas'), ...observedCanvasEntries].forEach((canvas) => {
      if (canvas instanceof HTMLCanvasElement) {
        getCanvasDebugId(canvas);
        set.add(canvas);
      }
    });
    return [...set];
  }

  function collectCanvasExportState(root) {
    const urls = [];
    const errors = [];
    uniqueCanvasElements(root)
      .sort((a, b) => {
        const ai = Number(a.closest('.cz')?.getAttribute('data-i') ?? Number.MAX_SAFE_INTEGER);
        const bi = Number(b.closest('.cz')?.getAttribute('data-i') ?? Number.MAX_SAFE_INTEGER);
        return ai - bi;
      })
      .forEach((canvas) => {
        const canvasId = getCanvasDebugId(canvas);
        try {
          if (canvas.width > 0 && canvas.height > 0) {
            urls.push(canvas.toDataURL('image/png'));
          } else {
            errors.push({
              canvasId,
              width: canvas.width,
              height: canvas.height,
              message: 'Canvas has no drawable size.'
            });
          }
        } catch (error) {
          errors.push({
            canvasId,
            width: canvas.width,
            height: canvas.height,
            message: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          });
        }
      });
    canvasExportErrors.length = 0;
    canvasExportErrors.push(...errors);
    return { urls, errors };
  }

  function pickBestImageFromSlot(slot) {
    const images = [...slot.querySelectorAll('img')].reverse();
    for (const img of images) {
      const normalized = normalizeImageUrl(img.currentSrc || img.src || img.getAttribute('src') || '');
      if (isLikelyChapterImage(normalized)) {
        return normalized;
      }
    }
    return null;
  }

  function collectSlotImageUrls(root) {
    const slots = getChapterSlots(root);
    const urls = [];
    let loadedSlotCount = 0;

    for (const slot of slots) {
      const chosen = pickBestImageFromSlot(slot);
      if (chosen) {
        urls.push(chosen);
        loadedSlotCount += 1;
      }
    }

    return {
      urls: uniqueUrls(urls),
      slotCount: slots.length,
      loadedSlotCount
    };
  }

  function extractCanvasOrder(canvasId) {
    const match = String(canvasId || '').match(/canvas-(\d+)/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function getPagePieceKey(piece) {
    return [
      piece.sourceUrl || '',
      Number(piece.argCount || 0),
      Number(piece.sx || 0),
      Number(piece.sy || 0),
      Number(piece.sw || 0),
      Number(piece.sh || 0),
      Number(piece.dx || 0),
      Number(piece.dy || 0),
      Number(piece.dw || 0),
      Number(piece.dh || 0)
    ].join('|');
  }

  function buildReconstructionPages() {
    const candidates = new Map();

    for (const log of drawImageLogs) {
      if (!log.sourceUrl || log.sourceUrl.startsWith('[')) continue;
      const slotIndex = Number(log.slotIndex ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isFinite(slotIndex) || slotIndex === Number.MAX_SAFE_INTEGER) continue;

      const key = `${slotIndex}::${log.canvasId}`;
      if (!candidates.has(key)) {
        candidates.set(key, {
          slotIndex,
          canvasId: log.canvasId,
          width: log.canvasWidth || 0,
          height: log.canvasHeight || 0,
          pieces: []
        });
      }

      candidates.get(key).pieces.push({
        sourceUrl: log.sourceUrl,
        argCount: log.argCount,
        sx: Number(log.sx ?? 0),
        sy: Number(log.sy ?? 0),
        sw: Number(log.sw ?? 0),
        sh: Number(log.sh ?? 0),
        dx: Number(log.dx ?? 0),
        dy: Number(log.dy ?? 0),
        dw: Number(log.dw ?? 0),
        dh: Number(log.dh ?? 0)
      });
    }

    const perSlot = new Map();
    for (const page of candidates.values()) {
      if (page.width <= 0 || page.height <= 0 || !page.pieces.length) continue;
      const uniquePieceCount = new Set(page.pieces.map(getPagePieceKey)).size;
      const score = (uniquePieceCount * 1000000) + (page.width * page.height);
      const current = perSlot.get(page.slotIndex);
      if (!current || score > current.score || (score === current.score && extractCanvasOrder(page.canvasId) > extractCanvasOrder(current.page.canvasId))) {
        perSlot.set(page.slotIndex, { page, score });
      }
    }

    return [...perSlot.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1].page);
  }

  function buildState() {
    const root = getReaderRoot();
    const canvasState = collectCanvasExportState(root);
    const slotState = collectSlotImageUrls(root);
    const imageUrls = slotState.urls.length ? slotState.urls : uniqueUrls([...observedImageUrls]).filter(isLikelyChapterImage);
    const renderedUrls = uniqueUrls([
      ...canvasState.urls,
      ...imageUrls
    ]).filter(isLikelyChapterImage);

    return {
      exportedAt: new Date().toISOString(),
      location: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      readerRoot: root.className || root.id || root.tagName,
      slotCount: slotState.slotCount,
      loadedSlotCount: slotState.loadedSlotCount,
      renderedCount: renderedUrls.length,
      observedCount: observedImageUrls.size,
      observedCanvasCount: uniqueCanvasElements(root).length,
      drawImageLogCount: drawImageLogs.length,
      bestSource: canvasState.urls.length ? 'canvas' : 'rendered',
      bestCount: renderedUrls.length,
      canvasSample: canvasState.urls.slice(0, 10),
      canvasExportErrors: canvasState.errors.slice(0, 20),
      reconstructionPageCount: buildReconstructionPages().length,
      imageUrlCount: imageUrls.length,
      observedSample: [...observedImageUrls].slice(0, 10),
      drawImageSample: drawImageLogs.slice(-15),
      pages: buildReconstructionPages(),
      imageUrls,
      renderedUrls
    };
  }

  const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imgSrc && imgSrc.configurable) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get() {
        return imgSrc.get.call(this);
      },
      set(value) {
        rememberObservedUrl(value);
        return imgSrc.set.call(this, value);
      }
    });
  }

  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof name === 'string' && /^(src|data-src|data-lazy-src|data-original|data-url)$/i.test(name)) {
      rememberObservedUrl(value);
    }
    return originalSetAttribute.call(this, name, value);
  };

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url;
    rememberObservedUrl(url || '');
    return originalFetch.apply(this, args);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    rememberObservedUrl(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    try {
      const source = args[0];
      let sourceUrl = '';
      if (source instanceof HTMLImageElement) {
        sourceUrl = source.currentSrc || source.src || '';
      } else if (source instanceof HTMLCanvasElement) {
        sourceUrl = '[canvas-source]';
      } else if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
        sourceUrl = '[image-bitmap]';
      }

      const canvasId = getCanvasDebugId(this.canvas);
      if (this.canvas instanceof HTMLCanvasElement) {
        this.canvas.dataset.codexCanvasId = canvasId;
      }

      const entry = {
        time: Date.now(),
        canvasId,
        slotIndex: getCanvasSlotIndex(this.canvas),
        sourceUrl: normalizeImageUrl(sourceUrl) || sourceUrl,
        argCount: args.length,
        canvasWidth: this.canvas?.width || 0,
        canvasHeight: this.canvas?.height || 0
      };

      if (args.length === 3) {
        entry.dx = Number(args[1] ?? 0);
        entry.dy = Number(args[2] ?? 0);
      } else if (args.length === 5) {
        entry.dx = Number(args[1] ?? 0);
        entry.dy = Number(args[2] ?? 0);
        entry.dw = Number(args[3] ?? 0);
        entry.dh = Number(args[4] ?? 0);
      } else if (args.length >= 9) {
        entry.sx = Number(args[1] ?? 0);
        entry.sy = Number(args[2] ?? 0);
        entry.sw = Number(args[3] ?? 0);
        entry.sh = Number(args[4] ?? 0);
        entry.dx = Number(args[5] ?? 0);
        entry.dy = Number(args[6] ?? 0);
        entry.dw = Number(args[7] ?? 0);
        entry.dh = Number(args[8] ?? 0);
      }

      rememberObservedUrl(sourceUrl);
      drawImageLogs.push(entry);
      if (this.canvas && this.canvas.width > 0 && this.canvas.height > 0) {
        observedCanvasEntries.push(this.canvas);
      }
    } catch (error) {
      console.debug('[mangaraw-rebuilder:page] drawImage hook failed', error);
    }
    return originalDrawImage.apply(this, args);
  };

  document.addEventListener('codex-mangaraw-command', (event) => {
    const detail = event.detail || {};
    if (detail.type !== 'get-state') return;
    document.dispatchEvent(new CustomEvent('codex-mangaraw-response', {
      detail: {
        requestId: detail.requestId,
        payload: buildState()
      }
    }));
  });
})();

