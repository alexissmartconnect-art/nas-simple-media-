/**
 * Bundle a static ffmpeg + ffprobe for the Synology SPK.
 *
 * Why: the native package should work immediately after installation, even on
 * a DSM without the SynoCommunity repository (where `ffmpeg6` lives).  The two
 * npm packages below ship self-contained Linux x86-64 (geminilake) binaries:
 *
 *   @ffmpeg-installer/linux-x64   4.1.0   ffmpeg 4.1 static (johnvansickle)
 *   @ffprobe-installer/linux-x64  5.2.0   ffprobe 5.2 static (johnvansickle)
 *
 * They are pinned by version *and* SHA-256 so a compromised/republished
 * tarball cannot silently end up inside a release.  The binaries are copied
 * unmodified into `app/bin/`; the GPL-3.0 text and the corresponding-source
 * notice are shipped alongside them.
 *
 * If ffmpeg6 from SynoCommunity is installed, run.sh prefers it and these
 * binaries are only a fallback (older codec set, no QSV/VAAPI).
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_DIR = path.resolve(HERE, '..', 'licenses');

/** @type {Array<{pkg: string, version: string, file: string, tarballSha256: string, sha256: string, label: string}>} */
const BINARIES = [
  {
    pkg: '@ffmpeg-installer/linux-x64',
    version: '4.1.0',
    file: 'ffmpeg',
    tarballSha256: 'b836abe532912ae6c3388dbe713952af293a3d005fc9e4d34d52f14da99dda71',
    sha256: '6d0c625dbd3f604ed2618981ba6fee7e29678855ab741d654cfc9effb0226624',
    label: 'FFmpeg 4.1 static (GPL-3.0)',
  },
  {
    pkg: '@ffprobe-installer/linux-x64',
    version: '5.2.0',
    file: 'ffprobe',
    tarballSha256: '8b6b2e34bad5ea7cfbe1914185145f514f620f24203a1a421e8d00a698bf8e61',
    sha256: '576c21674291ec1948d507ea8ab0d78eb6621a0be8c6f1a6db0f50c5fcb1e0f9',
    label: 'FFprobe 5.2 static (GPL-3.0)',
  },
];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertHash(file, expected, what) {
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(
      `${what}: SHA-256 mismatch\n  expected ${expected}\n  actual   ${actual}\n` +
        'Refusing to bundle a binary that does not match the pinned release.'
    );
  }
}

/** Download a pinned tarball with `npm pack`, verify it, and cache it. */
function downloadTarball(binary, cacheDir) {
  const cached = path.join(cacheDir, `${binary.pkg.replace(/[@/]/g, '-')}-${binary.version}.tgz`);
  if (fs.existsSync(cached)) {
    try {
      assertHash(cached, binary.tarballSha256, `${binary.pkg} tarball (cache)`);
      return cached;
    } catch {
      fs.rmSync(cached, { force: true });
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-spk-ffmpeg-'));
  try {
    const spec = `${binary.pkg}@${binary.version}`;
    try {
      execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', tmp], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 120000,
      });
    } catch (err) {
      throw new Error(
        `Unable to download ${spec} from the npm registry (needed to bundle ffmpeg).\n` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}\n` +
          'Build offline with: npm run spk:lite (transcoding then requires ffmpeg6).'
      );
    }

    const tgz = fs.readdirSync(tmp).find((name) => name.endsWith('.tgz'));
    if (!tgz) throw new Error(`npm pack ${spec} produced no .tgz`);
    const packed = path.join(tmp, tgz);
    assertHash(packed, binary.tarballSha256, `${spec} tarball`);
    fs.copyFileSync(packed, cached);
    return cached;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Extract one binary from a cached tarball into the cache directory. */
function ensureCachedBinary(binary, cacheDir) {
  const cachedBinary = path.join(cacheDir, binary.file);
  if (fs.existsSync(cachedBinary)) {
    try {
      assertHash(cachedBinary, binary.sha256, `${binary.pkg}/${binary.file} (cache)`);
      fs.chmodSync(cachedBinary, 0o755);
      return cachedBinary;
    } catch {
      fs.rmSync(cachedBinary, { force: true });
    }
  }

  const tgz = downloadTarball(binary, cacheDir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-spk-extract-'));
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'ignore' });
    const extracted = path.join(tmp, 'package', binary.file);
    if (!fs.existsSync(extracted)) {
      throw new Error(`${binary.pkg} tarball does not contain package/${binary.file}`);
    }
    assertHash(extracted, binary.sha256, `${binary.pkg}/${binary.file}`);
    fs.copyFileSync(extracted, cachedBinary);
    fs.chmodSync(cachedBinary, 0o755);
    return cachedBinary;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Copy the static ffmpeg/ffprobe to `destDir` and return their version info.
 * @param {{cacheDir: string, destDir: string, log?: (message: string) => void}} options
 */
export function stageBundledFfmpeg({ cacheDir, destDir, log = () => {} }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });

  const info = [];
  for (const binary of BINARIES) {
    const cachedBinary = ensureCachedBinary(binary, cacheDir);
    const destination = path.join(destDir, binary.file);
    fs.copyFileSync(cachedBinary, destination);
    fs.chmodSync(destination, 0o755);

    let version = binary.label;
    try {
      const firstLine = execFileSync(destination, ['-version'], {
        encoding: 'utf8',
        timeout: 20000,
      }).split('\n')[0];
      if (firstLine) version = firstLine.trim();
    } catch (err) {
      throw new Error(
        `Bundled ${binary.file} cannot run on this build host: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    log(`  ${binary.file}: ${version}`);
    info.push({ name: binary.file, package: `${binary.pkg}@${binary.version}`, version });
  }

  fs.copyFileSync(path.join(LICENSE_DIR, 'GPL-3.0.txt'), path.join(destDir, 'GPL-3.0.txt'));
  fs.copyFileSync(
    path.join(LICENSE_DIR, 'FFMPEG-SOURCE.txt'),
    path.join(destDir, 'FFMPEG-SOURCE.txt')
  );
  return info;
}

export const BUNDLED_FFMPEG_PACKAGES = BINARIES.map((b) => ({
  package: b.pkg,
  version: b.version,
  sha256: b.sha256,
}));
