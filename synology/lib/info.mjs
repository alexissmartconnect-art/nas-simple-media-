/**
 * Reader/writer for the Synology package `INFO` file.
 *
 * Format: one `key="value"` pair per line. Values are quoted in practice, so
 * the parser strips a single layer of surrounding quotes — getting this wrong
 * silently corrupts the package name, version and dependency list.
 *
 * Shared by the SPK builder and the packaging tests so both can never drift.
 */

import fs from 'node:fs';

/**
 * @param {string} text raw INFO contents
 * @returns {Map<string, string>}
 */
export function parseInfo(text) {
  const fields = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    fields.set(key, value);
  }
  return fields;
}

/**
 * @param {string} filePath
 * @returns {Map<string, string>}
 */
export function readInfoFile(filePath) {
  return parseInfo(fs.readFileSync(filePath, 'utf8'));
}

/**
 * @param {Map<string, string>} fields
 * @returns {string}
 */
export function serializeInfo(fields) {
  return `${[...fields.entries()].map(([k, v]) => `${k}="${v}"`).join('\n')}\n`;
}

/** DSM 7 makes these fields mandatory; a package without them will not install. */
export const DSM7_REQUIRED_FIELDS = [
  'package',
  'version',
  'os_min_ver',
  'description',
  'arch',
  'maintainer',
];

/**
 * Compare two DSM version strings of the form `major.minor-build`.
 * @returns {number} negative when a < b, positive when a > b, 0 when equal
 */
export function compareDsmVersion(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)(?:-(\d+))?$/.exec(String(v).trim());
    if (!m) throw new Error(`invalid DSM version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  };
  const [aMaj, aMin, aBuild] = parse(a);
  const [bMaj, bMin, bBuild] = parse(b);
  return aMaj - bMaj || aMin - bMin || aBuild - bBuild;
}
