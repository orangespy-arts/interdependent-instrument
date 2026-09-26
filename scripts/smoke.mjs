import '@soundworks/helpers/polyfills.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@soundworks/core/client.js';
import loadConfig from '@soundworks/helpers/load-config.js';
import ClientPluginSync from '@soundworks/plugin-sync/client.js';
import ClientPluginCheckin from '@soundworks/plugin-checkin/client.js';
import params from '../src/shared/params.js';

// Run against a separate, already running development server: npm start.
// These are real network clients with simulated sensor values, not phone tests.
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const config = loadConfig(process.env.ENV ?? 'default');
const env = { ...config.env, useHttps: true, serverAddress: '127.0.0.1' };
const clients = [];
const pendingCommands = new Map();
const groupId = `SMOKE_${Date.now()}_${randomUUID().slice(0, 8)}`;
let controller;
let global;
let players;
let ownsSession = false;
let hasRecorded = false;
let resultListener;

function bounded(promise, description, timeoutMs = 8000) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function observe(register, predicate, description) {
  if (predicate()) {
    return Promise.resolve();
  }
  let unsubscribe;
  const changed = new Promise(resolve => {
    const check = () => {
      if (predicate()) {
        resolve();
      }
    };
    unsubscribe = register(check);
    check();
  });
  return bounded(changed, description, 5000).finally(() => unsubscribe?.());
}

function expectGlobal(predicate, description) {
  return observe(callback => global.onUpdate(callback), predicate, description);
}

function expectPlayers(count) {
  return observe(callback => players.onChange(callback), () => players.length === count, `${count} simulated player states`);
}

function command(action, payload = {}) {
  const id = randomUUID();
  const acknowledged = new Promise((resolve, reject) => {
    pendingCommands.set(id, { resolve, reject });
    controller.socket.send('research:command', { id, action, payload });
  });
  return bounded(acknowledged, `controller acknowledgement for ${action}`)
    .finally(() => pendingCommands.delete(id));
}

async function connect(role) {
  const client = new Client({ role, env: { ...env } });
  clients.push(client);
  client.pluginManager.register('sync', ClientPluginSync);
  if (role === 'player') {
    client.pluginManager.register('checkin', ClientPluginCheckin);
  }
  await bounded(client.start(), `connect ${role} to HTTPS localhost:${env.port}`, 15000);
  const sync = await bounded(client.pluginManager.get('sync'), `${role} shared clock`);
  return { client, sync };
}

