// A streaming, uncompressed ZIP writer. Images are already compressed, so storing
// them directly avoids holding the entire chapter in memory.
const ZIP_MAX_SIZE = 0xffffffff;
const ZIP_ENCODER = new TextEncoder();
const ZIP_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

async function createZipWriter(dirHandle, filename) {
  const handle = await dirHandle.getFileHandle(filename, { create: true });
  const output = await handle.createWritable();
  const entries = [];
  let offset = 0;

  async function write(bytes) {
    const size = bytes.byteLength ?? bytes.size;
    if (offset + size > ZIP_MAX_SIZE) throw new Error('Chapter ZIP exceeds the 4 GB ZIP limit.');
    await output.write(bytes);
    offset += size;
  }

  return {
    async addFile(name, blob, signal) {
      if (entries.length >= 0xffff) throw new Error('Chapter ZIP has too many images.');
      if (blob.size > ZIP_MAX_SIZE) throw new Error('An image exceeds the 4 GB ZIP limit.');
      const nameBytes = ZIP_ENCODER.encode(name);
      if (nameBytes.length > 0xffff) throw new Error('An image filename is too long for ZIP.');
      const localOffset = offset;
      const header = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0808, true); // UTF-8 filenames and trailing data descriptor.
      view.setUint16(10, 0, true);
      view.setUint16(12, 0x0021, true); // 1980-01-01.
      view.setUint16(26, nameBytes.length, true);
      header.set(nameBytes, 30);
      await write(header);

      let crc = 0xffffffff;
      const reader = blob.stream().getReader();
      try {
        while (true) {
          if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
          const { done, value } = await reader.read();
          if (done) break;
          for (const byte of value) crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
          await write(value);
        }
      } finally {
        reader.releaseLock();
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = new Uint8Array(16);
      const descriptorView = new DataView(descriptor.buffer);
      descriptorView.setUint32(0, 0x08074b50, true);
      descriptorView.setUint32(4, crc, true);
      descriptorView.setUint32(8, blob.size, true);
      descriptorView.setUint32(12, blob.size, true);
      await write(descriptor);
      entries.push({ nameBytes, localOffset, size: blob.size, crc });
    },

    async close() {
      const centralOffset = offset;
      for (const entry of entries) {
        const header = new Uint8Array(46 + entry.nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 0x0808, true);
        view.setUint16(12, 0, true);
        view.setUint16(14, 0x0021, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.size, true);
        view.setUint32(24, entry.size, true);
        view.setUint16(28, entry.nameBytes.length, true);
        view.setUint32(42, entry.localOffset, true);
        header.set(entry.nameBytes, 46);
        await write(header);
      }
      const centralSize = offset - centralOffset;
      const end = new Uint8Array(22);
      const view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, entries.length, true);
      view.setUint16(10, entries.length, true);
      view.setUint32(12, centralSize, true);
      view.setUint32(16, centralOffset, true);
      await write(end);
      await output.close();
    },

    abort() {
      return output.abort();
    }
  };
}
