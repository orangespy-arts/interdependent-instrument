import params from './params.js';

// English version of Appendix B (formerly 4.A); keep it verbatim to the thesis.
// Only substitute its duration placeholder once calibrated.
export const introduction = [
  'Welcome.',
  `For about the next ${params.phaseDuration === null ? '[X]' : params.phaseDuration * 4} minutes, you and the person opposite you will each hold a phone.`,
  'Tilt or shake the phone and it will make sound. The sound comes from the phone in your hand.',
  'There is no right or wrong way to play. Just explore freely.',
  'The experience is divided into several parts, with a cue tone between parts. In each part, your movements and your partner’s shape the sound in a different way.',
  'When you are ready, tap “Start”. The screen will then go dark and show, in dim drawings, how the current part works. It changes with each part; glance at it whenever you like.',
];
