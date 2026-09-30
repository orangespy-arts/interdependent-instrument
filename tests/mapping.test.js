import test from 'node:test';
import assert from 'node:assert/strict';
import params from '../src/shared/params.js';
import { computeVoiceParams } from '../src/shared/mapping.js';

const a = { tilt: 0, intensity: 0.2 };
const b = { tilt: 1, intensity: 0.8 };
const map = (phase, me, global = {}, own = me === 0 ? a : b, partner = me === 0 ? b : a) =>
  computeVoiceParams(phase, me, own, partner, global);

test('familiarization maps each participant to their own pitch and density', () => {
  assert.equal(map('familiarization', 0).midi, params.scale[0]);
  assert.equal(map('familiarization', 1).midi, params.scale.at(-1));
  assert.equal(map('familiarization', 0).density, 2);
  assert.equal(map('familiarization', 1).density, 6.5);
});

test('division uses the same pitch role and density role on both devices, including swap', () => {
  for (const me of [0, 1]) {
    const normal = map('division', me);
    assert.equal(normal.midi, params.scale[0]);
    assert.equal(normal.density, 6.5);
    const swapped = map('division', me, { divisionSwap: true });
    assert.equal(swapped.midi, params.scale.at(-1));
    assert.equal(swapped.density, 2);
  }
});

test('modulation changes timbre from partner intensity without changing local pitch or density', () => {
  const baseline = map('familiarization', 0);
  const modulated = map('modulation', 0);
  assert.equal(modulated.midi, baseline.midi);
  assert.equal(modulated.density, baseline.density);
  const [low, high] = params.timbreRange;
  // Exponential mapping: partner intensity 0.8 / 0.2 → cutoff at 80% / 20% of the octave span.
  assert.ok(Math.abs(modulated.cutoff - low * (high / low) ** 0.8) < 1e-9);
  assert.ok(Math.abs(map('modulation', 1).cutoff - low * (high / low) ** 0.2) < 1e-9);
  assert.ok(Math.abs(baseline.cutoff - Math.sqrt(low * high)) < 1e-9);
  // A resting partner darkens the sound to the bottom of the range.
  assert.equal(computeVoiceParams('modulation', 0, a, { tilt: 0.5, intensity: 0 }).cutoff, low);
});

test('consensus ducks only when the joint layer is active', () => {
  assert.equal(map('consensus', 0).gain, 1);
  assert.equal(map('consensus', 0, { jointActive: true }).gain, params.duckGain);
  assert.ok(map('consensus', 0, { jointActive: true }).gain > 0);
  for (const phase of ['familiarization', 'division', 'modulation']) {
    assert.equal(map(phase, 0, { jointActive: true }).gain, 1);
  }
});

test('all four stages remain audible with an absent or resting partner (C5)', () => {
  for (const phase of params.phaseOrder) {
    for (const me of [0, 1]) {
      for (const divisionSwap of [false, true]) {
        const voice = computeVoiceParams(phase, me, { tilt: 0.9, intensity: 1 }, null, { divisionSwap });
        assert.equal(voice.enabled, true);
        assert.ok(voice.gain > 0);
        assert.ok(voice.density >= 0.5);
      }
    }
  }
});

test('idle, latency test, unknown stages and unassigned devices disable continuous voices', () => {
  for (const phase of ['idle', 'latency-test', 'unknown', null]) {
    assert.equal(map(phase, 0).enabled, false);
    assert.equal(map(phase, 0).gain, 0);
  }
  assert.equal(map('familiarization', -1).enabled, false);
});

test('mapping is finite for incomplete features and uses one quantized scale everywhere (C7)', () => {
  for (const phase of params.phaseOrder) {
    for (const tilt of [-2, 0, 0.23, 0.5, 0.75, 1, 20, NaN]) {
      const voice = computeVoiceParams(phase, 0, { tilt, intensity: Infinity }, {}, {});
      assert.ok(params.scale.includes(voice.midi));
      assert.ok(Object.values(voice).every(value => typeof value === 'boolean' || Number.isFinite(value)));
    }
  }
  const a4 = computeVoiceParams('familiarization', 0, { tilt: 0.9 });
  assert.equal(a4.midi, 69);
  assert.equal(a4.frequency, 440);
});
