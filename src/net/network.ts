/**
 * "🌐 Accès externe & Réseau" — everything the admin panel needs to publish the
 * server outside the LAN: detected local URL, saved public URL, the origin seen
 * through a Synology / Cloudflare / nginx reverse proxy, and a step-by-step
 * French guide for the three supported setups.
 */
import os from 'os';
import type { Request } from 'express';
import { config } from '../config';
import {
  forwardedInfo,
  getCustomPublicBaseUrl,
  isLoopbackUrl,
  isPrivateUrl,
  originFromRequest,
  resolvePublicBaseUrl,
} from '../shares/qr';

export interface LocalUrlInfo {
  iface: string;
  address: string;
  url: string;
}

export interface ExternalAccessStep {
  id: string;
  title: string;
  summary: string;
  recommended?: boolean;
  steps: string[];
  result: string;
}

export interface NetworkDescription {
  port: number;
  hostname: string;
  platform: string;
  localUrl: string;
  localUrls: LocalUrlInfo[];
  savedPublicBaseUrl: string | null;
  envPublicBaseUrl: string;
  effectiveBaseUrl: string;
  requestOrigin: string | null;
  requestHost: string | null;
  requestProtocol: string;
  forwardedProto: string | null;
  forwardedHost: string | null;
  behindReverseProxy: boolean;
  publicUrlIsPrivate: boolean;
  publicUrlIsLoopback: boolean;
  mobileLoginUrl: string;
  qrUrl: string;
  shareUrlExample: string;
  warnings: string[];
  guide: ExternalAccessStep[];
}

/** LAN IPv4 addresses of the NAS, best candidate first. */
export function listLocalUrls(): LocalUrlInfo[] {
  const out: LocalUrlInfo[] = [];
  const ifaces = os.networkInterfaces();
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      const family = String(addr.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (addr.internal) continue;
      const address = addr.address;
      if (!address || address.startsWith('169.254.')) continue;
      out.push({ iface, address, url: `http://${address}:${config.PORT}` });
    }
  }
  const score = (u: LocalUrlInfo): number => {
    if (/^192\.168\./.test(u.address)) return 0;
    if (/^10\./.test(u.address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.address)) return 2;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u.address)) return 3;
    return 4;
  };
  return out.sort((a, b) => score(a) - score(b) || a.iface.localeCompare(b.iface));
}

export function primaryLocalUrl(): string {
  const first = listLocalUrls()[0];
  return first ? first.url : `http://localhost:${config.PORT}`;
}

