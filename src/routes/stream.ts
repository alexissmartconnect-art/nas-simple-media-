import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import mime from 'mime-types';
import { config } from '../config';
import { listAllLibraries, resolveLibraryPath } from '../libraries/libraries';

function pipeFileSafe(
  absPath: string,
  res: Response,
  rangeOpts?: { start: number; end: number }
): void {
  const stream = fs.createReadStream(absPath, rangeOpts);
  const cleanup = () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  };
  res.on('close', cleanup);
  stream.on('error', () => {
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream read error' });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

export function streamFile(
  absPath: string,
  req: Request,
  res: Response,
  opts?: { download?: boolean; filename?: string }
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const size = stat.size;
  const contentType = opts?.download
    ? 'application/octet-stream'
    : mime.lookup(absPath) || 'application/octet-stream';
  const range = req.headers.range;
  const downloadName = opts?.filename || path.basename(absPath);

  // Plex-like caching: ETag + Last-Modified allow players to resume / revalidate
  // seeks cheaply instead of re-downloading.
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified);

  // Caching preconditions
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && !opts?.download && !range) {
    const tags = String(ifNoneMatch).split(',').map((t) => t.trim());
    if (tags.includes('*') || tags.includes(etag)) {
      res.status(304).end();
      return;
    }
  }
  // If-Range: stale entity → ignore Range and send the full file (RFC 7233)
  const ifRange = req.headers['if-range'];
  let effectiveRange = range;
  if (ifRange && range) {
    const v = String(ifRange).trim();
    if (v !== etag && v !== lastModified && v !== '*') {
      effectiveRange = undefined;
    }
  }
  if (opts?.download) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
  }

  if (!effectiveRange) {
    res.setHeader('Content-Length', size);
    res.status(200);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    pipeFileSafe(absPath, res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(effectiveRange);
  if (!m || (!m[1] && !m[2])) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  let start: number;
  let end: number;
  if (!m[1] && m[2]) {
    // Suffix byte-range-spec: bytes=-500 (last 500 bytes)
    const suffixLength = parseInt(m[2], 10);
    if (Number.isNaN(suffixLength) || suffixLength <= 0 || size === 0) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : size - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }
  end = Math.min(end, size - 1);
  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', chunkSize);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeFileSafe(absPath, res, { start, end });
}

function isUnderRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Ensure absolute file path is under MEDIA_PATH or an enabled library path, and never in DATA_PATH. */
export function isPathAllowed(absPath: string): boolean {
  if (!absPath || !path.isAbsolute(absPath)) return false;
  const resolved = path.resolve(absPath);
  const dataRoot = path.resolve(config.DATA_PATH);
  if (isUnderRoot(resolved, dataRoot)) return false;

  let real = resolved;
  try {
    if (fs.existsSync(resolved)) {
      real = fs.realpathSync(resolved);
    }
  } catch {
    return false;
  }
  if (isUnderRoot(real, dataRoot)) return false;

  const mediaRoot = path.resolve(config.MEDIA_PATH);
  let realMediaRoot = mediaRoot;
  try {
    if (fs.existsSync(mediaRoot)) realMediaRoot = fs.realpathSync(mediaRoot);
  } catch {}

  if (isUnderRoot(resolved, mediaRoot) && isUnderRoot(real, realMediaRoot)) {
    return true;
  }

  try {
    const libs = listAllLibraries().filter((l) => l.enabled);
    for (const lib of libs) {
      const libRoot = resolveLibraryPath(lib.path);
      let realLibRoot = libRoot;
      try {
        if (fs.existsSync(libRoot)) realLibRoot = fs.realpathSync(libRoot);
      } catch {}
      if (isUnderRoot(resolved, libRoot) && isUnderRoot(real, realLibRoot)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}
