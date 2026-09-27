import test from 'node:test';
import assert from 'node:assert/strict';
import { participantLinks, readCertificate } from '../src/server/participant-links.js';

const env = { useHttps: true, port: 8000, baseUrl: '' };
const interfaces = {
  lo0: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
  ],
  en0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.168.1.147', family: 'IPv4', internal: false },
  ],
  en5: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
  bridge100: [{ address: '10.0.0.4', family: 'IPv4', internal: false }],
};

test('only LAN IPv4 addresses become participant URLs, in interface order', () => {
  assert.deepEqual(participantLinks(env, interfaces, null), [
    { name: 'en0', url: 'https://192.168.1.147:8000/', trusted: null },
    { name: 'bridge100', url: 'https://10.0.0.4:8000/', trusted: null },
  ]);
});

test('a configured certificate marks which addresses phones will trust', () => {
  const certificate = { checkIP: ip => ip === '192.168.1.147' ? ip : undefined };
  assert.deepEqual(participantLinks(env, interfaces, certificate).map(link => link.trusted), [true, false]);
});

test('protocol and base URL follow the environment; no network yields no links', () => {
  const [link] = participantLinks({ useHttps: false, port: 9000, baseUrl: '/study/' }, { en0: interfaces.en0 }, null);
  assert.equal(link.url, 'http://192.168.1.147:9000/study/');
  assert.deepEqual(participantLinks(env, { lo0: interfaces.lo0 }, null), []);
});

test('self-signed or unreadable certificate configuration yields no certificate', () => {
  assert.equal(readCertificate({ useHttps: true, httpsInfos: null }), null);
  assert.equal(readCertificate({ useHttps: false, httpsInfos: { cert: 'certificates/cert.pem' } }), null);
  assert.equal(readCertificate({ useHttps: true, httpsInfos: { cert: 'missing/cert.pem', key: 'missing/key.pem' } }), null);
});
