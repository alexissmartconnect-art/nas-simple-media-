#!/usr/bin/env python3
"""Android 0.2.1 release helper.

Inspects the published 0.2.0 APK, optionally signs with a keystore already
present in GitHub Actions secrets, and publishes either:

- an installable update (same package name, same signing certificate, higher
  versionCode), or
- at most one clearly named test artifact, never presented as that update.

Never creates a ``v*`` tag, never uploads to the server release, and never
prints secret values.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

USER_AGENT = "NASMedia-Android/0.2.1"
SERVER_RELEASE_TAG = "v1.7.0"
REFERENCE_TAG = "v1.6.0"
REFERENCE_ASSET = "nas-simple-media-0.2.0-debug.apk"
TEST_ASSET_NAME = "nas-simple-media-0.2.1-TEST-NOT-AN-UPDATE.apk"

# Names of secrets that may already exist. Values are never printed.
# A missing name is simply empty in Actions; this script does not create secrets.
KEYSTORE_SECRETS = (
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE",
    "KEYSTORE_BASE64",
    "SIGNING_KEY",
    "RELEASE_KEYSTORE_BASE64",
    "RELEASE_KEYSTORE",
    "DEBUG_KEYSTORE_BASE64",
    "DEBUG_KEYSTORE",
    "NAS_MEDIA_KEYSTORE_BASE64",
    "ANDROID_UPLOAD_KEYSTORE_BASE64",
)
STORE_PASSWORD_SECRETS = (
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_STORE_PASSWORD",
    "KEYSTORE_PASSWORD",
    "KEY_STORE_PASSWORD",
    "SIGNING_STORE_PASSWORD",
    "RELEASE_STORE_PASSWORD",
    "RELEASE_KEYSTORE_PASSWORD",
    "DEBUG_KEYSTORE_PASSWORD",
    "DEBUG_STORE_PASSWORD",
    "STORE_PASSWORD",
)
KEY_PASSWORD_SECRETS = (
    "ANDROID_KEY_PASSWORD",
    "KEY_PASSWORD",
    "SIGNING_KEY_PASSWORD",
    "RELEASE_KEY_PASSWORD",
    "DEBUG_KEY_PASSWORD",
)
ALIAS_SECRETS = (
    "ANDROID_KEY_ALIAS",
    "KEY_ALIAS",
    "SIGNING_KEY_ALIAS",
    "RELEASE_KEY_ALIAS",
    "DEBUG_KEY_ALIAS",
    "KEYSTORE_ALIAS",
)

# Public Android debug-keystore password, documented by the SDK. Tried last,
# and only against a keystore already supplied as a secret — never a new key.
PUBLIC_DEBUG_PASSWORD = "android"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=False, **kwargs)


def normalize_sha256(value: str) -> str:
    hexonly = re.sub(r"[^0-9a-fA-F]", "", value or "")
    if len(hexonly) < 64:
        raise ValueError(f"empreinte SHA-256 illisible ({len(hexonly)} caractères hex)")
    return hexonly[:64].lower()


def secret_values(names: tuple[str, ...]) -> list[tuple[str, str]]:
    found = []
    for name in names:
        value = os.environ.get(name, "")
        if value.strip():
            found.append((name, value.strip()))
    return found


def mask_secrets() -> None:
    """Ask Actions to mask secret values. Never prints the values themselves."""
    for name, value in secret_values(KEYSTORE_SECRETS + STORE_PASSWORD_SECRETS + KEY_PASSWORD_SECRETS + ALIAS_SECRETS):
        if "\n" in value or "\r" in value or "%" in value or "::" in value:
            continue
        print(f"::add-mask::{value}")


def report_secret_presence() -> dict[str, str]:
    presence = {}
    for name in KEYSTORE_SECRETS + STORE_PASSWORD_SECRETS + KEY_PASSWORD_SECRETS + ALIAS_SECRETS:
        state = "set" if os.environ.get(name, "").strip() else "absent"
        presence[name] = state
        print(f"secret_{name}={state}")
    return presence


def find_tool(name: str) -> str | None:
    found: list[str] = []
    which = shutil.which(name)
    if which:
        found.append(which)
    homes = [os.environ.get("ANDROID_HOME", ""), os.environ.get("ANDROID_SDK_ROOT", "")]
    for home in homes:
        if not home:
            continue
        build_tools = Path(home) / "build-tools"
        if not build_tools.is_dir():
            continue
        for path in build_tools.glob(f"*/{name}"):
            if path.is_file() and os.access(path, os.X_OK):
                found.append(str(path))
        cmdline = Path(home) / "cmdline-tools"
        if cmdline.is_dir():
            for path in cmdline.glob(f"*/bin/{name}"):
                if path.is_file() and os.access(path, os.X_OK):
                    found.append(str(path))
    return sorted(set(found))[-1] if found else None


def apk_certs_apksigner(apk: Path, apksigner: str) -> list[dict[str, str]]:
    proc = run([apksigner, "verify", "--print-certs", str(apk)], capture_output=True, text=True)
    if proc.returncode != 0:
        eprint(f"apksigner a refusé {apk.name} (code {proc.returncode})")
        err = (proc.stderr or proc.stdout or "").strip()
        if err:
            eprint(err.splitlines()[-1][:300])
        return []
    text = proc.stdout or ""
    certs: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in text.splitlines():
        dn = re.search(r"certificate DN:\s*(.+)$", line)
        sha = re.search(r"certificate SHA-256 digest:\s*(.+)$", line)
        if dn:
            if current.get("sha256"):
                certs.append(current)
                current = {}
            current["subject"] = dn.group(1).strip()
        elif sha:
            current["sha256"] = normalize_sha256(sha.group(1))
    if current.get("sha256"):
        certs.append(current)
    return certs


def apk_certs_jar(apk: Path) -> list[dict[str, str]]:
    certs: list[dict[str, str]] = []
    with zipfile.ZipFile(apk) as zf:
        names = [
            n
            for n in zf.namelist()
            if n.startswith("META-INF/") and n.rsplit(".", 1)[-1].upper() in {"RSA", "DSA", "EC"}
        ]
        for name in names:
            pkcs7 = zf.read(name)
            with tempfile.NamedTemporaryFile(suffix=".pkcs7") as tmp:
                tmp.write(pkcs7)
                tmp.flush()
                pem = run(
                    ["openssl", "pkcs7", "-inform", "DER", "-in", tmp.name, "-print_certs"],
                    capture_output=True,
                )
            if pem.returncode != 0 or not pem.stdout:
                continue
            blocks = re.findall(
                rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
                pem.stdout,
                flags=re.S,
            )
            for block in blocks:
                info = run(
                    ["openssl", "x509", "-inform", "PEM", "-fingerprint", "-sha256", "-subject", "-noout"],
                    input=block,
                    capture_output=True,
                )
                if info.returncode != 0:
                    continue
                text = info.stdout.decode("utf-8", "replace")
                sha_match = re.search(r"SHA256 Fingerprint=([0-9A-Fa-f:]+)", text)
                sub_match = re.search(r"subject=(.+)", text)
                if not sha_match:
                    continue
                certs.append(
                    {
                        "sha256": normalize_sha256(sha_match.group(1)),
                        "subject": (sub_match.group(1).strip() if sub_match else ""),
                    }
                )
    return certs


def apk_certs(apk: Path) -> list[dict[str, str]]:
    apksigner = find_tool("apksigner")
    certs = apk_certs_apksigner(apk, apksigner) if apksigner else []
    if certs:
        return certs
    eprint("repli openssl/JAR pour lire le certificat")
    return apk_certs_jar(apk)


def package_info(apk: Path) -> dict[str, str]:
    aapt = find_tool("aapt")
    if aapt:
        proc = run([aapt, "dump", "badging", str(apk)], capture_output=True, text=True)
        if proc.returncode == 0:
            match = re.search(
                r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'",
                proc.stdout or "",
            )
            if match:
                return {
                    "package": match.group(1),
                    "versionCode": match.group(2),
                    "versionName": match.group(3),
                }
        eprint(f"aapt n'a pas lu le manifeste de {apk.name}")
    analyzer = find_tool("apkanalyzer")
    if analyzer:
        def prop(kind: str) -> str:
            proc = run([analyzer, "manifest", kind, str(apk)], capture_output=True, text=True)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.strip() or f"apkanalyzer {kind} a échoué")
            return (proc.stdout or "").strip()

        return {
            "package": prop("application-id"),
            "versionCode": prop("version-code"),
            "versionName": prop("version-name"),
        }
    raise RuntimeError("ni aapt ni apkanalyzer ne sont disponibles pour lire l'APK")


def inspect_apk(apk: Path) -> dict:
    if not apk.is_file():
        raise FileNotFoundError(apk)
    info = package_info(apk)
    certs = apk_certs(apk)
    if not certs:
        raise RuntimeError(f"aucun certificat de signature lisible dans {apk}")
    info["sha256"] = certs[0]["sha256"]
    info["subject"] = certs[0].get("subject", "")
    info["signerCount"] = len(certs)
    info["size"] = apk.stat().st_size
    info["path"] = str(apk)
    info["signed"] = True
    return info


def apk_has_user_agent(apk: Path) -> bool:
    expected = USER_AGENT.encode("utf-8")
    forbidden = (
        b"NASMedia-Android/0.1",
        b"NASMedia-Android/0.2.0",
    )
    with zipfile.ZipFile(apk) as zf:
        data = b"".join(zf.read(name) for name in zf.namelist() if name.endswith(".dex"))
        if expected not in data:
            data = b"".join(zf.read(name) for name in zf.namelist())
    if expected not in data:
        return False
    for old in forbidden:
        if old in data:
            raise RuntimeError(f"{apk.name} contient encore {old.decode()}")
    return True


def decode_keystore(value: str) -> bytes | None:
    raw = value.strip().strip('"').strip("'")
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    raw = "".join(raw.split())
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception:
        return None
    if not (100 <= len(data) <= 2_000_000):
        return None
    if data[:4] == b"\xfe\xed\xfe\xed" or data[:1] == b"\x30" or data[:2] == b"PK":
        return data
    return None


def keytool_entries(keystore: Path, store_password: str) -> list[dict[str, str]]:
    proc = run(
        [
            "keytool",
            "-list",
            "-v",
            "-keystore",
            str(keystore),
            "-storepass",
            store_password,
        ],
        capture_output=True,
    )
    if proc.returncode != 0:
        return []
    text = proc.stdout.decode("utf-8", "replace")
    entries: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in text.splitlines():
        alias = re.match(r"Alias name:\s*(.+)", line.strip())
        sha = re.search(r"SHA256:\s*([0-9A-Fa-f:]+)", line)
        owner = re.match(r"Owner:\s*(.+)", line.strip())
        if alias:
            if current.get("alias") and current.get("sha256"):
                entries.append(current)
            current = {"alias": alias.group(1).strip()}
        elif sha and current.get("alias") and "sha256" not in current:
            current["sha256"] = normalize_sha256(sha.group(1))
        elif owner and current.get("alias") and "subject" not in current:
            current["subject"] = owner.group(1).strip()
    if current.get("alias") and current.get("sha256"):
        entries.append(current)
    return entries


def write_github_env(key: str, value: str) -> None:
    path = os.environ.get("GITHUB_ENV")
    if not path or value is None:
        return
    delimiter = "ANDROID_SIGNING_EOF"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"{key}<<{delimiter}\n{value}\n{delimiter}\n")


def prepare_signing(reference_sha256: str, dest_dir: Path) -> dict:
    mask_secrets()
    presence = report_secret_presence()
    reference_sha256 = normalize_sha256(reference_sha256)
    blobs = []
    for name, value in secret_values(KEYSTORE_SECRETS):
        data = decode_keystore(value)
        if data is None:
            eprint(f"secret {name} défini mais pas un keystore base64 reconnu")
            continue
        blobs.append((name, data))
    result: dict = {
        "status": "absent",
        "source": None,
        "alias": None,
        "sha256": None,
        "subject": None,
        "secrets": presence,
    }
    if not blobs:
        print("keystore_status=absent")
        return result

    passwords = [value for _, value in secret_values(STORE_PASSWORD_SECRETS)]
    if PUBLIC_DEBUG_PASSWORD not in passwords:
        passwords.append(PUBLIC_DEBUG_PASSWORD)
    key_passwords = [value for _, value in secret_values(KEY_PASSWORD_SECRETS)]
    preferred_aliases = [value for _, value in secret_values(ALIAS_SECRETS)]

    readable = False
    mismatched: list[str] = []
    dest_dir.mkdir(parents=True, exist_ok=True)
    for source, data in blobs:
        path = dest_dir / "candidate.keystore"
        path.write_bytes(data)
        path.chmod(0o600)
        for store_password in passwords:
            entries = keytool_entries(path, store_password)
            if not entries:
                continue
            readable = True
            by_alias = {entry["alias"]: entry for entry in entries}
            ordered = [alias for alias in preferred_aliases if alias in by_alias]
            ordered += [alias for alias in by_alias if alias not in ordered]
            for alias in ordered:
                entry = by_alias[alias]
                mismatched.append(entry["sha256"])
                if entry["sha256"] != reference_sha256:
                    continue
                key_password = key_passwords[0] if key_passwords else store_password
                kept = dest_dir / "matching.keystore"
                if kept.exists():
                    kept.unlink()
                path.replace(kept)
                kept.chmod(0o600)
                write_github_env("ANDROID_KEYSTORE_FILE", str(kept))
                write_github_env("ANDROID_KEYSTORE_PASSWORD", store_password)
                write_github_env("ANDROID_KEY_ALIAS", alias)
                write_github_env("ANDROID_KEY_PASSWORD", key_password)
                result.update(
                    {
                        "status": "matched",
                        "source": source,
                        "alias": alias,
                        "sha256": entry["sha256"],
                        "subject": entry.get("subject", ""),
                    }
                )
                print(f"keystore_status=matched source={source} alias={alias}")
                print(f"keystore_sha256={entry['sha256']}")
                return result
        if path.exists():
            path.unlink()
    if readable:
        result["status"] = "mismatched"
        result["sha256"] = mismatched[0] if mismatched else None
        print("keystore_status=mismatched")
    else:
        result["status"] = "unreadable"
        print("keystore_status=unreadable")
    return result


def is_android_tag(tag: str) -> bool:
    return bool(re.fullmatch(r"android-v[0-9A-Za-z][0-9A-Za-z._-]*", tag))


def assert_android_tag(tag: str) -> None:
    if not is_android_tag(tag):
        raise SystemExit(
            f"Refus de publier le tag {tag!r}. Seuls les tags android-v* sont autorisés "
            "(ne pas utiliser v*, réservé à release-spk.yml)."
        )


def gh_json(args: list[str], payload: dict | None = None) -> dict:
    cmd = ["gh", "api", *args]
    proc = run(cmd, input=json.dumps(payload).encode() if payload is not None else None, capture_output=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")
        raise RuntimeError(err.strip() or f"gh api a échoué ({proc.returncode})")
    if not proc.stdout:
        return {}
    return json.loads(proc.stdout.decode("utf-8"))


def release_view(repo: str, tag: str) -> dict | None:
    proc = run(["gh", "api", f"repos/{repo}/releases/tags/{tag}"], capture_output=True)
    if proc.returncode != 0:
        return None
    return json.loads(proc.stdout.decode("utf-8"))


def asset_fingerprint(release: dict) -> list[tuple[str, int]]:
    return [(asset["name"], asset["size"]) for asset in release.get("assets") or []]


def mib(size: int) -> str:
    return f"{size / (1024 * 1024):.1f} Mio"


def sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_built_apk(directory: Path, kind: str) -> Path | None:
    names = {
        "debug": ["app-debug.apk"],
        "release": ["app-release.apk", "app-release-unsigned.apk"],
    }[kind]
    for name in names:
        matches = list(directory.rglob(name))
        if matches:
            return matches[0]
    return None


def decide(reference: dict, built: dict | None, keystore_status: str) -> tuple[bool, str]:
    if not built or not built.get("signed"):
        return False, "aucun APK signé du même type n'a été produit"
    try:
        ref_code = int(reference["versionCode"])
        built_code = int(built["versionCode"])
    except (KeyError, ValueError):
        return False, "versionCode illisible"
    same_package = built.get("package") == reference.get("package")
    same_cert = built.get("sha256") == reference.get("sha256")
    newer = built_code > ref_code
    if keystore_status == "matched" and same_package and same_cert and newer:
        return True, "même applicationId, même certificat, versionCode supérieur"
    reasons = []
    if keystore_status != "matched":
        reasons.append(f"clé de signature {keystore_status}")
    if not same_package:
        reasons.append(
            f"applicationId {built.get('package')} ≠ {reference.get('package')}"
        )
    if not same_cert:
        reasons.append("certificat différent de l'APK 0.2.0")
    if not newer:
        reasons.append(f"versionCode {built_code} pas supérieur à {ref_code}")
    return False, "; ".join(reasons)


def choose_test_apk(reference: dict, debug: dict | None, release: dict | None) -> dict | None:
    signed = [item for item in (debug, release) if item and item.get("signed")]
    same = [item for item in signed if item.get("package") == reference.get("package")]
    if same:
        return same[0]
    return signed[0] if signed else None


def render_notes(report: dict, asset_name: str | None, asset_path: Path | None, official: bool) -> str:
    ref = report["reference"]
    built = report.get("selected") or {}
    repo = report["repo"]
    tag = report["tag"]
    url = (
        f"https://github.com/{repo}/releases/download/{tag}/{asset_name}"
        if asset_name
        else f"https://github.com/{repo}/releases/tag/{tag}"
    )
    server = f"https://github.com/{repo}/releases/tag/{SERVER_RELEASE_TAG}"
    size_line = ""
    file_sha = ""
    if asset_path and asset_path.is_file():
        size = asset_path.stat().st_size
        size_line = f"{size} octets ({mib(size)})"
        file_sha = sha256_file(asset_path)
    comparison = (
        "| | APK 0.2.0 publié | Build 0.2.1 |\n"
        "|---|---|---|\n"
        f"| Package | `{ref.get('package')}` | `{built.get('package', '—')}` |\n"
        f"| versionName | `{ref.get('versionName')}` | `{built.get('versionName', '—')}` |\n"
        f"| versionCode | `{ref.get('versionCode')}` | `{built.get('versionCode', '—')}` |\n"
        f"| Certificat SHA-256 | `{ref.get('sha256')}` | `{built.get('sha256', '—')}` |\n"
        f"| Sujet | `{ref.get('subject') or '—'}` | `{built.get('subject') or '—'}` |\n"
    )
    common = (
        "Application **téléphone et Android TV** (une seule appli). "
        f"User-Agent **`{USER_AGENT}`**. "
        "Les partages protégés exigent l’appli **0.2.0 ou ultérieure**.\n\n"
        f"La release serveur [{SERVER_RELEASE_TAG}]({server}) n’est pas modifiée "
        "(tag Android dédié `android-v*`, pas `v*`).\n"
    )
    if official:
        return (
            "## NAS Media Android 0.2.1 — mise à jour installable\n\n"
            "Cette release est **uniquement l’application Android**. " + common + "\n"
            "### Mise à jour par-dessus l’APK 0.2.0\n\n"
            "Oui. Même identifiant d’application, même certificat de signature, `versionCode` supérieur. "
            f"{report.get('reason', '')}\n\n"
            + comparison
            + "\n### Fichier\n\n"
            f"- `{asset_name}` — {size_line}\n"
            f"- SHA-256 du fichier : `{file_sha}`\n"
            f"- URL : {url}\n\n"
            "### Installation\n\n"
            "Téléphone : ouvrir l’APK et autoriser les sources inconnues. "
            "Android TV : appli Downloader, ou `adb install -r` depuis le réseau local. "
            "L’installation remplace l’appli 0.2.0 déjà présente.\n"
        )
    reason = report.get("reason") or "clé de signature indisponible"
    file_section = (
        f"- `{asset_name}` — {size_line}\n- SHA-256 du fichier : `{file_sha}`\n- URL : {url}\n"
        if asset_name
        else "- Aucun APK joint.\n"
    )
    return (
        "## NAS Media Android 0.2.1 — artefact de test, pas une mise à jour officielle\n\n"
        "**Blocage.** La clé qui a signé l’APK 0.2.0 publié n’a pas pu être utilisée. "
        "Seuls les secrets GitHub déjà configurés ont été consultés. "
        "Aucune clé, aucun mot de passe et aucun token n’ont été ajoutés au dépôt ou aux notes.\n\n"
        "**Ce fichier n’est pas une mise à jour installable** de "
        f"`{REFERENCE_ASSET}`. Android refusera de l’installer par-dessus l’appli déjà présente "
        "(signatures ou identifiant incompatibles). Pour un essai seulement : désinstaller NAS Media "
        "d’abord — les serveurs et mots de passe mémorisés sur l’appareil sont alors perdus — "
        "puis installer cet artefact de test.\n\n"
        + common
        + "\n### Pourquoi ce n’est pas une mise à jour\n\n"
        f"- {reason}\n"
        f"- Statut de la clé déjà configurée : `{report.get('keystoreStatus')}`\n\n"
        + comparison
        + "\n### Fichier\n\n"
        + file_section
        + "\nNe pas distribuer ce fichier comme mise à jour officielle de la 0.2.0.\n"
    )


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def append_summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    print(text)
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text)
            if not text.endswith("\n"):
                fh.write("\n")


def cmd_check_sources(_: argparse.Namespace) -> int:
    root = repo_root()
    gradle = (root / "android/app/build.gradle.kts").read_text(encoding="utf-8")
    api = (root / "android/app/src/main/java/com/nassimplemedia/android/data/ApiClient.kt").read_text(encoding="utf-8")
    readme = (root / "README.md").read_text(encoding="utf-8")
    dop = (root / "docs/DOP.md").read_text(encoding="utf-8")
    errors = []
    if 'versionName = "0.2.1"' not in gradle:
        errors.append('versionName != "0.2.1"')
    if "versionCode = 3" not in gradle:
        errors.append("versionCode != 3")
    if 'const val USER_AGENT = "NASMedia-Android/0.2.1"' not in api:
        errors.append("USER_AGENT != NASMedia-Android/0.2.1")
    if "NASMedia-Android/0.2.0" in api or "NASMedia-Android/0.1\"" in api:
        errors.append("ancien User-Agent encore présent dans ApiClient.kt")
    if "0.2.0 ou ultérieure" not in readme:
        errors.append("README.md n'exige pas 0.2.0 ou ultérieure")
    if "0.2.0 ou ultérieure" not in dop:
        errors.append("docs/DOP.md n'exige pas 0.2.0 ou ultérieure")
    if errors:
        for err in errors:
            eprint("check-sources: " + err)
        return 1
    print("check-sources OK versionName=0.2.1 versionCode=3 userAgent=NASMedia-Android/0.2.1")
    return 0


def cmd_download_reference(args: argparse.Namespace) -> int:
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    repo = args.repo or os.environ.get("GITHUB_REPOSITORY", "")
    cmd = [
        "gh",
        "release",
        "download",
        REFERENCE_TAG,
        "--pattern",
        REFERENCE_ASSET,
        "--dir",
        str(dest),
        "--clobber",
    ]
    if repo:
        cmd.extend(["--repo", repo])
    proc = run(cmd)
    apk = dest / REFERENCE_ASSET
    if proc.returncode != 0 or not apk.is_file():
        eprint(f"impossible de télécharger {REFERENCE_ASSET} depuis {REFERENCE_TAG}")
        return 1
    print(apk)
    return 0


def cmd_apk_info(args: argparse.Namespace) -> int:
    info = inspect_apk(Path(args.apk))
    save_json(Path(args.output), info)
    print(
        f"package={info['package']} versionCode={info['versionCode']} "
        f"versionName={info['versionName']} sha256={info['sha256']} size={info['size']}"
    )
    print(f"subject={info.get('subject', '')}")
    return 0


def cmd_verify_user_agent(args: argparse.Namespace) -> int:
    apk = Path(args.apk)
    if not apk_has_user_agent(apk):
        eprint(f"{apk} ne contient pas {USER_AGENT}")
        return 1
    print(f"user-agent OK dans {apk.name}: {USER_AGENT}")
    return 0


def cmd_prepare_signing(args: argparse.Namespace) -> int:
    result = prepare_signing(args.reference_sha256, Path(args.dest))
    save_json(Path(args.output), result)
    return 0


def cmd_collect(args: argparse.Namespace) -> int:
    reference = load_json(Path(args.reference))
    keystore = load_json(Path(args.keystore))
    root = Path(args.apk_root)
    debug_path = find_built_apk(root, "debug")
    release_path = find_built_apk(root, "release")
    if debug_path is None:
        eprint("APK debug introuvable")
        return 1
    debug = inspect_apk(debug_path)
    debug["userAgentOk"] = apk_has_user_agent(debug_path)
    release = None
    if release_path is not None:
        try:
            release = inspect_apk(release_path)
            release["userAgentOk"] = apk_has_user_agent(release_path)
        except RuntimeError as exc:
            release = {
                "path": str(release_path),
                "signed": False,
                "size": release_path.stat().st_size,
                "userAgentOk": apk_has_user_agent(release_path),
                "note": str(exc),
            }
            print(f"release APK non signé : {release_path.name} ({release['size']} octets)")
    else:
        eprint("APK release introuvable")
        return 1
    same_package = None
    for item in (debug, release):
        if item and item.get("signed") and item.get("package") == reference.get("package"):
            same_package = item
            break
    official, reason = decide(reference, same_package, keystore.get("status", "absent"))
    if official and not (same_package or {}).get("userAgentOk"):
        official = False
        reason = f"User-Agent {USER_AGENT} absent du binaire"
    selected = same_package if official else choose_test_apk(reference, debug, release)
    tag = args.tag or os.environ.get("ANDROID_RELEASE_TAG", "")
    repo = args.repo or os.environ.get("GITHUB_REPOSITORY", "")
    report = {
        "reference": reference,
        "keystoreStatus": keystore.get("status"),
        "keystoreSource": keystore.get("source"),
        "debug": debug,
        "release": release,
        "selected": selected,
        "official": official,
        "reason": reason,
        "tag": tag,
        "repo": repo,
    }
    save_json(Path(args.output), report)
    print(f"official={str(official).lower()} reason={reason}")
    print(f"debug_package={debug.get('package')} debug_sha256={debug.get('sha256')}")
    if release:
        print(f"release_signed={release.get('signed')} release_package={release.get('package')} release_size={release.get('size')}")
    return 0


def restore_server_latest(repo: str, before: dict) -> None:
    after = release_view(repo, SERVER_RELEASE_TAG)
    if after is None:
        raise RuntimeError(f"la release serveur {SERVER_RELEASE_TAG} a disparu")
    if after.get("name") != before.get("name") or after.get("body") != before.get("body"):
        raise RuntimeError(f"le titre ou les notes de {SERVER_RELEASE_TAG} ont changé — arrêt")
    if asset_fingerprint(after) != asset_fingerprint(before):
        raise RuntimeError(f"les fichiers de {SERVER_RELEASE_TAG} ont changé — arrêt")
    latest = gh_json([f"repos/{repo}/releases/latest"])
    if latest.get("tag_name") == SERVER_RELEASE_TAG:
        print(f"latest inchangé : {SERVER_RELEASE_TAG}")
        return
    eprint(f"latest est {latest.get('tag_name')}, restauration de {SERVER_RELEASE_TAG}")
    gh_json(
        ["--method", "PATCH", f"repos/{repo}/releases/{before['id']}", "--input", "-"],
        {"make_latest": "true"},
    )
    latest = gh_json([f"repos/{repo}/releases/latest"])
    if latest.get("tag_name") != SERVER_RELEASE_TAG:
        raise RuntimeError(f"impossible de rendre {SERVER_RELEASE_TAG} à nouveau Latest")
    print(f"latest restauré : {SERVER_RELEASE_TAG}")


def upsert_release(repo: str, tag: str, title: str, body: str, prerelease: bool) -> dict:
    existing = release_view(repo, tag)
    payload = {
        "tag_name": tag,
        "name": title,
        "body": body,
        "draft": False,
        "prerelease": prerelease,
        "make_latest": "false",
    }
    ref = gh_json([f"repos/{repo}/git/ref/tags/{tag}"])
    payload["target_commitish"] = ref["object"]["sha"]
    if existing:
        method = "PATCH"
        endpoint = f"repos/{repo}/releases/{existing['id']}"
        print(f"release existante mise à jour : {tag}")
    else:
        method = "POST"
        endpoint = f"repos/{repo}/releases"
    try:
        return gh_json(["--method", method, endpoint, "--input", "-"], payload)
    except RuntimeError as exc:
        if "make_latest" not in str(exc):
            raise
        payload.pop("make_latest", None)
        print("API sans make_latest : Latest sera vérifié ensuite")
        return gh_json(["--method", method, endpoint, "--input", "-"], payload)


def upload_asset(repo: str, tag: str, apk: Path) -> None:
    proc = run(
        ["gh", "release", "upload", tag, str(apk), "--clobber", "--repo", repo],
    )
    if proc.returncode != 0:
        raise RuntimeError(f"échec de l'envoi de {apk.name}")


def write_output(key: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        print(f"{key}={value}")
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"{key}={value}\n")


def cmd_publish(args: argparse.Namespace) -> int:
    report = load_json(Path(args.report))
    tag = report.get("tag") or args.tag or os.environ.get("ANDROID_RELEASE_TAG", "")
    repo = report.get("repo") or args.repo or os.environ.get("GITHUB_REPOSITORY", "")
    assert_android_tag(tag)
    if not repo:
        raise SystemExit("GITHUB_REPOSITORY manquant")
    if tag == SERVER_RELEASE_TAG or tag.startswith("v"):
        raise SystemExit(f"refus de toucher au tag serveur {tag}")
    before = release_view(repo, SERVER_RELEASE_TAG)
    if before is None:
        raise SystemExit(f"{SERVER_RELEASE_TAG} introuvable, publication annulée")
    official = bool(report.get("official"))
    selected = report.get("selected") or {}
    staged: Path | None = None
    asset_name: str | None = None
    if official:
        source = Path(selected["path"])
        asset_name = (
            "nas-simple-media-0.2.1-debug.apk"
            if str(selected.get("package", "")).endswith(".debug")
            else "nas-simple-media-0.2.1.apk"
        )
        staged = Path(args.stage) / asset_name
        staged.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, staged)
        title = "NAS Media Android 0.2.1"
        prerelease = False
    else:
        title = "NAS Media Android 0.2.1 — artefact de test (pas une mise à jour)"
        prerelease = True
        if selected.get("path") and selected.get("signed"):
            source = Path(selected["path"])
            asset_name = TEST_ASSET_NAME
            staged = Path(args.stage) / asset_name
            staged.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, staged)
        else:
            eprint("pas d'APK signé à joindre ; notes seules")
    notes = render_notes(report, asset_name, staged, official)
    upsert_release(repo, tag, title, notes, prerelease)
    current = release_view(repo, tag) or {}
    for asset in current.get("assets") or []:
        if asset.get("name") != asset_name:
            gh_json(["--method", "DELETE", f"repos/{repo}/releases/assets/{asset['id']}"])
            print(f"asset retiré de {tag} : {asset.get('name')}")
    if staged is not None:
        upload_asset(repo, tag, staged)
    published = release_view(repo, tag)
    if published is None:
        raise SystemExit("la release Android est introuvable après création")
    names = [asset["name"] for asset in published.get("assets") or []]
    if asset_name and asset_name not in names:
        raise SystemExit(f"{asset_name} absent de la release : {names}")
    if official and any(name.startswith("nas-simple-media-0.2.1-TEST") for name in names):
        raise SystemExit("un artefact de test est encore attaché à une release officielle")
    if not official:
        unexpected = [name for name in names if name != TEST_ASSET_NAME]
        if unexpected:
            eprint(f"fichiers inattendus sur la release de test : {unexpected}")
    restore_server_latest(repo, before)
    after = release_view(repo, SERVER_RELEASE_TAG)
    if asset_fingerprint(after or {}) != asset_fingerprint(before):
        raise SystemExit(f"les assets de {SERVER_RELEASE_TAG} ont changé")
    asset = next((item for item in published.get("assets") or [] if item["name"] == asset_name), None)
    if asset_name and asset is None:
        raise SystemExit("asset publié introuvable")
    if asset and staged and asset["size"] != staged.stat().st_size:
        raise SystemExit(f"taille distante {asset['size']} ≠ locale {staged.stat().st_size}")
    release_url = published.get("html_url") or f"https://github.com/{repo}/releases/tag/{tag}"
    download = asset.get("browser_download_url") if asset else ""
    summary = [
        f"### Release Android `{tag}`",
        "",
        f"- Officielle : **{'oui' if official else 'non'}**",
        f"- Raison : {report.get('reason')}",
        f"- URL : {release_url}",
    ]
    if asset:
        summary.append(f"- APK : `{asset['name']}` — {asset['size']} octets ({mib(asset['size'])})")
        summary.append(f"- Téléchargement : {download}")
        digest = asset.get("digest") or ""
        if digest:
            summary.append(f"- Empreinte GitHub : `{digest}`")
    summary.append(f"- Release serveur {SERVER_RELEASE_TAG} inchangée, toujours Latest.")
    append_summary("\n".join(summary) + "\n")
    write_output("official", "true" if official else "false")
    write_output("release_url", release_url)
    write_output("asset_name", asset_name or "")
    write_output("asset_size", str(asset["size"]) if asset else "0")
    write_output("asset_url", download or "")
    print(f"RELEASE_URL={release_url}")
    if asset:
        print(f"ASSET_NAME={asset['name']} ASSET_SIZE={asset['size']} ASSET_URL={download}")
    return 0


def cmd_self_check(_: argparse.Namespace) -> int:
    assert normalize_sha256("AB:CD:" + "11" * 30) == "abcd" + "11" * 30
    assert is_android_tag("android-v0.2.1")
    assert not is_android_tag("v0.2.1")
    assert not is_android_tag("v1.7.0")
    assert not is_android_tag("android-v")
    ref = {
        "package": "com.nassimplemedia.android.debug",
        "versionCode": "2",
        "versionName": "0.2.0-debug",
        "sha256": "aa" * 32,
        "subject": "CN=Android Debug",
    }
    built = {
        "package": "com.nassimplemedia.android.debug",
        "versionCode": "3",
        "versionName": "0.2.1-debug",
        "sha256": "aa" * 32,
        "subject": "CN=Android Debug",
        "signed": True,
        "path": "/tmp/app-debug.apk",
    }
    official, reason = decide(ref, built, "matched")
    assert official, reason
    official, reason = decide(ref, built, "absent")
    assert not official
    other = dict(built, sha256="bb" * 32)
    official, _ = decide(ref, other, "matched")
    assert not official
    other = dict(built, package="com.nassimplemedia.android")
    official, _ = decide(ref, other, "matched")
    assert not official
    report = {
        "reference": ref,
        "selected": built,
        "reason": "clé de signature absent",
        "keystoreStatus": "absent",
        "repo": "alexissmartconnect-art/nas-simple-media-",
        "tag": "android-v0.2.1",
    }
    notes = render_notes(report, TEST_ASSET_NAME, None, False)
    assert "pas une mise à jour" in notes
    assert "mise à jour installable" not in notes.split("\n", 1)[0] or "pas une mise à jour" in notes
    assert "v1.7.0" in notes
    assert USER_AGENT in notes
    assert "TEST-NOT-AN-UPDATE" in notes
    official_notes = render_notes(report, "nas-simple-media-0.2.1-debug.apk", None, True)
    assert "mise à jour installable" in official_notes
    assert "artefact de test" not in official_notes
    try:
        assert_android_tag("v0.2.1")
    except SystemExit:
        pass
    else:
        raise SystemExit("v0.2.1 aurait dû être refusé")
    print("self-check OK")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Publication Android 0.2.1")
    sub = parser.add_subparsers(dest="cmd", required=True)

    check = sub.add_parser("check-sources")
    check.set_defaults(func=cmd_check_sources)

    self_check = sub.add_parser("self-check")
    self_check.set_defaults(func=cmd_self_check)

    download = sub.add_parser("download-reference")
    download.add_argument("--dest", required=True)
    download.add_argument("--repo", default="")
    download.set_defaults(func=cmd_download_reference)

    info = sub.add_parser("apk-info")
    info.add_argument("--apk", required=True)
    info.add_argument("--output", required=True)
    info.set_defaults(func=cmd_apk_info)

    verify = sub.add_parser("verify-user-agent")
    verify.add_argument("--apk", required=True)
    verify.set_defaults(func=cmd_verify_user_agent)

    prepare = sub.add_parser("prepare-signing")
    prepare.add_argument("--reference-sha256", required=True)
    prepare.add_argument("--dest", required=True)
    prepare.add_argument("--output", required=True)
    prepare.set_defaults(func=cmd_prepare_signing)

    collect = sub.add_parser("collect")
    collect.add_argument("--reference", required=True)
    collect.add_argument("--keystore", required=True)
    collect.add_argument("--apk-root", required=True)
    collect.add_argument("--output", required=True)
    collect.add_argument("--tag", default="")
    collect.add_argument("--repo", default="")
    collect.set_defaults(func=cmd_collect)

    publish = sub.add_parser("publish")
    publish.add_argument("--report", required=True)
    publish.add_argument("--stage", required=True)
    publish.add_argument("--tag", default="")
    publish.add_argument("--repo", default="")
    publish.set_defaults(func=cmd_publish)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except SystemExit:
        raise
    except Exception as exc:
        eprint(f"erreur: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
