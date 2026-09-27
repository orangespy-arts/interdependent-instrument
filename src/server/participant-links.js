import fs from 'node:fs';
import os from 'node:os';
import { X509Certificate } from 'node:crypto';

/** The configured certificate, or null for soundworks' generated self-signed one. */
export function readCertificate(env) {
  if (!env.useHttps || !env.httpsInfos?.cert) {
    return null;
  }
  try {
    return new X509Certificate(fs.readFileSync(env.httpsInfos.cert));
  } catch {
    return null;
  }
}

/**
 * Participant URLs another device on the LAN can open. Loopback and
 * self-assigned (169.254.x.x) addresses are useless to a phone. `trusted` is
 * true or false when a configured certificate covers or misses the address,
 * and null when soundworks generates a self-signed one.
 */
export function participantLinks(env, interfaces = os.networkInterfaces(), certificate = readCertificate(env)) {
  const protocol = env.useHttps ? 'https' : 'http';
  const base = env.baseUrl ? `/${env.baseUrl.replace(/^\/+|\/+$/g, '')}` : '';
  return Object.entries(interfaces).flatMap(([name, addresses]) => (addresses ?? [])
    .filter(({ family, internal, address }) => family === 'IPv4' && !internal && !address.startsWith('169.254.'))
    .map(({ address }) => ({
      name,
      url: `${protocol}://${address}:${env.port}${base}/`,
      trusted: certificate ? certificate.checkIP(address) !== undefined : null,
    })));
}
