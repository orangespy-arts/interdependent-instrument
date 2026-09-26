import params from './params.js';

const clampUnit = (value, fallback) => Number.isFinite(value)
  ? Math.max(0, Math.min(1, value))
  : fallback;
const interpolate = ([min, max], position) => min + (max - min) * position;

/** Pure phase mapping: a device always renders its assigned voice (me). */
export function computeVoiceParams(phase, me, own = {}, partner = {}, global = {}) {
  const active = params.phaseOrder.includes(phase) && (me === 0 || me === 1);
  let pitchSource = own;
  let densitySource = own;

  if (phase === 'division') {
    const pitchPlayer = global?.divisionSwap ? 1 : 0;
    pitchSource = me === pitchPlayer ? own : partner;
    densitySource = me === pitchPlayer ? partner : own;
  }

  const tilt = clampUnit(pitchSource?.tilt, 0.5);
  const intensity = clampUnit(densitySource?.intensity, 0);
  const scaleIndex = Math.round(tilt * (params.scale.length - 1));
  const midi = params.scale[scaleIndex];
  const cutoffPosition = phase === 'modulation'
    ? clampUnit(partner?.intensity, 0)
    : 0.5;

  return {
    midi,
    frequency: 440 * 2 ** ((midi - 69) / 12),
    density: interpolate(params.densityRange, intensity),
    cutoff: interpolate(params.timbreRange, cutoffPosition),
    gain: active ? (phase === 'consensus' && global?.jointActive ? params.duckGain : 1) : 0,
    enabled: active,
  };
}

export default computeVoiceParams;
