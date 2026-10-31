/**
 * Bump the app version everywhere it appears, from the single source extension/lib/version.js.
 *
 *   npm run bump            -> 1.0.N  becomes 1.0.(N+1)
 *   npm run bump -- 1.2.0   -> set an explicit version
 *
 * Updates: extension/lib/version.js, extension/manifest.json ("version"), and every
 * `?v=<version>` cache-busting parameter in remote/index.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = Object.freeze({
  version: path.join(ROOT, 'extension', 'lib', 'version.js'),
  manifest: path.join(ROOT, 'extension', 'manifest.json'),
  remoteHtml: path.join(ROOT, 'remote', 'index.html'),
});
const VERSION_RE = /CR_VERSION\s*=\s*'(\d+)\.(\d+)\.(\d+)'/;
// Chrome manifest versions: 1-4 dot-separated integers, each 0..65535.
const VALID_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

const read = (file) => fs.readFileSync(file, 'utf8');

const nextVersion = (current, explicit) => {
  if (explicit) return explicit;
  const [major, minor, build] = current;
  return `${major}.${minor}.${Number(build) + 1}`;
};

const main = () => {
  const source = read(FILES.version);
  const match = source.match(VERSION_RE);
  if (!match) throw new Error(`cannot find CR_VERSION in ${FILES.version}`);
  const previous = match.slice(1).join('.');
  const version = nextVersion(match.slice(1), process.argv[2]);
  if (!VALID_RE.test(version)) throw new Error(`invalid version "${version}" (expected X.Y.Z)`);

  fs.writeFileSync(FILES.version, source.replace(VERSION_RE, `CR_VERSION = '${version}'`));

  const manifest = JSON.parse(read(FILES.manifest));
  manifest.version = version;
  fs.writeFileSync(FILES.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

  const html = read(FILES.remoteHtml);
  const busted = html.replace(/\?v=[0-9.]+/g, `?v=${version}`);
  fs.writeFileSync(FILES.remoteHtml, busted);

  const count = (html.match(/\?v=[0-9.]+/g) || []).length;
  console.log(JSON.stringify({ event: 'version.bumped', from: previous, to: version, cache_bust_refs: count }));
};

main();
