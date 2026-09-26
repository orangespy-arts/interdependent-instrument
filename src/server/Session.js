import path from 'node:path';
import params from '../shared/params.js';
import { Consensus } from './Consensus.js';

const phases = ['idle', 'familiarization', 'division', 'modulation', 'consensus', 'latency-test'];
const rules = ['division', 'modulation', 'consensus'];

export class Session {
  constructor({ global, players, sync, logger }) {
    Object.assign(this, { global, players, sync, logger });
    this.writer = null;
    this.order = [];
    this.actualOrder = [];
    this.consensus = new Consensus(params);
    this.lastLogged = new Map();
    this.holdTimer = null;
    this.pendingBeepUntil = 0;
    players.onAttach(state => this.write('device', { i: state.get('index'), ...state.getValues() }), true);
    players.onDetach(state => {
      this.write('disconnect', { i: state.get('index') });
      this.lastLogged.delete(state.id);
      this.resetJoint().catch(error => console.error(error));
    });
    players.onUpdate((state, updates) => this.onPlayer(state, updates));
  }

  now() {
    return this.sync.getSyncTime(); 
  }

  write(type, data = {}, time = this.now()) {
    this.writer?.write({ t: time, type, ...data });
  }

  async resetJoint() {
    clearTimeout(this.holdTimer);
    this.consensus.reset();
    if (this.global.get('jointActive')) {
      await this.global.set({ jointActive: false });
      this.write('joint', { on: false });
    }
  }

  onPlayer(state, updates) {
    const i = state.get('index');
    const now = this.now();
    if (!updates.ready && updates.ready !== undefined) {
      this.resetJoint().catch(error => console.error(error));
    }
    if ('tilt' in updates || 'intensity' in updates) {
      // Select at most one update per log time bucket. An elapsed-time gate at
      // 25 Hz would otherwise drop every second 30 Hz update (only 15 Hz).
      if (Math.floor(now * params.logHz) > Math.floor((this.lastLogged.get(state.id) ?? -Infinity) * params.logHz)) {
        this.lastLogged.set(state.id, now);
        const sampleTime = state.get('sampleTime');
        this.write('features', { i, tilt: state.get('tilt'), intensity: state.get('intensity'), received: now }, Number.isFinite(sampleTime) ? sampleTime : now);
      }
    }
    if (['ready', 'sensorAvailable', 'audioState', 'baseLatency', 'outputLatency', 'wakeLock', 'visibility'].some(key => key in updates)) {
      this.write('device', { i, ...state.getValues() });
    }
    if ('peak' in updates) {
      this.write('peak', { i, received: now }, updates.peak);
      if (this.global.get('phase') !== 'consensus') {
        return;
      }
      const ready = [0, 1].every(index => this.players.find(p => p.get('index') === index && p.get('ready')));
      if (!ready) {
        return;
      }
      const result = this.consensus.peak(i, updates.peak, now);
      if (!result) {
        return;
      }
      if (result.starting) {
        this.global.set({ jointActive: true, jointStart: result.start }).catch(console.error);
        this.write('joint', { on: true, scheduledAt: now }, result.start);
      }
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        if (this.consensus.expire(this.now() + 0.002)) {
          this.global.set({ jointActive: false }).catch(console.error);
          this.write('joint', { on: false });
        }
      }, Math.max(0, (result.until - this.now()) * 1000));
    }
  }

  async command(action, payload = {}) {
    switch (action) {
      case 'phase': {
        if (!phases.includes(payload.phase)) {
          throw new Error('未知阶段。');
        }
        if (this.global.get('phase') === payload.phase) {
          return;
        }
        await this.resetJoint();
        const now = this.now();
        const cue = now + params.eventLeadTime;
        await this.global.set({ phase: payload.phase, phaseStarted: now, cue, error: '' });
        if (this.writer) {
          this.actualOrder.push(payload.phase);
        }
        this.write('phase', { value: payload.phase });
        this.write('cue', { scheduledAt: now }, cue);
        break;
      }
      case 'record-start': {
        if (this.writer) {
          throw new Error('已经在记录，请先停止当前记录。');
        }
        const groupId = String(payload.groupId ?? '').trim();
        if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(groupId)) {
          throw new Error('组别编号请使用 1–40 个字母、数字、汉字、下划线或连字符。');
        }
        const order = payload.order ?? params.phaseOrder;
        if (!Array.isArray(order) || order.length !== 4 || order[0] !== 'familiarization'
          || new Set(order.slice(1)).size !== 3 || !order.slice(1).every(phase => rules.includes(phase))) {
          throw new Error('顺序须以熟悉阶段开始，且包含分工、调制、共识各一次。');
        }
        this.writer = await this.logger.createWriter(`${groupId}.jsonl`);
        this.order = [...order];
        this.actualOrder = [this.global.get('phase')];
        this.lastLogged.clear();
        this.write('session', { groupId, params, order, phase: this.global.get('phase'), divisionSwap: this.global.get('divisionSwap'), jointActive: this.global.get('jointActive'), wallTime: new Date().toISOString() });
        this.players.forEach(player => this.write('device', player.getValues()));
        await this.global.set({ groupId, recording: true, logFile: path.basename(this.writer.pathname), error: '' });
        break;
      }
      case 'record-stop': {
        if (!this.writer) {
          throw new Error('当前没有正在进行的记录。');
        }
        // Let a just-scheduled ending beep occur before closing the recording.
        const delay = this.pendingBeepUntil - this.now();
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
        this.write('session-end', { groupId: this.global.get('groupId'), order: this.order, actualOrder: this.actualOrder });
        await this.writer.close();
        this.writer = null;
        await this.global.set({ recording: false });
        break;
      }
      case 'sync-beep': {
        const now = this.now();
        const time = now + params.eventLeadTime;
        this.pendingBeepUntil = time + params.audio.cueDuration;
        await this.global.set({ syncBeep: time });
        this.write('syncBeep', { scheduledAt: now }, time);
        break;
      }
      case 'division-swap': {
        if (typeof payload.value !== 'boolean') {
          throw new Error('角色交换值无效。');
        }
        await this.global.set({ divisionSwap: payload.value });
        this.write('divisionSwap', { value: payload.value });
        break;
      }
      default: throw new Error('未知控制命令。');
    }
  }

  async close() {
    clearTimeout(this.holdTimer);
    if (this.writer) {
      this.write('session-end', { reason: 'server-stop', actualOrder: this.actualOrder });
      await this.writer.close();
      this.writer = null;
    }
  }
}
