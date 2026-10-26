// Run control: start/stop/pause/resume with sleeps that freeze while paused
// and abort immediately on stop.

export class StopSignal extends Error {
  constructor() {
    super('stopped');
    this.name = 'StopSignal';
  }
}

export class RunControl {
  constructor(onChange) {
    this.status = 'idle'; // idle | running | paused | break | waiting_ai
    this.stopped = true;
    this.paused = false;
    this.abort = new AbortController();
    this.onChange = onChange || (() => {});
  }

  get active() {
    return !this.stopped;
  }

  start() {
    this.stopped = false;
    this.paused = false;
    this.abort = new AbortController();
    this.set('running');
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    this.abort.abort();
    this.set('idle');
  }

  pause() {
    if (this.stopped) return;
    this.paused = true;
    this.set('paused');
  }

  resume() {
    if (this.stopped) return;
    this.paused = false;
    this.set('running');
  }

  set(status) {
    if (this.paused && status !== 'paused' && status !== 'idle') return; // stay visibly paused
    this.status = status;
    this.onChange(status);
  }

  get signal() {
    return this.abort.signal;
  }

  async checkpoint() {
    if (this.stopped) throw new StopSignal();
    while (this.paused) {
      await new Promise((r) => setTimeout(r, 250));
      if (this.stopped) throw new StopSignal();
    }
  }

  // Ends the current wakeable sleep early (e.g. a new message was detected).
  wake() {
    this._wake = true;
  }

  // Sleeps `ms` of *active* time: pausing freezes the countdown.
  async sleep(ms, { wakeable = false } = {}) {
    let remaining = Math.max(0, ms);
    if (wakeable) this._wake = false;
    while (remaining > 0) {
      await this.checkpoint();
      if (wakeable && this._wake) {
        this._wake = false;
        break;
      }
      const step = Math.min(remaining, 250);
      await new Promise((r) => setTimeout(r, step));
      remaining -= step;
    }
    await this.checkpoint();
  }
}
