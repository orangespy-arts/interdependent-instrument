/** All times are seconds on the server's sync clock. Each peak is paired once. */
export class Consensus {
  constructor({ alignWindow, jointHold, eventLeadTime, maxPeakAge = 1 }) {
    Object.assign(this, { alignWindow, jointHold, eventLeadTime, maxPeakAge });
    this.reset();
  }

  reset() {
    this.peaks = [null, null];
    this.latest = [-Infinity, -Infinity];
    this.active = false;
    this.until = 0;
  }

  peak(index, time, now) {
    if (![0, 1].includes(index) || !Number.isFinite(time) || !Number.isFinite(now)
      || time > now + 0.05 || now - time > this.maxPeakAge || time <= this.latest[index]) {
      return null;
    }
    this.latest[index] = time;
    this.peaks = this.peaks.map(peak => peak !== null && now - peak > this.maxPeakAge ? null : peak);
    this.peaks[index] = time;
    if (this.peaks.some(value => value === null)
      || Math.abs(this.peaks[0] - this.peaks[1]) > this.alignWindow + 1e-9) {
      return null;
    }
    this.peaks = [null, null];
    const starting = !this.active;
    this.active = true;
    // Schedule from reception time, not an old event timestamp: both phones need notice.
    const start = now + this.eventLeadTime;
    this.until = Math.max(this.until, start + this.jointHold);
    return { starting, start, until: this.until };
  }

  expire(now) {
    if (this.active && now >= this.until) {
      this.active = false;
      return true;
    }
    return false;
  }
}
