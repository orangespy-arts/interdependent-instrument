import test from 'node:test';
import assert from 'node:assert/strict';
import params from '../src/shared/params.js';
import { Session } from '../src/server/Session.js';
import { globalDescription, playerDescription } from '../src/shared/state-descriptions.js';

class FakeState {
  constructor(id, description, values = {}) {
    this.id = id;
    this.values = { ...Object.fromEntries(Object.entries(description).map(([key, field]) => [key, field.default])), ...values };
    this.updates = [];
  }
  get(key) {
    return this.values[key]; 
  }
  getValues() {
    return { ...this.values }; 
  }
  async set(updates) {
    Object.assign(this.values, updates);
    this.updates.push({ ...updates });
  }
}

class FakePlayers extends Array {
  onAttach(callback, immediate) {
    this.attached = callback;
    if (immediate) {
      this.forEach(callback);
    }
  }
  onDetach(callback) {
    this.detached = callback; 
  }
  onUpdate(callback) {
    this.updated = callback; 
  }
  update(index, updates) {
    const state = this.find(player => player.get('index') === index);
    Object.assign(state.values, updates);
    this.updated(state, updates);
  }
  detach(index) {
    const position = this.findIndex(player => player.get('index') === index);
    const [state] = this.splice(position, 1);
    this.detached(state);
  }
}

function setup(t, phase = 'idle') {
  const global = new FakeState('global', globalDescription, { phase });
  const players = new FakePlayers(
    new FakeState('phone-a', playerDescription, { index: 0, ready: true, baseLatency: 0.01 }),
    new FakeState('phone-b', playerDescription, { index: 1, ready: true, baseLatency: 0.02 }),
  );
  const clock = { time: 10, getSyncTime() {
    return this.time; 
  } };
  const logger = {
    writers: [],
    async createWriter(name) {
      const writer = {
        pathname: `/logs/${name}`,
        records: [],
        closed: false,
        write(record) {
          assert.equal(this.closed, false, 'recording must not write after closing');
          this.records.push(structuredClone(record));
        },
        async close() {
          this.closed = true; 
        },
      };
      this.writers.push(writer);
      return writer;
    },
  };
  const session = new Session({ global, players, sync: clock, logger });
  t.after(() => session.close());
  return { global, players, clock, logger, session };
}

test('recording captures parameters, current state, planned and actual order, then closes once', async t => {
  const { global, session, clock, logger } = setup(t);
  const order = ['familiarization', 'consensus', 'modulation', 'division'];
  await session.command('record-start', { groupId: ' G03 ', order });
  const writer = logger.writers[0];
  assert.equal(global.get('recording'), true);
  assert.equal(global.get('groupId'), 'G03');
  assert.equal(global.get('logFile'), 'G03.jsonl');
  const snapshot = writer.records[0];
  assert.equal(snapshot.type, 'session');
  assert.equal(snapshot.t, 10);
  assert.deepEqual(snapshot.params, params);
  assert.deepEqual(snapshot.order, order);
  assert.equal(snapshot.phase, 'idle');
  assert.equal(writer.records.filter(record => record.type === 'device').length, 2);
  await assert.rejects(session.command('record-start', { groupId: 'G04' }));
  assert.equal(logger.writers.length, 1);

  clock.time = 11;
  await session.command('phase', { phase: 'familiarization' });
  clock.time = 13;
  await session.command('phase', { phase: 'consensus' });
  clock.time = 20;
  await session.command('record-stop');
  assert.equal(global.get('recording'), false);
  assert.equal(writer.closed, true);
  assert.deepEqual(writer.records.at(-1), {
    t: 20, type: 'session-end', groupId: 'G03', order, actualOrder: ['idle', 'familiarization', 'consensus'],
  });
  await assert.rejects(session.command('record-stop'));
  assert.equal(writer.records.filter(record => record.type === 'session-end').length, 1);
});

test('blank/unsafe group identifiers and invalid phase orders fail before creating a log', async t => {
  const { session, logger, global } = setup(t);
  for (const groupId of ['', '   ', '../G03', 'group/name', 'a'.repeat(41)]) {
    await assert.rejects(session.command('record-start', { groupId }));
  }
  for (const order of [[], 'random', ['division', 'familiarization', 'modulation', 'consensus'],
    ['familiarization', 'division', 'division', 'consensus'],
    ['familiarization', 'division', 'modulation', 'idle']]) {
    await assert.rejects(session.command('record-start', { groupId: 'G03', order }));
  }
  await assert.rejects(session.command('phase', { phase: 'unexpected' }));
  await assert.rejects(session.command('division-swap', { value: 'true' }));
  await assert.rejects(session.command('unexpected'));
  assert.equal(logger.writers.length, 0);
  assert.equal(global.get('phase'), 'idle');
  assert.equal(global.get('recording'), false);
});

