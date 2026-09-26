import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureExtractor, createPeakDetector } from '../src/shared/features.js';

const direct = { smoothing: { attack: 1, release: 1 }, tiltGravitySmoothing: 1 };
const sample = (y, rotation = 0) => ({
  accelerationIncludingGravity: { x: 0, y, z: Math.sqrt(Math.max(0, 1 - y * y)) },
  rotationRate: { alpha: rotation, beta: 0, gamma: 0 },
});

test('tilt uses gravity, clamps the configured range and supports calibration axes', () => {
  const features = createFeatureExtractor(direct);
  assert.equal(features.process(sample(0), 0).tilt, 0.5);
  assert.equal(features.process(sample(-1), 1).tilt, 0);
  assert.equal(features.process(sample(1), 2).tilt, 1);
  assert.ok(Math.abs(features.process(sample(0.5), 3).tilt - 0.75) < 1e-10);
  const xAxis = createFeatureExtractor({ ...direct, tiltAxis: 'x' });
  assert.equal(xAxis.process({ accelerationIncludingGravity: { x: 1, y: 0, z: 0 } }, 0).tilt, 1);
});

test('intensity uses the full rotation magnitude and saturates safely', () => {
  const features = createFeatureExtractor(direct);
  assert.equal(features.process({ rotationRate: { alpha: 108, beta: 144, gamma: 0 } }, 0).intensity, 0.5);
  assert.equal(features.process(sample(0, -720), 1).intensity, 1);
  assert.equal(features.process(sample(0, 0), 2).intensity, 0);
});

test('attack is faster than release, with no fabricated gravity reading', () => {
  const features = createFeatureExtractor();
  assert.equal(features.process(sample(0, 360), 0).intensity, 0.3);
  assert.equal(features.process(null, 1).intensity, 0.285);
  assert.equal(features.process({}, 2).tilt, 0.5);
});

test('missing sensor fields stay finite and preserve the last measured tilt', () => {
  const features = createFeatureExtractor(direct);
  const valid = features.process(sample(0.5), 0);
  for (const event of [null, {}, {
    accelerationIncludingGravity: { x: null, y: null, z: null },
    rotationRate: { alpha: NaN, beta: null, gamma: Infinity },
  }, { accelerationIncludingGravity: { x: 0, y: 0, z: 0 } }]) {
    const result = features.process(event);
    assert.equal(result.tilt, valid.tilt);
    assert.equal(result.intensity, 0);
    assert.equal(result.peak, null);
  }
});

test('a peak requires a threshold crossing and local maximum, preserving original time', () => {
  const detector = createPeakDetector();
  assert.equal(detector.process(0.4, 10), null);
  assert.equal(detector.process(0.5, 10.1), null);
  assert.equal(detector.process(0.6, 10.2), null);
  assert.equal(detector.process(0.9, 10.3), null);
  assert.equal(detector.process(0.8, 10.4), 10.3);
  // Another maximum while still above threshold is not another gesture.
  assert.equal(detector.process(0.95, 10.8), null);
  assert.equal(detector.process(0.8, 10.9), null);
  detector.process(0.2, 11);
  detector.process(0.8, 11.1);
  assert.equal(detector.process(0.2, 11.2), 11.1);
});

test('plateau maxima use their first time and refractory duration uses peak times', () => {
  const detector = createPeakDetector({ refractory: 0.25 });
  detector.process(0.7, 1);
  detector.process(0.7, 1.01);
  assert.equal(detector.process(0.1, 1.02), 1);
  detector.process(0.8, 1.2);
  // Confirming late must not bypass refractory when the maximum was too early.
  assert.equal(detector.process(0.1, 1.24), null);
  detector.process(0.8, 1.25);
  assert.equal(detector.process(0.1, 1.3), 1.25);
});

test('invalid or out-of-order samples cannot create a peak or change its timestamp', () => {
  const detector = createPeakDetector();
  detector.process(0.8, 2);
  assert.equal(detector.process(0.1, 1), null);
  assert.equal(detector.process(0.1, 2), null);
  assert.equal(detector.process(NaN, 2.1), null);
  assert.equal(detector.process(0.1, NaN), null);
  assert.equal(detector.process(0.1, 2.2), 2);
});

test('extractor passes shared peak time through and reset clears history', () => {
  const features = createFeatureExtractor(direct);
  features.process(sample(1, 288), 100);
  assert.equal(features.process(sample(1, 36), 100.1).peak, 100);
  features.reset();
  assert.deepEqual(features.process({}, 0), { tilt: 0.5, intensity: 0, peak: null });
  features.process(sample(0, 288), 0.1);
  assert.equal(features.process(sample(0, 0), 0.2).peak, 0.1);
});
