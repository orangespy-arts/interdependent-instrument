import test from 'node:test';
import assert from 'node:assert/strict';
import AudioEngine from '../src/clients/player/AudioEngine.js';
import params from '../src/shared/params.js';

class FakeParameter {
  value = 0;
  events = [];
  setValueAtTime(value, time) {
    this.events.push({ type: 'set', value, time }); 
  }
  setTargetAtTime(value, time, constant) {
    this.events.push({ type: 'target', value, time, constant }); 
  }
  linearRampToValueAtTime(value, time) {
    this.events.push({ type: 'linear', value, time }); 
  }
  exponentialRampToValueAtTime(value, time) {
    this.events.push({ type: 'exponential', value, time }); 
  }
  cancelScheduledValues(time) {
    this.events.push({ type: 'cancel', time }); 
  }
  cancelAndHoldAtTime(time) {
    this.events.push({ type: 'hold', time }); 
  }
}

class FakeNode {
  connect(destination) {
    this.destination = destination; return destination; 
  }
  disconnect() {
    this.disconnected = true; 
  }
}

class FakeContext {
  currentTime = 0;
  destination = new FakeNode();
  oscillators = [];
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParameter() }); 
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { frequency: new FakeParameter(), Q: new FakeParameter() });
  }
  createOscillator() {
    const node = Object.assign(new FakeNode(), {
      frequency: new FakeParameter(), starts: [], stops: [],
      start(time) {
        this.starts.push(time); 
      },
      stop(time) {
        this.stops.push(time); 
      },
    });
    this.oscillators.push(node);
    return node;
  }
}

function setup(t, { index = 0, offset = 10, time = 0 } = {}) {
  const context = new FakeContext();
  context.currentTime = time;
  const sync = { getLocalTime: (time) => time - offset, getSyncTime: () => context.currentTime + offset };
  const engine = new AudioEngine(context, sync, index);
  t.after(() => engine.destroy());
  return { context, sync, engine };
}

test('cue and video beeps schedule at a future local audio time using one neutral sound', (t) => {
  const { context, engine } = setup(t);
  engine.start();
  assert.equal(engine.cue(12), true);
  assert.equal(engine.syncBeep(13), true);
  assert.equal(context.oscillators.length, 2);
  assert.deepEqual(context.oscillators.map((node) => node.starts[0]), [2, 3]);
  assert.deepEqual(context.oscillators.map((node) => node.frequency.events[0].value),
    [params.audio.cueFrequency, params.audio.cueFrequency]);
  assert.equal(engine.cue(Number.NaN), false);
});

test('raising intensity replaces a stale slow onset interval immediately', (t) => {
  const { context, engine } = setup(t);
  engine.setGlobal({ phase: 'familiarization' });
  engine.start();
  assert.deepEqual(context.oscillators.map((node) => node.starts[0]), [0]);

  context.currentTime = 0.2;
  engine.setOwn({ intensity: 1 });
  assert.deepEqual(context.oscillators.map((node) => node.starts[0]), [0, 0.2]);
  assert.equal(engine.voiceGain.gain.events.at(-1).value, params.audio.voiceGain);
});

test('ducking waits for the shared future joint onset, then fades together with the common layer', (t) => {
  const { context, engine } = setup(t, { time: 1 });
  engine.setGlobal({ phase: 'consensus' });
  engine.start();
  engine.setGlobal({ jointActive: true, jointStart: 13 });

  assert.equal(engine.jointAnchor, 3);
  assert.deepEqual(engine.duckGain.gain.events, [
    { type: 'cancel', time: 1 },
    { type: 'set', value: 1, time: 1 },
    { type: 'set', value: 1, time: 3 },
    { type: 'linear', value: params.duckGain, time: 3 + params.audio.jointFade },
  ]);
  assert.deepEqual(engine.jointGain.gain.events.at(-1),
    { type: 'linear', value: params.audio.jointGain, time: 3 + params.audio.jointFade });
  assert.equal(engine.voiceGain.gain.events.at(-1).value, params.audio.voiceGain);
  assert.equal([...engine.sources].filter((source) => source.kind === 'joint').length, 0);

  context.currentTime = 2.95;
  engine.tick();
  const joint = [...engine.sources].find((source) => source.kind === 'joint');
  assert.equal(joint.oscillator.starts[0], 3);
});

test('the two audio clocks place the common layer on the same shared time', (t) => {
  const a = setup(t, { index: 0, time: 2.95, offset: 10 });
  const b = setup(t, { index: 1, time: 7.95, offset: 5 });
  for (const { engine } of [a, b]) {
    engine.setGlobal({ phase: 'consensus', jointActive: true, jointStart: 13 });
    engine.start();
  }
  const jointA = [...a.engine.sources].find((source) => source.kind === 'joint');
  const jointB = [...b.engine.sources].find((source) => source.kind === 'joint');
  assert.equal(jointA.time + 10, jointB.time + 5);
  assert.equal(jointA.time + 10, 13);
  assert.notEqual(jointA.oscillator.frequency.events[0].value, jointB.oscillator.frequency.events[0].value);
});

test('ending consensus cancels a future joint onset and restores personal gain', (t) => {
  const { engine } = setup(t, { time: 0.95 });
  engine.setGlobal({ phase: 'consensus', jointActive: true, jointStart: 11 });
  engine.start();
  const joint = [...engine.sources].find((source) => source.kind === 'joint');
  assert.equal(joint.time, 1);
  engine.setGlobal({ jointActive: false });
  assert.equal(joint.oscillator.stops.at(-1), 0.95);
  assert.equal(engine.jointAnchor, null);
  assert.equal(engine.duckGain.gain.events.at(-1).value, 1);
});

test('idle cancels all queued sources and phase changes never change the assigned voice', (t) => {
  const { context, engine } = setup(t, { index: 1 });
  engine.setGlobal({ phase: 'familiarization' });
  engine.start();
  engine.cue(15);
  const cue = context.oscillators.at(-1);
  engine.setGlobal({ phase: 'idle' });
  assert.equal(cue.stops.at(-1), 0);
  assert.equal(engine.index, 1);
  assert.throws(() => {
    engine.index = 0; 
  }, TypeError);
  const count = context.oscillators.length;
  context.currentTime = 10;
  engine.setOwn({ intensity: 1 });
  assert.equal(context.oscillators.length, count);
});

test('latency clicks are immediate and teardown cancels playback and scheduling', (t) => {
  const { context, engine } = setup(t, { time: 2 });
  engine.start();
  assert.equal(engine.click(), false);
  engine.setGlobal({ phase: 'latency-test' });
  assert.equal(engine.click(), true);
  assert.equal(context.oscillators.at(-1).starts[0], 2);
  engine.stop();
  assert.equal(engine.timer, null);
  assert.equal(engine.click(), false);
  const count = context.oscillators.length;
  engine.setGlobal({ phase: 'familiarization' });
  engine.setOwn({ intensity: 1 });
  assert.equal(context.oscillators.length, count);
  engine.destroy();
  assert.equal(engine.voiceFilter.disconnected, true);
  assert.throws(() => engine.start(), /destroyed/);
});