test('phase transitions clear the common layer and send one neutral cue on the future shared clock', async t => {
  const { global, session, clock, logger } = setup(t, 'consensus');
  await session.command('record-start', { groupId: 'G03' });
  await global.set({ jointActive: true });
  clock.time = 40;
  await session.command('phase', { phase: 'division' });
  assert.equal(global.get('jointActive'), false);
  assert.equal(global.get('phaseStarted'), 40);
  assert.equal(global.get('cue'), 40 + params.eventLeadTime);
  const records = logger.writers[0].records;
  assert.deepEqual(records.find(record => record.type === 'cue'), {
    t: 40 + params.eventLeadTime, type: 'cue', scheduledAt: 40,
  });
  assert.equal(records.find(record => record.type === 'phase').t, 40);
  await session.command('phase', { phase: 'division' });
  assert.equal(records.filter(record => record.type === 'cue').length, 1);
});

test('feature logs retain source timestamps, throttle each phone separately and record every peak', async t => {
  const { session, clock, players, logger } = setup(t);
  await session.command('record-start', { groupId: 'G03' });
  players.update(0, { tilt: 0.2, intensity: 0.4, sampleTime: 9.9 });
  players.update(0, { tilt: 0.3, intensity: 0.5, sampleTime: 9.91 });
  players.update(1, { tilt: 0.8, intensity: 0.6, sampleTime: 9.92 });
  players.update(0, { peak: 9.95 });
  clock.time += 1 / params.logHz + 0.001;
  players.update(0, { tilt: 0.4, intensity: 0.7, sampleTime: 10.01 });
  const records = logger.writers[0].records;
  assert.deepEqual(records.filter(record => record.type === 'features').map(({ i, t }) => ({ i, t })), [
    { i: 0, t: 9.9 }, { i: 1, t: 9.92 }, { i: 0, t: 10.01 },
  ]);
  assert.deepEqual(records.find(record => record.type === 'peak'), { t: 9.95, type: 'peak', i: 0, received: 10 });
});

test('source time zero is a valid shared feature timestamp', async t => {
  const { session, players, logger } = setup(t);
  await session.command('record-start', { groupId: 'G03' });
  players.update(0, { tilt: 0.2, intensity: 0.4, sampleTime: 0 });
  assert.equal(logger.writers[0].records.find(record => record.type === 'features').t, 0);
});

test('consensus starts only with two ready participants and expires after its shared hold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, global, players, clock, logger } = setup(t, 'consensus');
  await session.command('record-start', { groupId: 'G03' });
  players.update(1, { ready: false });
  players.update(0, { peak: 10 });
  players.update(1, { peak: 10 });
  assert.equal(global.get('jointActive'), false);
  players.update(1, { ready: true });
  clock.time = 10.1;
  players.update(0, { peak: 10.08 });
  players.update(1, { peak: 10.1 });
  assert.equal(global.get('jointActive'), true);
  assert.equal(global.get('jointStart'), 10.1 + params.eventLeadTime);
  const start = global.get('jointStart');
  clock.time = start + params.jointHold;
  t.mock.timers.tick((params.eventLeadTime + params.jointHold) * 1000 + 1);
  assert.equal(global.get('jointActive'), false);
  const joint = logger.writers[0].records.filter(record => record.type === 'joint');
  assert.deepEqual(joint.map(record => record.on), [true, false]);
  assert.equal(joint[0].t, start);
});

test('disconnect and phase departure clear alignment evidence and prevent a late hold timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, global, players, clock } = setup(t, 'consensus');
  players.update(0, { peak: 10 });
  players.update(1, { peak: 10 });
  assert.equal(global.get('jointActive'), true);
  players.detach(1);
  assert.equal(global.get('jointActive'), false);
  await session.command('phase', { phase: 'familiarization' });
  const updates = global.updates.length;
  clock.time = 100;
  t.mock.timers.tick(10000);
  assert.equal(global.updates.length, updates);
});

