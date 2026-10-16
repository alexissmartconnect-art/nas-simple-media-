/**
 * File Explorer — browse the NAS / USB folders from the web UI.
 *
 * The admin library modal uses `GET /api/admin/fs?path=...` so a Synology owner
 * never has to type a Linux path by hand: detected volumes (volume1…4,
 * volumeUSB1…4 + their `usbshare*` folders, volumeSATA*, /media, /mnt) show up
 * as quick-access buttons, and every subfolder is listed with the number of
 * media files it directly contains.
 *
 * Read errors are translated into actionable French guidance (usually: the DSM
 * service user `sc-nas-simple-media` is missing the *Read* permission on the
 * shared folder).
 */
import fs from 'fs';
import path from 'path';
import { config, VIDEO_EXTS, AUDIO_EXTS } from '../config';
import { FORBIDDEN_SYSTEM_PREFIXES } from '../libraries/libraries';

/** Folders that never hold user media (Synology metadata, recycle bins, OS junk). */
export const IGNORED_DIR_NAMES = new Set([
  '@eaDir', // DSM thumbnails / media metadata
  '#recycle', // DSM recycle bin
  '@tmp',
  '@appstore',
  '@autoupdate',
  '@database',
  '@quarantine',
  '@synologydrive',
  '@synohdpack',
  '$RECYCLE.BIN', // USB drive formatted on Windows
  'System Volume Information',
  'lost+found',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
]);

export function isIgnoredDirName(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('.')) return true; // hidden files/folders
  return IGNORED_DIR_NAMES.has(name);
}

export type FsRootKind = 'media' | 'volume' | 'usb' | 'sata' | 'mount' | 'library';

export interface FsRoot {
  path: string;
  label: string;
  kind: FsRootKind;
  readable: boolean;
  exists: boolean;
  mediaCount: number;
}

export interface FsEntry {
  name: string;
  path: string;
  mediaCount: number;
  isSymlink: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  roots: FsRoot[];
  dirs: FsEntry[];
  /** media files (video/audio) stored directly in `path` */
  mediaCount: number;
  dirCount: number;
  readable: boolean;
  error: string | null;
  hint: string | null;
  /** true when `path` was (or is) empty and we fell back to MEDIA_PATH */
  fallbackUsed?: boolean;
}

export const DSM_PERMISSION_HELP =
  'Permission refusée (EACCES). Dans DSM : Panneau de configuration → Dossier partagé → ' +
  'sélectionnez le dossier → Modifier → Autorisations → Utilisateur interne du système → ' +
  'accordez « Lecture » (ou « Lecture/Écriture ») à sc-nas-simple-media, puis cochez ' +
  '« Appliquer à ce dossier, aux sous-dossiers et aux fichiers ».';

const STATIC_VOLUME_ROOTS = [
  '/volume1',
  '/volume2',
  '/volume3',
  '/volume4',
  '/volumeUSB1',
  '/volumeUSB2',
  '/volumeUSB3',
  '/volumeUSB4',
  '/volumeSATA1',
  '/volumeSATA2',
  '/volumeSATA3',
  '/volumeSATA4',
  '/media',
  '/mnt',
];

/** Synology mounts USB/SATA shares as `usbshare*` / `satashare*` children. */
const SHARE_DIR_PREFIXES = ['usbshare', 'satashare'];

