import params from './params.js';

const clampUnit = value => Math.max(0, Math.min(1, value));
const finiteOrZero = value => Number.isFinite(value) ? value : 0;

function normalize(value, [min, max]) {
  return clampUnit((value - min) / (max - min));
}

function smooth(previous, value, smoothing) {
  const coefficient = value > previous ? smoothing.attack : smoothing.release;
  return previous + coefficient * (value - previous);
}

/**
 * One local maximum per upward threshold crossing. A descending sample confirms
 * the maximum, but the returned timestamp belongs to the maximum itself. Flat
 * maxima retain their first timestamp. Refractory duration is in shared seconds.
 */
export function createPeakDetector({
  threshold = params.peakThreshold,
  refractory = params.peakRefractory,
} = {}) {
  let previous = 0;
  let previousTime = -Infinity;
  let lastPeak = -Infinity;
  let candidate = null;

  return {
    process(intensity, time) {
      if (!Number.isFinite(intensity) || !Number.isFinite(time) || time <= previousTime) {
        return null;
      }

      const value = clampUnit(intensity);
      let peak = null;
      if (previous <= threshold && value > threshold) {
        candidate = { value, time };
      } else if (candidate) {
        if (value > candidate.value) {
          candidate = { value, time };
        } else if (value < previous) {
          if (candidate.time - lastPeak >= refractory) {
            peak = candidate.time;
            lastPeak = peak;
          }
          candidate = null;
        }
      }

      previous = value;
      previousTime = time;
      return peak;
    },
    reset() {
      previous = 0;
      previousTime = -Infinity;
      lastPeak = -Infinity;
      candidate = null;
    },
  };
}

/**
 * Convert browser/@ircam/devicemotion samples to shared features. Call process
 * with sync.getSyncTime() at sample arrival; timeStamp (milliseconds) is unused.
 * Angular velocity must be in degrees/second. Missing gravity preserves tilt;
 * absent rotation decays intensity toward rest instead of producing NaN.
 */
export function createFeatureExtractor(overrides = {}) {
  const settings = {
    ...params,
    ...overrides,
    smoothing: { ...params.smoothing, ...overrides.smoothing },
  };
  const peakDetector = createPeakDetector({
    threshold: settings.peakThreshold,
    refractory: settings.peakRefractory,
  });
  let gravity = null;
  let tilt = 0.5;
  let intensity = 0;

  return {
    process(event = {}, syncTimeSeconds) {
      const acceleration = event?.accelerationIncludingGravity;
      if (acceleration && ['x', 'y', 'z'].every(axis => Number.isFinite(acceleration[axis]))) {
        const magnitude = Math.hypot(acceleration.x, acceleration.y, acceleration.z);
        // Zero gravity is not an orientation measurement (e.g. null hardware).
        if (magnitude > Number.EPSILON) {
          if (gravity === null) {
            gravity = { x: acceleration.x, y: acceleration.y, z: acceleration.z };
          } else {
            for (const axis of ['x', 'y', 'z']) {
              gravity[axis] += settings.tiltGravitySmoothing * (acceleration[axis] - gravity[axis]);
            }
          }
          const axis = ['x', 'y', 'z'].includes(settings.tiltAxis) ? settings.tiltAxis : 'y';
          const otherAxes = ['x', 'y', 'z'].filter(key => key !== axis);
          const angle = Math.atan2(gravity[axis], Math.hypot(...otherAxes.map(key => gravity[key])))
            * 180 / Math.PI;
          tilt = smooth(tilt, normalize(angle, settings.tiltRange), settings.smoothing);
        }
      }

      const rotation = event?.rotationRate;
      const rotationMagnitude = Math.hypot(
        finiteOrZero(rotation?.alpha),
        finiteOrZero(rotation?.beta),
        finiteOrZero(rotation?.gamma),
      );
      intensity = smooth(intensity, normalize(rotationMagnitude, settings.intensityRange), settings.smoothing);
      return { tilt, intensity, peak: peakDetector.process(intensity, syncTimeSeconds) };
    },
    reset() {
      gravity = null;
      tilt = 0.5;
      intensity = 0;
      peakDetector.reset();
    },
  };
}

export default createFeatureExtractor;