test('stopping just after a sync beep waits until its scheduled sound has finished', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, global, clock, logger } = setup(t);
  await session.command('record-start', { groupId: 'G03' });
  await session.command('sync-beep');
  const beep = global.get('syncBeep');
  const writer = logger.writers[0];
  assert.deepEqual(writer.records.find(record => record.type === 'syncBeep'), {
    t: beep, type: 'syncBeep', scheduledAt: 10,
  });
  const stopping = session.command('record-stop');
  assert.equal(writer.closed, false);
  assert.equal(global.get('recording'), true);
  clock.time = beep + params.audio.cueDuration + 0.001;
  t.mock.timers.tick((params.eventLeadTime + params.audio.cueDuration) * 1000 + 1);
  await stopping;
  assert.equal(writer.closed, true);
  assert.ok(writer.records.at(-1).t >= beep + params.audio.cueDuration);
});

test('researcher marks keep the click time, phase and offset from the start sync beep', async t => {
  const { session, global, clock, logger } = setup(t);
  await assert.rejects(session.command('mark', { time: 10 }));
  await session.command('record-start', { groupId: 'G03' });
  await session.command('sync-beep');
  const beep = global.get('syncBeep');
  clock.time = 30;
  await session.command('phase', { phase: 'modulation' });
  clock.time = 45;
  // Clicked at 44, arrived at 45.
  await session.command('mark', { time: 44 });
  // Implausible client times fall back to the server's time.
  await session.command('mark', { time: 45 - params.markMaxDelay - 1 });
  await session.command('mark', { time: 'soon' });
  const marks = global.get('marks');
  assert.deepEqual(marks.map(mark => mark.n), [1, 2, 3]);
  assert.deepEqual(marks.map(mark => mark.t), [44, 45, 45]);
  assert.equal(marks[0].phase, 'modulation');
  assert.equal(marks[0].phaseElapsed, 14);
  assert.equal(marks[0].sinceBeep, 44 - beep);
  const record = logger.writers[0].records.find(entry => entry.type === 'mark');
  assert.deepEqual(record, { t: 44, type: 'mark', n: 1, phase: 'modulation', phaseElapsed: 14, sinceBeep: 44 - beep, received: 45 });

  await session.command('mark-note', { n: 1, note: '  两人停下，互相看  ' });
  assert.equal(global.get('marks')[0].note, '两人停下，互相看');
  assert.deepEqual(logger.writers[0].records.at(-1), { t: 45, type: 'mark-note', n: 1, note: '两人停下，互相看' });
  await assert.rejects(session.command('mark-note', { n: 9, note: 'x' }));
  await assert.rejects(session.command('mark-note', { n: 1, note: 'x'.repeat(201) }));

  await session.command('record-stop');
  await assert.rejects(session.command('mark', { time: 45 }));
  await assert.rejects(session.command('mark-note', { n: 1, note: 'late' }));
  assert.equal(global.get('marks').length, 3, 'marks stay visible for the interview after recording stops');
});

test('a new recording clears marks and the start beep reference', async t => {
  const { session, global, clock } = setup(t);
  await session.command('record-start', { groupId: 'G03' });
  await session.command('sync-beep');
  await session.command('mark', { time: 10 });
  await session.command('record-stop');
  clock.time = 100;
  await session.command('record-start', { groupId: 'G04' });
  assert.deepEqual(global.get('marks'), []);
  await session.command('mark', { time: 100 });
  assert.equal(global.get('marks')[0].n, 1);
  assert.equal(global.get('marks')[0].sinceBeep, null);
  assert.equal(global.get('marks')[0].phaseElapsed, null);
});

test('reset returns to idle, clears the common layer and disconnects phones, but never during a recording', async t => {
  let resets = 0;
  const { session, global, logger } = setup(t, 'consensus');
  session.resetPlayers = () => {
    resets += 1;
  };
  await session.command('record-start', { groupId: 'G03' });
  await session.command('mark', { time: 10 });
  await assert.rejects(session.command('reset'));
  assert.equal(resets, 0);
  await session.command('record-stop');
  await global.set({ jointActive: true, divisionSwap: true, phaseStarted: 5 });
  await session.command('reset');
  assert.equal(resets, 1);
  assert.equal(global.get('phase'), 'idle');
  assert.equal(global.get('phaseStarted'), 0);
  assert.equal(global.get('jointActive'), false);
  assert.equal(global.get('divisionSwap'), false);
  assert.equal(global.get('marks').length, 1, 'marks stay for the interview');
  assert.equal(logger.writers[0].closed, true);
});
