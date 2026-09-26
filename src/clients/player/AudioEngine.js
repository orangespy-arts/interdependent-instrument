import params from '../../shared/params.js';
import { computeVoiceParams } from '../../shared/mapping.js';

const SILENCE = 0.0001;
const INITIAL_FEATURES = { tilt: 0.5, intensity: 0 };

/**
 * One local synthesizer per phone. The sync clock must use this AudioContext's
 * currentTime as its local clock; sensor updates never wait for the network.
 */
export default class AudioEngine {
  constructor(audioContext, sync, index) {
    if (index !== 0 && index !== 1) {
      throw new RangeError('An audio engine needs a checkin index of 0 or 1');
    }

    this.context = audioContext;
    this.sync = sync;
    Object.defineProperty(this, 'index', { value: index, enumerable: true });
    this.own = { ...INITIAL_FEATURES };
    this.partner = { ...INITIAL_FEATURES };
    this.global = { phase: 'idle', divisionSwap: false, jointActive: false, jointStart: 0 };
    this.running = false;
    this.destroyed = false;
    this.sources = new Set();
    this.lastVoiceTime = null;
    this.jointAnchor = null;
    this.jointStep = 0;

    this.voiceFilter = audioContext.createBiquadFilter();
    this.voiceFilter.type = 'lowpass';
    this.voiceFilter.Q.value = params.audio.filterQ;
    this.voiceGain = audioContext.createGain();
    this.voiceGain.gain.value = 0;
    this.duckGain = audioContext.createGain();
    this.duckGain.gain.value = 1;
    this.voiceFilter.connect(this.voiceGain);
    this.voiceGain.connect(this.duckGain);
    this.duckGain.connect(audioContext.destination);

    this.jointFilter = audioContext.createBiquadFilter();
    this.jointFilter.type = 'lowpass';
    this.jointFilter.Q.value = params.audio.filterQ;
    this.jointFilter.frequency.value = (params.timbreRange[0] + params.timbreRange[1]) / 2;
    this.jointGain = audioContext.createGain();
    this.jointGain.gain.value = 0;
    this.jointFilter.connect(this.jointGain);
    this.jointGain.connect(audioContext.destination);
  }

  setOwn(features) {
    Object.assign(this.own, features);
    this.tick();
  }

  setPartner(features) {
    Object.assign(this.partner, features ?? INITIAL_FEATURES);
    this.tick();
  }

  /** Apply state first, then call cue()/syncBeep() for any incoming events. */
  setGlobal(values) {
    const previousPhase = this.global.phase;
    const previousStart = this.global.jointStart;
    Object.assign(this.global, values);

    if (previousPhase !== this.global.phase) {
      this.cancelSources(['voice']);
      this.lastVoiceTime = null;
      this.endJoint();
      // A previously queued measurement/cue must not survive the idle command.
      if (this.global.phase === 'idle') {
        this.cancelSources();
      }
    }

    if (this.running && this.global.phase === 'consensus' && this.global.jointActive) {
      if (this.jointAnchor === null || previousStart !== this.global.jointStart) {
        this.beginJoint(this.global.jointStart);
      }
    } else {
      this.endJoint();
    }

    this.tick();
  }

  start() {
    if (this.destroyed) {
      throw new Error('Cannot restart a destroyed audio engine');
    }
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastVoiceTime = null;
    this.setGlobal({});
    this.timer = globalThis.setInterval(() => this.tick(), params.schedulerInterval * 1000);
  }

  stop() {
    this.running = false;
    globalThis.clearInterval(this.timer);
    this.timer = null;
    this.lastVoiceTime = null;
    this.endJoint();
    this.cancelSources();
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.stop();
    this.destroyed = true;
    for (const node of [this.voiceFilter, this.voiceGain, this.duckGain, this.jointFilter, this.jointGain]) {
      node.disconnect();
    }
  }

  cue(syncTime) {
    return this.eventPulse('cue', syncTime, params.audio.cueFrequency, params.audio.cueDuration, params.audio.cueGain);
  }

  syncBeep(syncTime) {
    return this.eventPulse('syncBeep', syncTime, params.audio.cueFrequency, params.audio.cueDuration, params.audio.cueGain);
  }

  click() {
    if (!this.running || this.global.phase !== 'latency-test') {
      return false;
    }
    this.pulse('click', params.audio.clickFrequency, this.context.currentTime, params.audio.clickDuration, params.audio.clickGain);
    return true;
  }

  eventPulse(kind, syncTime, frequency, duration, gain) {
    if (!this.running || !Number.isFinite(syncTime)) {
      return false;
    }
    const localTime = this.sync.getLocalTime(syncTime);
    if (!Number.isFinite(localTime)) {
      return false;
    }
    this.pulse(kind, frequency, Math.max(this.context.currentTime, localTime), duration, gain);
    return true;
  }

