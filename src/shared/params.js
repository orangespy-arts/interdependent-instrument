/**
 * Shared, JSON-serializable pilot settings. Times are seconds unless named Hz.
 * Save this complete object with each recording so tuning remains traceable.
 */
export const params = {
  // C pentatonic, C3 through C5. Every phase uses the same sound material.
  scale: [48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72],
  tiltAxis: 'y',
  tiltRange: [-60, 60],
  intensityRange: [0, 360], // Magnitude of angular velocity in degrees/second.
  tiltGravitySmoothing: 0.15,
  smoothing: { attack: 0.3, release: 0.05 },
  peakThreshold: 0.5,
  peakRefractory: 0.25,
  densityRange: [0.5, 8], // A positive floor keeps solitary action audible (C5).
  timbreRange: [400, 6000],
  alignWindow: 0.2,
  jointHold: 2,
  duckGain: 0.6,
  // Study decisions still to be filled in after piloting; this is in minutes.
  phaseDuration: null,
  phaseOrder: ['familiarization', 'division', 'modulation', 'consensus'],
  featuresHz: 30,
  logHz: 25,
  scheduleAhead: 0.1,
  schedulerInterval: 0.025,
  eventLeadTime: 0.2,
  sensorTimeout: 2,
  heartbeatInterval: 1,
  commandTimeout: 8,
  maxPeakAge: 1,
  audio: {
    waveform: 'triangle',
    voiceGain: 0.18,
    attack: 0.01,
    release: 0.25,
    noteDuration: 0.12,
    filterQ: 0.7,
    jointGain: 0.12,
    jointFade: 0.12,
    jointInterval: 0.5,
    // Provisional common layer, indices into scale; validate in the pilot.
    jointScaleDegrees: [0, 2, 4],
    cueFrequency: 880,
    cueDuration: 0.08,
    cueGain: 0.15,
    clickFrequency: 1600,
    clickDuration: 0.025,
    clickGain: 0.2,
  },
};

export default params;
