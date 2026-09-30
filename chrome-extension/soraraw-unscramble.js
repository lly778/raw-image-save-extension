// Soraraw's canva2 reader restores an 8x8 tile shuffle with its own WASM.
// The bundled soraraw.wasm comes from https://soraraw.com/soraraw.wasm.
let sorarawDecoderPromise;

async function getSorarawDecoder() {
  if (!sorarawDecoderPromise) {
    sorarawDecoderPromise = (async () => {
      const response = await fetch(chrome.runtime.getURL('soraraw.wasm'));
      if (!response.ok) throw new Error(`Soraraw image decoder failed with HTTP ${response.status}.`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      const decoder = instance.exports;
      if (!decoder.memory || !decoder.malloc || !decoder.free || !decoder.unscramble) {
        throw new Error('Soraraw image decoder has missing exports.');
      }
      return decoder;
    })().catch((error) => {
      sorarawDecoderPromise = null;
      throw error;
    });
  }
  return sorarawDecoderPromise;
}

async function prepareSorarawImage(blob, item) {
  if (item.chapterMode !== 'canva2') return blob;
  if (!item.chapterId) throw new Error('Soraraw chapter ID is missing for image restoration.');

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!context) {
    bitmap.close();
    throw new Error('Failed to create a canvas for Soraraw image restoration.');
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const decoder = await getSorarawDecoder();
  const chapterBytes = new TextEncoder().encode(String(item.chapterId));
  const pixelsPointer = decoder.malloc(image.data.byteLength);
  const chapterPointer = decoder.malloc(chapterBytes.length + 1);
  if (!pixelsPointer || !chapterPointer) {
    if (chapterPointer) decoder.free(chapterPointer);
    if (pixelsPointer) decoder.free(pixelsPointer);
    throw new Error('Soraraw image decoder ran out of memory.');
  }
  try {
    let memory = new Uint8Array(decoder.memory.buffer);
    memory.set(image.data, pixelsPointer);
    memory.set(chapterBytes, chapterPointer);
    memory[chapterPointer + chapterBytes.length] = 0;
    const result = decoder.unscramble(pixelsPointer, canvas.width, canvas.height, 4, 8, chapterPointer);
    if (result !== 0) throw new Error(`Soraraw image restoration failed (${result}).`);
    memory = new Uint8Array(decoder.memory.buffer);
    image.data.set(memory.subarray(pixelsPointer, pixelsPointer + image.data.byteLength));
  } finally {
    decoder.free(chapterPointer);
    decoder.free(pixelsPointer);
  }
  context.putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