  tick() {
    if (!this.running) {
      return;
    }
    const now = this.context.currentTime;
    const horizon = now + params.scheduleAhead;
    const voice = computeVoiceParams(this.global.phase, this.index, this.own, this.partner, this.global);
    this.voiceFilter.frequency.setTargetAtTime(voice.cutoff, now, params.audio.attack);
    // Mapping.gain describes the final mix. Apply its ducking only once, on the
    // dedicated node at the synchronized onset rather than when state arrives.
    this.voiceGain.gain.setTargetAtTime(params.audio.voiceGain * (voice.enabled ? 1 : 0), now, params.audio.attack);

    if (voice.enabled && voice.density > 0) {
      const interval = 1 / voice.density;
      // Recompute from the last onset on every sensor/scheduler update. Keeping
      // an old next-onset time would make an increase from 0.5 Hz lag by 2 s.
      let next = this.lastVoiceTime === null ? now : this.lastVoiceTime + interval;
      next = Math.max(now, next);
      while (next <= horizon) {
        this.note('voice', voice.frequency, next, this.voiceFilter);
        this.lastVoiceTime = next;
        next += interval;
      }
    }

    if (this.jointAnchor !== null) {
      const interval = params.audio.jointInterval;
      // Skip missed beats after backgrounding; never burst accumulated notes.
      this.jointStep = Math.max(this.jointStep, Math.ceil((now - this.jointAnchor) / interval));
      let next = this.jointAnchor + this.jointStep * interval;
      while (next <= horizon) {
        // Provisional common material: an interlocking pentatonic arpeggio.
        // Both phones use the same pattern, offset by their fixed voice index.
        const degrees = params.audio.jointScaleDegrees;
        const degree = degrees[(this.jointStep + this.index) % degrees.length];
        const midi = params.scale[degree];
        this.note('joint', 440 * 2 ** ((midi - 69) / 12), next, this.jointFilter);
        this.jointStep += 1;
        next = this.jointAnchor + this.jointStep * interval;
      }
    }
  }

  beginJoint(syncTime) {
    const anchor = this.sync.getLocalTime(syncTime);
    if (!Number.isFinite(anchor)) {
      return;
    }
    this.cancelSources(['joint']);
    this.jointAnchor = anchor;
    this.jointStep = 0;
    const now = this.context.currentTime;
    const onset = Math.max(now, anchor);
    const fadeEnd = onset + params.audio.jointFade;
    this.jointGain.gain.cancelScheduledValues(now);
    this.jointGain.gain.setValueAtTime(0, now);
    this.jointGain.gain.setValueAtTime(0, onset);
    this.jointGain.gain.linearRampToValueAtTime(params.audio.jointGain, fadeEnd);
    this.duckGain.gain.cancelScheduledValues(now);
    this.duckGain.gain.setValueAtTime(1, now);
    this.duckGain.gain.setValueAtTime(1, onset);
    this.duckGain.gain.linearRampToValueAtTime(params.duckGain, fadeEnd);
  }

  endJoint() {
    if (this.jointAnchor === null) {
      return;
    }
    this.jointAnchor = null;
    this.jointStep = 0;
    const now = this.context.currentTime;
    this.ramp(this.jointGain.gain, 0, now, params.audio.jointFade);
    this.ramp(this.duckGain.gain, 1, now, params.audio.jointFade);
    this.cancelSources(['joint'], params.audio.jointFade);
  }

  ramp(parameter, value, now, duration) {
    if (parameter.cancelAndHoldAtTime) {
      parameter.cancelAndHoldAtTime(now);
    } else {
      const currentValue = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(currentValue, now);
    }
    parameter.linearRampToValueAtTime(value, now + duration);
  }

  note(kind, frequency, time, destination) {
    const { oscillator, envelope } = this.source(kind, frequency, time, destination);
    const end = time + params.audio.noteDuration + params.audio.release;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(1, time + params.audio.attack);
    envelope.gain.setValueAtTime(1, time + params.audio.noteDuration);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, end);
    oscillator.start(time);
    oscillator.stop(end);
  }

  pulse(kind, frequency, time, duration, gain) {
    const { oscillator, envelope } = this.source(kind, frequency, time, this.context.destination);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(gain, time + Math.min(params.audio.attack, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(SILENCE, time + duration);
    oscillator.start(time);
    oscillator.stop(time + duration);
  }

  source(kind, frequency, time, destination) {
    const oscillator = this.context.createOscillator();
    oscillator.type = params.audio.waveform;
    oscillator.frequency.setValueAtTime(frequency, time);
    const envelope = this.context.createGain();
    oscillator.connect(envelope);
    envelope.connect(destination);
    const source = { kind, time, oscillator, envelope };
    this.sources.add(source);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      this.sources.delete(source);
    };
    return source;
  }

  cancelSources(kinds = null, fade = params.audio.attack) {
    const now = this.context.currentTime;
    for (const source of this.sources) {
      if (kinds && !kinds.includes(source.kind)) {
        continue;
      }
      if (source.time > now) {
        // stop() before the scheduled start prevents the future sound entirely.
        source.oscillator.stop(now);
      } else {
        this.ramp(source.envelope.gain, 0, now, fade);
        source.oscillator.stop(now + fade);
      }
    }
  }
}