export const EXTERNAL_ACCESS_GUIDE: ExternalAccessStep[] = [
  {
    id: 'synology-ddns',
    title: 'Option 1 — Synology DDNS (*.synology.me) + Proxy inversé DSM',
    summary:
      'Recommandé : HTTPS gratuit, certificat Let’s Encrypt, le port 8096 n’est jamais exposé à Internet.',
    recommended: true,
    steps: [
      'Centre de paquets → installez « Node.js v22 » : c’est la seule dépendance. ffmpeg est fourni avec le paquet SPK ; ffmpeg6 (SynoCommunity) reste facultatif et prioritaire s’il est présent.',
      'Panneau de configuration → Accès externe → DDNS → Ajouter : fournisseur « Synology », nom d’hôte au choix (ex. mon-nas), domaine synology.me.',
      'Panneau de configuration → Portail de connexion → Avancé → Proxy inversé → Créer : Source = HTTPS, nom d’hôte mon-nas.synology.me, port 443 ; Destination = HTTP, localhost, port 8096.',
      'Panneau de configuration → Sécurité → Certificat → Ajouter un certificat (Let’s Encrypt) pour mon-nas.synology.me, puis cliquez sur « Configurer » et affectez-le au service proxy inversé.',
      'Sur la Box Internet : redirigez le port 443 (et le port 80, nécessaire au renouvellement Let’s Encrypt) vers l’IP locale du NAS.',
      'Collez ici l’adresse externe https://mon-nas.synology.me puis cliquez sur « Enregistrer », et terminez par « Tester / QR Code ».',
    ],
    result:
      'Tous les liens de partage, flux VLC (.m3u) et QR codes utilisent automatiquement l’adresse https://mon-nas.synology.me (le proxy DSM transmet X-Forwarded-Proto / X-Forwarded-Host, que NAS Simple Media respecte).',
  },
  {
    id: 'port-forward',
    title: 'Option 2 — Ouverture de port sur la Box (NAT/PAT port 8096)',
    summary:
      'Simple, mais le trafic HTTP circule en clair : à réserver aux tests ou aux réseaux de confiance.',
    steps: [
      'Notez l’IP locale du NAS (elle est affichée plus haut) et fixez-la en IP statique dans DSM : Panneau de configuration → Réseau → Interface réseau.',
      'Dans l’interface de la Box Internet → NAT / PAT / Redirection de ports : port externe 8096 → IP locale du NAS, port interne 8096, protocole TCP.',
      'Vérifiez votre adresse IP publique (elle est affichée plus haut) ou créez un DDNS (Panneau de configuration → Accès externe → DDNS).',
      'Collez ici http://<IP-publique>:8096 (ou http://mon-nas.synology.me:8096) puis cliquez sur « Enregistrer » et « Tester / QR Code ».',
    ],
    result:
      'Le serveur est joignable depuis Internet sur http://<IP-publique>:8096. Attention : sans HTTPS, les mots de passe circulent non chiffrés — préférez l’option 1 ou 3.',
  },
  {
    id: 'tunnel',
    title: 'Option 3 — Sans ouvrir de port (Tailscale / Cloudflare Tunnel)',
    summary:
      'Aucune ouverture sur la Box. Attention : Funnel et les tunnels publics rendent le service accessible sur Internet.',
    steps: [
      'Tailscale : installez le paquet officiel pour Synology et connectez le NAS à votre compte. Utilisez « Vérifier Tailscale » ci-dessus avant toute configuration.',
      'Tailscale Serve reste privé et nécessite Tailscale chez les invités. Pour un accès public sans installation : Funnel, après validation HTTPS/Funnel dans votre compte (limites de débit applicables).',
      'Funnel, configuration manuelle par un administrateur uniquement : sudo /var/packages/Tailscale/target/bin/tailscale funnel --bg http://127.0.0.1:8096. Cette commande publie le service ; vérifiez d’abord les comptes et mots de passe.',
      'Cloudflare Tunnel : installez cloudflared, puis cloudflared tunnel --url http://localhost:8096 pour un essai rapide, ou créez un tunnel nommé relié à votre domaine.',
      'Collez ici l’URL HTTPS obtenue (ex. https://mon-nas.tailnet-xxxx.ts.net ou https://media.mondomaine.fr) puis cliquez sur « Enregistrer » et « Tester / QR Code ».',
    ],
    result:
      'Aucune redirection sur la Box. Enregistrez l’adresse externe puis testez en 4G/5G, Wi-Fi et Tailscale désactivés. Les comptes de l’application protègent les bibliothèques ; ne partagez jamais votre compte administrateur.',
  },
];

