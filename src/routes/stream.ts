import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import mime from 'mime-types';
import { config } from '../config';

export function streamFile(absPath: string, req: Request, res: Response, opts?: { download?: boolean; filename?: string }): void {
  if (!fs.existsSync(absPath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const stat = fs.statSync(absPath);
  const size = stat.size;
  const contentType = opts?.download
    ? 'application/octet-stream'
    : mime.lookup(absPath) || 'application/octet-stream';
  const range = req.headers.range;
  const downloadName = opts?.filename || path.basename(absPath);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (opts?.download) {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  }

  if (!range) {
    res.setHeader('Content-Length', size);
    res.status(200);
    fs.createReadStream(absPath).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }
  end = Math.min(end, size - 1);
  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', chunkSize);
  fs.createReadStream(absPath, { start, end }).pipe(res);
}

/** Ensure absolute file path is under MEDIA_PATH or an absolute library path we already stored. */
export function isPathAllowed(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const mediaRoot = path.resolve(config.MEDIA_PATH);
  if (resolved.startsWith(mediaRoot + path.sep) || resolved === mediaRoot) return true;
  // Absolute library paths outside MEDIA_PATH are allowed if the file exists and was indexed
  return path.isAbsolute(resolved) && fs.existsSync(resolved);
}
