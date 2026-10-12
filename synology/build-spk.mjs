#!/usr/bin/env node
/**
 * Build the native DSM 7 SPK package for Synology DS220+ (arch: geminilake).
 *
 *   npm run spk            -> dist-spk/nas-simple-media-<version>-<arch>.spk
 *   node synology/build-spk.mjs --keep-staging
 *
 * Layout produced inside the .spk:
 *
 *   INFO                       package metadata (DSM 7 required fields)
 *   package.tgz                payload -> /var/packages/nas-simple-media/target
 *   PACKAGE_ICON*.PNG          Package Center icons
 *   conf/privilege             run-as package user sc-nas-simple-media
 *   scripts/{pre,post}{inst,uninst},start-stop-status,common.sh
 *   LICENSE
 *
 * The .spk itself is never committed: it is a release artefact only.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTar, createTarGz } from './lib/tar.mjs';
import { createIconPng } from './lib/icons.mjs';
import { readInfoFile, serializeInfo } from './lib/info.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SYNO_DIR = HERE;
const STAGING = path.join(SYNO_DIR, 'package');
const OUTPUT_DIR = path.join(REPO_ROOT, 'dist-spk');
const KEEP_STAGING = process.argv.includes('--keep-staging');

const PKG_NAME = 'nas-simple-media';

function fail(message) {
  console.error(`[spk] ERROR: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[spk] ${message}`);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(src, dest, { executable = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, { executable });
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      const rel = path.relative(dest, to);
      if (executable.includes(rel)) fs.chmodSync(to, 0o755);
    }
  }
}

/** Recursively collect tar entries for a directory, in deterministic order. */
function tarEntriesFromDir(rootDir, prefix = '') {
  const entries = [];
  // A non-empty prefix becomes an explicit directory member (e.g. "conf");
  // an empty prefix means "the archive root", which needs no member of its own.
  if (prefix) {
    entries.push({ name: prefix, type: 'dir', data: Buffer.alloc(0), mode: 0o755 });
  }

  const walk = (absDir, relPrefix) => {
    const items = fs.readdirSync(absDir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const abs = path.join(absDir, item.name);
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ name: rel, type: 'dir', data: Buffer.alloc(0), mode: 0o755 });
        walk(abs, rel);
      } else if (item.isFile()) {
        const data = fs.readFileSync(abs);
        const isScript =
          rel.endsWith('.sh') ||
          rel.endsWith('run.sh') ||
          rel.startsWith('scripts/') ||
          rel === 'app/bin/run.sh';
        entries.push({
          name: rel,
          data,
          mode: isScript ? 0o755 : 0o644,
        });
      }
    }
  };

  walk(rootDir, prefix.replace(/\/$/, ''));
  return entries;
}

// ---------------------------------------------------------------------------

