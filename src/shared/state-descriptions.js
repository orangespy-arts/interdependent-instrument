export const globalDescription = {
  phase: { type: 'string', default: 'idle' },
  phaseStarted: { type: 'float', default: 0 },
  groupId: { type: 'string', default: '' },
  recording: { type: 'boolean', default: false },
  divisionSwap: { type: 'boolean', default: false },
  jointActive: { type: 'boolean', default: false },
  jointStart: { type: 'float', default: 0 },
  cue: { type: 'float', default: null, event: true },
  syncBeep: { type: 'float', default: null, event: true },
  logFile: { type: 'string', default: '' },
  error: { type: 'string', default: '' },
  // [{ name, url, trusted }] for this server run; see server/participant-links.js.
  participantLinks: { type: 'any', default: [] },
};

export const playerDescription = {
  index: { type: 'integer', default: -1, min: -1, max: 1 },
  tilt: { type: 'float', default: 0.5, min: 0, max: 1 },
  intensity: { type: 'float', default: 0, min: 0, max: 1 },
  peak: { type: 'float', default: null, event: true },
  sampleTime: { type: 'float', default: 0 },
  ready: { type: 'boolean', default: false },
  sensorAvailable: { type: 'boolean', default: false },
  audioState: { type: 'string', default: 'suspended' },
  baseLatency: { type: 'float', default: -1 },
  outputLatency: { type: 'float', default: -1 },
  wakeLock: { type: 'boolean', default: false },
  visibility: { type: 'string', default: 'visible' },
  lastSeen: { type: 'float', default: 0 },
};