async function run() {
  console.log(`Smoke: real soundworks connections at https://localhost:${env.port}; two simulated phones.`);
  console.log('This does not validate phone sensors, speakers, browser permissions or physical latency.');
  ({ client: controller } = await connect('controller'));
  [global, players] = await bounded(Promise.all([
    controller.stateManager.attach('global'),
    controller.stateManager.getCollection('player'),
  ]), 'attach researcher states');
  assert.equal(global.get('recording'), false, 'Refusing to interrupt an active recording');
  assert.equal(players.length, 0, 'Disconnect real phones before running this simulated test');
  assert.equal(global.get('phase'), 'idle', 'Put the unused development server in idle before testing');
  ownsSession = true;

  resultListener = ({ id, ok, error }) => {
    const pending = pendingCommands.get(id);
    if (pending) {
      if (ok) {
        pending.resolve();
      } else {
        pending.reject(new Error(error || 'Research command failed'));
      }
    }
  };
  controller.socket.addListener('research:result', resultListener);

  const phones = await Promise.all([connect('player'), connect('player')]);
  for (const phone of phones) {
    const checkin = await bounded(phone.client.pluginManager.get('checkin'), 'phone checkin');
    phone.index = checkin.getIndex();
    phone.state = await bounded(phone.client.stateManager.create('player', {
      index: phone.index,
      ready: true,
      sensorAvailable: false,
      audioState: 'simulated',
    }), 'create simulated phone state');
    phone.global = await bounded(phone.client.stateManager.attach('global'), 'phone global state');
  }
  assert.deepEqual(phones.map(phone => phone.index).sort(), [0, 1]);
  await expectPlayers(2);
  console.log('PASS checkin assigns distinct voice indices 0 and 1.');

  await command('record-start', { groupId, order: params.phaseOrder });
  hasRecorded = true;
  await expectGlobal(() => global.get('recording') && global.get('groupId') === groupId, 'recording start');
  const logFile = global.get('logFile');
  assert.equal(path.basename(logFile), logFile);
  assert.ok(logFile.includes(groupId));

  const samples = phones.map(phone => ({
    index: phone.index,
    time: phone.sync.getSyncTime() - 0.01,
    tilt: phone.index === 0 ? 0.25 : 0.75,
    intensity: phone.index === 0 ? 0.7 : 0.8,
  }));
  await bounded(Promise.all(phones.map((phone, i) => phone.state.set({
    sampleTime: samples[i].time,
    tilt: samples[i].tilt,
    intensity: samples[i].intensity,
  }))), 'publish sensor features');

  await command('phase', { phase: 'consensus' });
  await expectGlobal(() => global.get('phase') === 'consensus', 'consensus phase');
  const peaks = phones.map(phone => ({ index: phone.index, time: phone.sync.getSyncTime() }));
  await bounded(Promise.all(phones.map((phone, i) => phone.state.set({ peak: peaks[i].time }))), 'publish aligned peaks');
  await expectGlobal(() => global.get('jointActive'), 'server consensus activation');
  const jointStart = global.get('jointStart');
  assert.ok(Number.isFinite(jointStart));
  await Promise.all(phones.map(phone => observe(
    callback => phone.global.onUpdate(callback),
    () => phone.global.get('jointActive') && phone.global.get('jointStart') === jointStart,
    `phone ${phone.index} receives identical common-layer start`,
  )));
  console.log('PASS shared features and server consensus reach both phones with one scheduled start.');

  await command('sync-beep');
  await command('phase', { phase: 'idle' });
  await expectGlobal(() => global.get('phase') === 'idle' && !global.get('jointActive'), 'idle resets joint layer');
  await command('record-stop');
  hasRecorded = false;
  await expectGlobal(() => !global.get('recording'), 'recording stop');

  const logPath = path.join(root, 'logs', logFile);
  const text = await readFile(logPath, 'utf8');
  const records = text.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.every(record => Number.isFinite(record.t) && typeof record.type === 'string'));
  for (const type of ['session', 'device', 'features', 'peak', 'phase', 'cue', 'joint', 'syncBeep', 'session-end']) {
    assert.ok(records.some(record => record.type === type), `JSONL contains ${type}`);
  }
  const session = records.find(record => record.type === 'session');
  assert.equal(session.groupId, groupId);
  assert.deepEqual(session.params, params);
  assert.deepEqual(session.order, params.phaseOrder);
  for (const sample of samples) {
    const feature = records.find(record => record.type === 'features' && record.i === sample.index);
    assert.equal(feature.t, sample.time, 'feature retains source shared timestamp');
    assert.equal(feature.tilt, sample.tilt);
    assert.equal(feature.intensity, sample.intensity);
  }
  for (const peak of peaks) {
    assert.ok(records.some(record => record.type === 'peak' && record.i === peak.index && record.t === peak.time));
  }
  const joint = records.find(record => record.type === 'joint' && record.on);
  assert.equal(joint.t, jointStart);
  assert.ok(joint.t > joint.scheduledAt, 'common-layer start is scheduled ahead');
  assert.ok(records.some(record => record.type === 'joint' && !record.on));
  for (const record of records.filter(record => record.type === 'cue' || record.type === 'syncBeep')) {
    assert.ok(Math.abs(record.t - record.scheduledAt - params.eventLeadTime) < 1e-6);
  }
  const ending = records.at(-1);
  assert.equal(ending.type, 'session-end');
  assert.deepEqual(ending.actualOrder, ['idle', 'consensus', 'idle']);
  assert.ok(ending.t >= records.find(record => record.type === 'syncBeep').t + params.audio.cueDuration);
  console.log(`PASS real JSONL recording, source timestamps, cues and sync beep: ${logPath}`);

  await bounded(Promise.all(phones.map(phone => phone.client.stop())), 'disconnect simulated phones');
  await expectPlayers(0);
  console.log('PASS disconnect removes both simulated phone states.');
}

async function cleanup() {
  if (ownsSession && controller?.status === 'started') {
    try {
      await command('phase', { phase: 'idle' });
      if (hasRecorded || (global?.get('recording') && global?.get('groupId') === groupId)) {
        await command('record-stop');
      }
    } catch (error) {
      console.error(`Smoke cleanup: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (resultListener) {
    controller.socket.removeListener('research:result', resultListener);
  }
  const stopped = await Promise.allSettled(clients.map(async client => {
    if (client.status === 'started') {
      await bounded(client.stop(), `stop ${client.role}`, 3000);
    } else if (client.status !== 'stopped' && client.id !== null) {
      client.socket.close();
    }
  }));
  if (stopped.some(result => result.status === 'rejected')) {
    process.exitCode = 1;
  }
}

try {
  await run();
} catch (error) {
  console.error(`FAIL smoke: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  // Explicit exit also covers plugin/socket retry timers after a failed startup.
  process.exit(process.exitCode ?? 0);
}