function main() {
  // --- sanity ---------------------------------------------------------------
  const pkgJsonPath = path.join(REPO_ROOT, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) fail('package.json not found');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  const infoPath = path.join(SYNO_DIR, 'INFO');
  if (!fs.existsSync(infoPath)) fail('synology/INFO not found');
  const infoFields = readInfoFile(infoPath);

  const version = infoFields.get('version') || pkgJson.version;
  if (version !== pkgJson.version) {
    fail(
      `version mismatch: synology/INFO says ${version} but package.json says ${pkgJson.version}. ` +
        'Keep both in sync (this release targets 1.2.0).'
    );
  }

  const arch = infoFields.get('arch');
  if (!arch) fail('synology/INFO is missing the arch field');

  const required = [
    'package',
    'version',
    'os_min_ver',
    'description',
    'arch',
    'maintainer',
    'install_dep_packages',
  ];
  const missing = required.filter((k) => !infoFields.get(k));
  if (missing.length) fail(`synology/INFO is missing required field(s): ${missing.join(', ')}`);

  info(`package  : ${infoFields.get('package')}`);
  info(`version  : ${version}`);
  info(`arch     : ${arch}`);
  info(`deps     : ${infoFields.get('install_dep_packages')}`);

  // --- clean staging --------------------------------------------------------
  rmrf(STAGING);
  rmrf(OUTPUT_DIR);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // --- compile TypeScript ---------------------------------------------------
  info('compiling TypeScript (npm run build)');
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });

  const distDir = path.join(REPO_ROOT, 'dist');
  const publicDir = path.join(REPO_ROOT, 'public');
  if (!fs.existsSync(path.join(distDir, 'index.js'))) fail('dist/index.js missing after build');
  if (!fs.existsSync(publicDir)) fail('public/ missing');

  // --- stage the payload ----------------------------------------------------
  const appDir = path.join(STAGING, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  copyDir(distDir, path.join(appDir, 'dist'));
  copyDir(publicDir, path.join(appDir, 'public'));
  fs.mkdirSync(path.join(appDir, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(SYNO_DIR, 'bin', 'run.sh'), path.join(appDir, 'bin', 'run.sh'));
  fs.chmodSync(path.join(appDir, 'bin', 'run.sh'), 0o755);
  fs.copyFileSync(pkgJsonPath, path.join(appDir, 'package.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(appDir, 'package-lock.json'));

  // Production dependencies, installed without running install scripts so no
  // native compilation is attempted. The app uses Node's built-in SQLite engine
  // (node:sqlite) on DSM, so no native addon is required at runtime.
  info('installing production dependencies (no build scripts)');
  const depsTmp = fs.mkdtempSync(path.join(REPO_ROOT, '.spk-deps-'));
  try {
    fs.copyFileSync(pkgJsonPath, path.join(depsTmp, 'package.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(depsTmp, 'package-lock.json'));
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: depsTmp,
      stdio: 'inherit',
    });
    copyDir(path.join(depsTmp, 'node_modules'), path.join(appDir, 'node_modules'));
  } finally {
    rmrf(depsTmp);
  }

  // --- package.tgz ----------------------------------------------------------
  info('creating package.tgz');
  const payloadEntries = tarEntriesFromDir(STAGING, '');
  const packageTgz = createTarGz(payloadEntries);
  const checksum = crypto.createHash('md5').update(packageTgz).digest('hex');
  info(`package.tgz: ${(packageTgz.length / 1024 / 1024).toFixed(2)} MiB, md5 ${checksum}`);

  // --- INFO with checksum ---------------------------------------------------
  const infoWithChecksum = new Map(infoFields);
  infoWithChecksum.set('checksum', checksum);
  const infoBuffer = Buffer.from(serializeInfo(infoWithChecksum), 'utf8');

  // --- icons ----------------------------------------------------------------
  const icon72 = createIconPng(72);
  const icon256 = createIconPng(256);
  info(`icons: 72x72 (${icon72.length} B), 256x256 (${icon256.length} B)`);

  // --- assemble the SPK -----------------------------------------------------
  const spkEntries = [
    { name: 'INFO', data: infoBuffer, mode: 0o644 },
    { name: 'package.tgz', data: packageTgz, mode: 0o644 },
    { name: 'PACKAGE_ICON.PNG', data: icon72, mode: 0o644 },
    { name: 'PACKAGE_ICON_256.PNG', data: icon256, mode: 0o644 },
    { name: 'LICENSE', data: fs.readFileSync(path.join(REPO_ROOT, 'LICENSE')), mode: 0o644 },
    ...tarEntriesFromDir(path.join(SYNO_DIR, 'conf'), 'conf'),
    ...tarEntriesFromDir(path.join(SYNO_DIR, 'scripts'), 'scripts'),
  ];

  const fileName = `${infoFields.get('package')}-${version}-${arch}.spk`;
  const outPath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(outPath, createTar(spkEntries));
  info(`wrote ${path.relative(REPO_ROOT, outPath)} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MiB)`);

  // --- self-verification ----------------------------------------------------
  info('verifying archive');
  const listing = execFileSync('tar', ['-tf', outPath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const expected = ['INFO', 'package.tgz', 'conf/privilege', 'scripts/start-stop-status'];
  for (const item of expected) {
    if (!listing.includes(item)) fail(`verification failed: ${item} missing from ${fileName}`);
  }
  info(`archive contains ${listing.length} entries`);

  if (!KEEP_STAGING) rmrf(STAGING);

  info('done');
  console.log('');
  console.log(`  ${path.relative(REPO_ROOT, outPath)}`);
  console.log('');
  console.log('  Install: Package Center > Manual Install > select the .spk');
  console.log('          (Settings > General > Trust Level must allow all publishers)');
  console.log('');
}

main();
