/**
 * Pack the extension into a ZIP for Chromebook install via Google Drive.
 *
 *   npm run pack   ->  dist/chrome-remote-extension.zip
 *
 * Why ZIP and not CRX: Chrome/ChromeOS refuse to install .crx files that do not come from the
 * Chrome Web Store (unless enterprise-managed). The ZIP is extracted in the ChromeOS Files app and
 * loaded with chrome://extensions -> "Load unpacked". manifest.json sits at the ZIP root.
 *
 * Dependency-free (node:zlib deflate + CRC32) so it runs the same on Windows, macOS and Linux.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist');
// Fixed file name: a re-upload replaces the same Drive file; the version shows in the extension popup.
const OUT_PREFIX = 'chrome-remote-extension';
const OUT_FILE = path.join(OUT_DIR, `${OUT_PREFIX}.zip`);
const VERSION_RE = /CR_VERSION\s*=\s*'(\d+(?:\.\d+)+)'/;

// ---- CRC32 (IEEE) -------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// ---- File listing (sorted, forward-slash paths for the ZIP) --------------
const listFiles = (dir, base = dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? listFiles(full, base) : [full];
    })
    .sort();

const toZipPath = (full) => path.relative(SRC, full).split(path.sep).join('/');

// DOS date/time of "now" (ZIP stores local time with 2-second resolution).
const dosDateTime = (d = new Date()) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

// ---- ZIP writer (local headers + central directory + end record) ---------
const buildZip = (entries) => {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
};

// ---- Main ---------------------------------------------------------------
const main = () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const match = fs.readFileSync(path.join(SRC, 'lib', 'version.js'), 'utf8').match(VERSION_RE);
  if (!match) throw new Error('cannot read CR_VERSION from extension/lib/version.js');
  if (manifest.version !== match[1]) {
    throw new Error(`version mismatch: manifest ${manifest.version} vs version.js ${match[1]} (run npm run bump)`);
  }
  const entries = listFiles(SRC).map((full) => ({ name: toZipPath(full), data: fs.readFileSync(full) }));
  if (!entries.some((e) => e.name === 'manifest.json')) throw new Error('manifest.json missing at ZIP root');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Remove older (versioned) packages so only the current one is left to upload.
  const outFile = OUT_FILE;
  const stale = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.startsWith(OUT_PREFIX) && f.endsWith('.zip') && path.join(OUT_DIR, f) !== outFile);
  stale.forEach((f) => fs.unlinkSync(path.join(OUT_DIR, f)));

  const zip = buildZip(entries);
  fs.writeFileSync(outFile, zip);
  console.log(JSON.stringify({ event: 'pack.done', version: manifest.version, files: entries.length, bytes: zip.length, out: path.relative(ROOT, outFile), removed: stale }));
};

main();