/** Simple IPv4 sanity check (no IPv6 provider in the list). */
export function isIPv4(value: string): boolean {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

const PUBLIC_IP_PROVIDERS: { url: string; parse: (body: string) => string }[] = [
  { url: 'https://api.ipify.org?format=json', parse: (b) => (JSON.parse(b) as { ip?: string }).ip || '' },
  { url: 'https://ifconfig.me/ip', parse: (b) => b.trim() },
  { url: 'https://api64.ipify.org?format=json', parse: (b) => (JSON.parse(b) as { ip?: string }).ip || '' },
];

/**
 * Detect the public (Internet-facing) IPv4 of the NAS connection by asking a
 * couple of well-known echo services. Best-effort: returns null when offline,
 * blocked, or when only IPv6 is available.
 */
export async function detectPublicIp(timeoutMs = 3500): Promise<string | null> {
  for (const provider of PUBLIC_IP_PROVIDERS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(provider.url, {
        signal: controller.signal,
        headers: { accept: 'application/json, text/plain' },
      });
      if (!res.ok) continue;
      const ip = provider.parse(await res.text()).replace(/"/g, '').trim();
      if (isIPv4(ip)) return ip;
    } catch {
      /* provider unreachable — try the next one */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export interface PublicIpResult {
  publicIp: string | null;
  suggestedUrls: string[];
  port: number;
  hint: string;
}

/** Public IP + ready-to-paste URLs for the "NAT / port forwarding" scenario. */
export async function publicIpInfo(timeoutMs = 3500): Promise<PublicIpResult> {
  const publicIp = await detectPublicIp(timeoutMs);
  const suggestedUrls = publicIp ? [`http://${publicIp}:${config.PORT}`] : [];
  return {
    publicIp,
    suggestedUrls,
    port: config.PORT,
    hint: publicIp
      ? `Adresse publique détectée : ${publicIp}. Redirigez le port ${config.PORT} de votre Box vers le NAS, puis utilisez ${suggestedUrls[0]}.`
      : 'IP publique non détectée (NAS hors ligne, réseau bloqué ou IPv6 uniquement). Vérifiez votre adresse sur la Box ou utilisez un DDNS.',
  };
}

/** Local network / public URL information exposed by GET /api/admin/network. */
export function describeNetwork(req?: Request): NetworkDescription {
  const localUrls = listLocalUrls();
  const localUrl = localUrls[0]?.url || `http://localhost:${config.PORT}`;
  const saved = getCustomPublicBaseUrl();
  const effective = resolvePublicBaseUrl(req);
  const requestOrigin = originFromRequest(req);
  const fwd = forwardedInfo(req);
  const hostHeader = Array.isArray(req?.headers.host) ? req?.headers.host[0] : req?.headers.host;

  const warnings: string[] = [];
  if (isLoopbackUrl(effective)) {
    warnings.push(
      'Aucune adresse externe configurée : les liens de partage utilisent localhost et ne fonctionnent que sur le NAS lui-même.'
    );
  } else if (isPrivateUrl(effective)) {
    warnings.push(
      `L’adresse utilisée (${effective}) est privée : les liens de partage et QR codes ne fonctionneront que sur le Wi-Fi local (ou via Tailscale).`
    );
  }
  if (fwd.behindProxy) {
    warnings.push(
      `Requête reçue via un proxy inversé (X-Forwarded-Proto: ${fwd.proto || '—'}, X-Forwarded-Host: ${fwd.host || '—'}).`
    );
  }
  if (fwd.host && hostHeader && fwd.host !== hostHeader) {
    warnings.push('Le proxy transmet un nom d’hôte différent de celui du NAS — c’est le comportement attendu en HTTPS.');
  }

  return {
    port: config.PORT,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    localUrl,
    localUrls,
    savedPublicBaseUrl: saved,
    envPublicBaseUrl: config.PUBLIC_BASE_URL,
    effectiveBaseUrl: effective,
    requestOrigin,
    requestHost: hostHeader ? String(hostHeader) : null,
    requestProtocol: req?.protocol || 'http',
    forwardedProto: fwd.proto,
    forwardedHost: fwd.host,
    behindReverseProxy: fwd.behindProxy,
    publicUrlIsPrivate: isPrivateUrl(effective),
    publicUrlIsLoopback: isLoopbackUrl(effective),
    mobileLoginUrl: `${effective}/login.html`,
    qrUrl: '/api/qr?text=' + encodeURIComponent(`${effective}/login.html`),
    shareUrlExample: `${effective}/s/<jeton>`,
    warnings,
    guide: EXTERNAL_ACCESS_GUIDE,
  };
}
