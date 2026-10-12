/**
 * Minimal, dependency-free tar (ustar) writer used to assemble the DSM 7 SPK.
 *
 * The Synology package format is a plain `tar` archive whose payload members
 * (`INFO`, `conf/`, `scripts/`, icons, `LICENSE`) sit next to a gzipped
 * `package.tgz` holding the application files.
 *
 * Implementing the format here keeps `npm run spk` free of external build
 * dependencies and makes the output byte-for-byte deterministic.
 */

import zlib from 'node:zlib';

const BLOCK_SIZE = 512;

/** @typedef {{ name: string, data: Buffer, mode?: number, mtime?: number, type?: 'file'|'dir' }} TarEntry */

function octal(value, width) {
  // ustar numeric fields are NUL-terminated ASCII octal, zero padded.
  const text = value.toString(8).padStart(width - 1, '0');
  return text + '\0';
}

function header(entry) {
  const { name, mode = 0o644, mtime = 0, type = 'file' } = entry;
  const header = Buffer.alloc(BLOCK_SIZE);

  // name — split into prefix/name when it exceeds 100 bytes.
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) {
    throw new Error(`tar: name too long (${nameBytes.length} > 100): ${name}`);
  }
  nameBytes.copy(header, 0);

  header.write(octal(mode & 0o7777, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii'); // uid
  header.write(octal(0, 8), 116, 'ascii'); // gid
  header.write(octal(entry.data.length, 12), 124, 'ascii');
  header.write(octal(mtime, 12), 136, 'ascii');
  header.write('        ', 148, 'ascii'); // checksum placeholder (spaces)
  header.write(type === 'dir' ? '5' : '0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write('root', 265, 'ascii');
  header.write('root', 297, 'ascii');

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) sum += header[i];
  header.write(octal(sum, 7) + ' ', 148, 'ascii');

  return header;
}

function padding(size) {
  const remainder = size % BLOCK_SIZE;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(BLOCK_SIZE - remainder);
}

/**
 * Build an uncompressed tar archive.
 * @param {TarEntry[]} entries
 * @returns {Buffer}
 */
export function createTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(header(entry));
    if (entry.type !== 'dir' && entry.data.length > 0) {
      chunks.push(entry.data);
      chunks.push(padding(entry.data.length));
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2)); // end-of-archive marker
  return Buffer.concat(chunks);
}

/**
 * Build a gzipped tar archive (used for `package.tgz`).
 * @param {TarEntry[]} entries
 * @returns {Buffer}
 */
export function createTarGz(entries) {
  return zlib.gzipSync(createTar(entries), { level: 9, mtime: 0 });
}
