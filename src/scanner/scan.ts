import fs from 'fs';
import path from 'path';
import { config, type LibraryKind } from '../config';
import { getDb, type LibraryRow } from '../db/schema';
import { isMediaFile, parseMediaFile } from './heuristics';
import { listAllLibraries, resolveLibraryPath } from '../libraries/libraries';

export interface ScanResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  libraries: number;
  errors: string[];
}

function walkDir(dir: string, base: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(full, base, out);
    else if (ent.isFile() && isMediaFile(ent.name)) out.push(path.relative(base, full));
  }
}

function scanOneLibrary(lib: LibraryRow, result: ScanResult): void {
  const db = getDb();
  const root = resolveLibraryPath(lib.path);
  if (!fs.existsSync(root)) {
    result.errors.push(`Bibliothèque "${lib.name}": chemin introuvable (${root})`);
    return;
  }

  const files: string[] = [];
  walkDir(root, root, files);
  const seen = new Set<string>();
  const kind = lib.type as LibraryKind;

  const upsert = db.prepare(`
    INSERT INTO media_items (
      library_id, path, rel_path, filename, title, type, kind,
      show_name, season, episode, artist, album, track_num,
      size_bytes, mtime, updated_at
    ) VALUES (
      @library_id, @path, @rel_path, @filename, @title, @type, @kind,
      @show_name, @season, @episode, @artist, @album, @track_num,
      @size_bytes, @mtime, datetime('now')
    )
    ON CONFLICT(library_id, rel_path) DO UPDATE SET
      path=excluded.path,
      filename=excluded.filename,
      title=excluded.title,
      type=excluded.type,
      kind=excluded.kind,
      show_name=excluded.show_name,
      season=excluded.season,
      episode=excluded.episode,
      artist=excluded.artist,
      album=excluded.album,
      track_num=excluded.track_num,
      size_bytes=excluded.size_bytes,
      mtime=excluded.mtime,
      updated_at=datetime('now')
  `);

  const getExisting = db.prepare(
    `SELECT id, mtime, size_bytes FROM media_items WHERE library_id = ? AND rel_path = ?`
  );

  for (const rel of files) {
    result.scanned++;
    const abs = path.join(root, rel);
    const norm = rel.split(path.sep).join('/');
    seen.add(norm);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      result.errors.push(`stat failed: ${lib.name}/${norm}`);
      continue;
    }

    const parsed = parseMediaFile(norm, kind);
    if (!parsed) continue;

    const existing = getExisting.get(lib.id, norm) as
      | { id: number; mtime: number; size_bytes: number }
      | undefined;

    const payload = {
      library_id: lib.id,
      path: abs,
      rel_path: norm,
      filename: path.basename(norm),
      title: parsed.title,
      type: parsed.type,
      kind,
      show_name: parsed.show_name,
      season: parsed.season,
      episode: parsed.episode,
      artist: parsed.artist,
      album: parsed.album,
      track_num: parsed.track_num,
      size_bytes: stat.size,
      mtime: Math.floor(stat.mtimeMs),
    };

    upsert.run(payload);
    if (!existing) result.added++;
    else if (existing.mtime !== payload.mtime || existing.size_bytes !== payload.size_bytes) {
      result.updated++;
    }
  }

  const all = db
    .prepare(`SELECT id, rel_path FROM media_items WHERE library_id = ?`)
    .all(lib.id) as { id: number; rel_path: string }[];
  const del = db.prepare(`DELETE FROM media_items WHERE id = ?`);
  for (const row of all) {
    if (!seen.has(row.rel_path)) {
      del.run(row.id);
      result.removed++;
    }
  }
}

export function scanLibrary(libraryId?: number): ScanResult {
  const result: ScanResult = {
    scanned: 0,
    added: 0,
    updated: 0,
    removed: 0,
    libraries: 0,
    errors: [],
  };

  const libs = libraryId
    ? listAllLibraries().filter((l) => l.id === libraryId)
    : listAllLibraries().filter((l) => l.enabled);

  const db = getDb();
  const tx = db.transaction(() => {
    for (const lib of libs) {
      result.libraries++;
      scanOneLibrary(lib, result);
    }
    db.prepare(
      `INSERT INTO scan_meta(key,value) VALUES('last_scan', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(new Date().toISOString());
  });
  tx();
  return result;
}

let watchTimer: NodeJS.Timeout | null = null;
let watching = false;

export function startFileWatch(debounceMs = 5000): void {
  if (watching) return;
  watching = true;
  const root = config.MEDIA_PATH;
  try {
    fs.watch(root, { recursive: true }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try {
          scanLibrary();
        } catch {
          /* ignore */
        }
      }, debounceMs);
    });
  } catch {
    /* ignore */
  }
}