export function isMediaFileName(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (!ext) return false;
  return VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

function isDirectorySafe(target: string): boolean {
  try {
    const st = fs.statSync(target); // follows symlinks
    return st.isDirectory();
  } catch {
    return false;
  }
}

function hasReadAccess(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Media files (video + audio) directly inside `dir`. */
export function countMediaFiles(dir: string, limit = 5000): number {
  let count = 0;
  const entries = readDirSafe(dir);
  for (const ent of entries) {
    if (count >= limit) break;
    let isFile = ent.isFile();
    if (!isFile && ent.isSymbolicLink()) {
      try {
        isFile = fs.statSync(path.join(dir, ent.name)).isFile();
      } catch {
        isFile = false;
      }
    }
    if (isFile && isMediaFileName(ent.name)) count += 1;
  }
  return count;
}

/** `usbshare1-2` → 1, `usbshare2` → 2, `satashare1-1` → 1, otherwise null. */
export function volumeNumberFromShareName(name: string): number | null {
  for (const prefix of SHARE_DIR_PREFIXES) {
    if (name.startsWith(prefix)) {
      const rest = name.slice(prefix.length);
      const m = /^(\d+)/.exec(rest);
      if (m) return Number(m[1]);
      return 1; // e.g. "usbshare" alone ⇒ first volume
    }
  }
  return null;
}

/**
 * Roots shown as quick-access buttons: MEDIA_PATH first, then every mounted
 * volume / USB share, plus the paths of existing libraries.
 */
export function detectRoots(extraRoots: string[] = []): FsRoot[] {
  const seen = new Set<string>();
  const roots: FsRoot[] = [];

  const push = (raw: string, kind: FsRootKind, label?: string) => {
    if (!raw) return;
    const abs = path.resolve(raw);
    if (seen.has(abs)) return;
    seen.add(abs);
    const exists = isDirectorySafe(abs);
    if (!exists && kind !== 'media' && kind !== 'library') return;
    roots.push({
      path: abs,
      label: label || path.basename(abs) || abs,
      kind,
      exists,
      readable: exists ? hasReadAccess(abs) : false,
      mediaCount: exists && hasReadAccess(abs) ? countMediaFiles(abs) : 0,
    });
  };

  push(config.MEDIA_PATH, 'media', `MEDIA_PATH (${config.MEDIA_PATH})`);

  for (const candidate of STATIC_VOLUME_ROOTS) {
    if (!isDirectorySafe(candidate)) continue;
    const isUsb = candidate.startsWith('/volumeUSB');
    const isSata = candidate.startsWith('/volumeSATA');
    const isVolume = /^\/volume\d+$/.test(candidate);
    const isMount = candidate === '/media' || candidate === '/mnt';
    push(
      candidate,
      isUsb ? 'usb' : isSata ? 'sata' : isMount ? 'mount' : 'volume',
      path.basename(candidate)
    );

    // USB / SATA shares are mounted as children: /volumeUSB1/usbshare1, …
    if ((isUsb || isSata) && hasReadAccess(candidate)) {
      for (const ent of readDirSafe(candidate)) {
        if (!ent.isDirectory()) continue;
        if (isIgnoredDirName(ent.name)) continue;
        if (!SHARE_DIR_PREFIXES.some((p) => ent.name.startsWith(p))) continue;
        push(path.join(candidate, ent.name), isUsb ? 'usb' : 'sata', `${path.basename(candidate)}/${ent.name}`);
      }
    }
  }

  for (const lib of extraRoots) push(lib, 'library', path.basename(lib) || lib);

  return roots;
}

export function isForbiddenSystemPath(abs: string): boolean {
  const resolved = path.resolve(abs);
  for (const prefix of FORBIDDEN_SYSTEM_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) return true;
  }
  return false;
}

export interface FsErrorInfo {
  code: 'EACCES' | 'ENOENT' | 'ENOTDIR' | 'FORBIDDEN' | 'EIO' | 'UNKNOWN';
  error: string;
  hint: string;
}

export function describeFsError(e: unknown, abs: string): FsErrorInfo {
  const code = (e as NodeJS.ErrnoException)?.code || '';
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      code: 'EACCES',
      error: "Accès refusé à ce dossier (l'utilisateur du service n'a pas la permission).",
      hint: DSM_PERMISSION_HELP,
    };
  }
  if (code === 'ENOENT') {
    return {
      code: 'ENOENT',
      error: `Dossier introuvable : ${abs}`,
      hint:
        'Vérifiez que le volume ou le disque USB est bien monté. Sur un NAS Synology, ' +
        'un disque USB apparaît dans /volumeUSB1/usbshare1 (ou /volumeUSB1/usbshare1-2 pour ' +
        'la 2ᵉ partition). Les dossiers partagés sont sous /volume1, /volume2…',
    };
  }
  if (code === 'ENOTDIR') {
    return { code: 'ENOTDIR', error: "Ce chemin n'est pas un dossier.", hint: 'Choisissez un dossier.' };
  }
  return {
    code: 'UNKNOWN',
    error: `Lecture impossible (${code || 'erreur inconnue'}).`,
    hint: DSM_PERMISSION_HELP,
  };
}

const MAX_COUNTED_ENTRIES = 300;

function listSubDirectories(dir: string): FsEntry[] {
  const entries = readDirSafe(dir);
  const dirs: FsEntry[] = [];
  for (const ent of entries) {
    if (isIgnoredDirName(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const symlink = ent.isSymbolicLink();
    if (!ent.isDirectory() && !(symlink && isDirectorySafe(full))) continue;
    dirs.push({
      name: ent.name,
      path: full,
      isSymlink: symlink,
      mediaCount: dirs.length < MAX_COUNTED_ENTRIES ? countMediaFiles(full) : 0,
    });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }));
  return dirs;
}

/**
 * List the subfolders of an absolute directory with a media counter, the
 * detected roots, and the read status / help message.
 */
export function listServerDirectory(rawPath?: string, extraRoots: string[] = []): FsListing {
  const requested = String(rawPath ?? '').trim();
  const fallback = path.resolve(config.MEDIA_PATH);
  const provided = requested.replace(/\\/g, '/').replace(/\/+$/, '');

  let abs: string;
  let fallbackUsed = false;
  if (!provided) {
    abs = fallback;
    fallbackUsed = true;
  } else if (!path.isAbsolute(provided)) {
    throw new Error('Chemin absolu requis (ex. /volume1/video ou /volumeUSB1/usbshare1)');
  } else {
    abs = path.resolve(provided);
  }

  const roots = detectRoots(extraRoots).slice(0, 60);

  const parent = abs === path.parse(abs).root ? null : path.dirname(abs);
  const base: FsListing = {
    path: abs,
    parent,
    roots,
    dirs: [],
    mediaCount: 0,
    dirCount: 0,
    readable: false,
    error: null,
    hint: null,
    ...(fallbackUsed ? { fallbackUsed: true } : {}),
  };

  if (isForbiddenSystemPath(abs) || abs === config.DATA_PATH || abs.startsWith(config.DATA_PATH + path.sep)) {
    return {
      ...base,
      error: 'Chemin système interdit (dossier du système ou données internes de l’application).',
      hint: 'Choisissez un dossier partagé du NAS (ex. /volume1/video) ou un disque USB (ex. /volumeUSB1/usbshare1).',
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    const info = describeFsError(e, abs);
    return { ...base, error: info.error, hint: info.hint };
  }
  if (!stat.isDirectory()) {
    return {
      ...base,
      error: "Ce chemin n'est pas un dossier.",
      hint: 'Choisissez un dossier, par exemple /volume1/video ou /volumeUSB1/usbshare1.',
    };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    const info = describeFsError(e, abs);
    return { ...base, error: info.error, hint: info.hint };
  }

  let mediaCount = 0;
  for (const ent of entries) {
    if (ent.isFile() && isMediaFileName(ent.name)) mediaCount += 1;
  }

  return {
    ...base,
    dirs: listSubDirectories(abs),
    mediaCount,
    dirCount: entries.filter((e) => e.isDirectory()).length,
    readable: true,
    error: null,
    hint: null,
  };
}
