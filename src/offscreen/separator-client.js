// Schedules separation jobs on the worker, one at a time, the playing session first; watches
// for wedged or failed jobs and replaces the worker. Its own module so the Node tests can drive
// it with a fake worker.
const defaultCreateWorker = () => new Worker(chrome.runtime.getURL('src/offscreen/separator-worker.js'), { type: 'module' });

// A separation job that reports nothing for this long is wedged (a hung GPU submission, a
// crashed worker whose error never surfaced): the worker is replaced and the job restarted.
// The first chunk of a job also compiles the model's GPU pipelines, which can take minutes on a
// slow machine, so a job that has not produced a chunk yet is given much longer.
const JOB_STALL_MS = { loading: 180000, firstChunk: 300000, running: 120000 };

export class SeparatorClient {
  constructor(engine, { createWorker = defaultCreateWorker, watchdog = true } = {}) {
    this.createWorker = createWorker;
    this.engine = engine;
    this.current = null; this.queue = []; this.counter = 0; this.starting = false;
    this.lastEventAt = 0;
    this.waiters = new Map(); // session -> resolvers waiting for its running job to end
    this.forceWasm = false;   // set once WebGPU has failed or stalled twice: the model then runs on WebAssembly
    this.loadingStalls = 0;
    this.spawn();
    if (watchdog) { const t = setInterval(() => this.watchdog(), 5000); if (t && typeof t.unref === 'function') t.unref(); }
  }

  spawn() {
    const worker = this.createWorker();
    worker.onmessage = (e) => { if (this.worker === worker) this.onMessage(e.data); };
    worker.onerror = (e) => { if (this.worker === worker) this.restartWorker('worker error: ' + (e && e.message || e)); };
    worker.postMessage({ type: 'init', registry: this.engine.registry, forceWasm: this.forceWasm });
    this.worker = worker;
  }

  /** Replace the worker and put the interrupted job back at the front of the queue. */
  restartWorker(reason) {
    console.warn('[VocalRemover] restarting the separation worker:', reason);
    try { this.worker.terminate(); } catch (e) { /* ignore */ }
    const interrupted = this.current;
    this.current = null;
    this.spawn();
    if (interrupted) {
      interrupted.onWorkerEvent({ type: 'cancelled', jobId: interrupted.jobId });
      this._settle(interrupted);
      if (interrupted.needsProcessing && !this.queue.includes(interrupted)) this.queue.unshift(interrupted);
    }
    this.schedule();
  }

  watchdog() {
    const s = this.current;
    if (!s) return;
    let limit;
    if (s.jobState === 'loading') limit = JOB_STALL_MS.loading;
    else if (s.jobState === 'running') limit = this.advanced ? JOB_STALL_MS.running : JOB_STALL_MS.firstChunk;
    else return; // waiting for audio, or between states
    const idle = Date.now() - this.lastEventAt;
    if (idle > limit) {
      // a model that cannot even load twice in a row is not going to on this backend
      if (s.jobState === 'loading' && ++this.loadingStalls >= 2 && !this.forceWasm) { this.forceWasm = true; console.warn('[VocalRemover] the model would not load on WebGPU; switching to WebAssembly'); }
      this.restartWorker(`no progress for ${Math.round(idle / 1000)} s while ${s.jobState}`);
    }
  }

  request(session) {
    if (this.current === session || this.queue.includes(session)) return;
    if (this.engine.active === session) {
      // what is playing goes first, even if another video's job is under way (its 'cancelled' re-queues it)
      this.queue.unshift(session);
      if (this.current) { this.worker.postMessage({ type: 'cancel', jobId: this.current.jobId }); return; }
    } else this.queue.push(session);
    this.schedule();
  }

  setActive(session) {
    if (!session || !session.needsProcessing) { this.schedule(); return; }
    if (this.current === session) return;
    const i = this.queue.indexOf(session);
    if (i >= 0) this.queue.splice(i, 1);
    this.queue.unshift(session);
    if (this.current) this.worker.postMessage({ type: 'cancel', jobId: this.current.jobId }); // its 'cancelled' event re-queues it
    else this.schedule();
  }

  cancel(session) {
    const i = this.queue.indexOf(session);
    if (i >= 0) this.queue.splice(i, 1);
    if (this.current === session) this.worker.postMessage({ type: 'cancel', jobId: session.jobId });
  }

  /** Like cancel(), resolving once the session's job has actually ended, its chunk in flight included. */
  cancelAndWait(session) {
    this.cancel(session);
    if (this.current !== session) return Promise.resolve();
    return new Promise((resolve) => {
      if (!this.waiters.has(session)) this.waiters.set(session, []);
      this.waiters.get(session).push(resolve);
    });
  }

  /** The session has unmarked blocks it wants redone: end its running job; the next one re-reads the bitmap. */
  reprocess(session) {
    this.cancelAndWait(session).then(() => { if (session.needsProcessing) this.request(session); });
  }

  /** Empty output more than once is a backend failing without a word: WebAssembly from here on. */
  suspectBackend(reason) {
    if (this.forceWasm) return;
    this.forceWasm = true;
    console.warn('[VocalRemover] the separation backend produced empty output repeatedly; switching to WebAssembly:', reason);
    this.restartWorker('backend suspected: ' + reason);
  }

  _settle(session) {
    const w = this.waiters.get(session);
    if (!w) return;
    this.waiters.delete(session);
    for (const resolve of w) resolve();
  }

  priority(session, block, playing) { if (this.current === session) this.worker.postMessage({ type: 'priority', jobId: session.jobId, block, playing: !!playing }); }
  mixProgress(session) { if (this.current === session) this.worker.postMessage({ type: 'mix-progress', jobId: session.jobId }); }

  schedule() {
    if (this.current) return;
    let next = null;
    while (this.queue.length && !next) { const s = this.queue.shift(); if (s.needsProcessing) next = s; }
    if (!next) return;
    this.current = next;
    next.jobId = ++this.counter;
    next.jobState = 'loading';
    this.lastEventAt = Date.now();
    this.startChunks = null; this.advanced = false;
    this.worker.postMessage({ type: 'start', jobId: next.jobId, ...next.jobParams() });
  }

  onMessage(m) {
    if (m.type === 'log') { console.info('[VocalRemover worker]', m.message); return; }
    const session = this.current && this.current.jobId === m.jobId ? this.current : null;
    if (!session) return;
    this.lastEventAt = Date.now();
    if (m.type === 'progress' && session.jobErrors && m.processedChunks >= (session.errorChunks || 0) + 3) {
      // working again: an error long ago must not count towards giving up for good
      session.jobErrors = 0;
    }
    if (m.type === 'progress' && m.processedChunks > (session.progressMark || 0)) { session.progressMark = m.processedChunks; session.incompleteDones = 0; }
    if (m.type === 'progress') {
      if (this.startChunks == null) this.startChunks = m.processedChunks;
      else if (m.processedChunks > this.startChunks) { this.advanced = true; this.loadingStalls = 0; }
    }
    if (m.type === 'error') {
      // A failed job (a lost GPU device, an out-of-memory) used to be final until the person
      // pressed Retry. It is retried once on a fresh worker, then once more on WebAssembly, and
      // only then shown as an error.
      session.jobErrors = (session.jobErrors || 0) + 1;
      session.errorChunks = session.processedChunks || 0;
      if (session.jobErrors <= 2) {
        if (session.jobErrors === 2) this.forceWasm = true;
        console.warn('[VocalRemover] separation failed:', m.message, this.forceWasm ? '- retrying on WebAssembly' : '- retrying');
        session.jobState = 'idle';
        this.current = null;
        this._settle(session);
        if (session.needsProcessing && !this.queue.includes(session)) this.queue.unshift(session);
        session.broadcastState(true);
        this.restartWorker('job error: ' + m.message);
        return;
      }
    }
    if (m.type === 'done') session.jobErrors = 0;
    session.onWorkerEvent(m);
    if (m.type === 'done' || m.type === 'cancelled' || m.type === 'error') {
      this.current = null;
      this._settle(session);
      // A job can finish with blocks still missing: the session marked them for redoing after the
      // job had read the bitmap (an empty instrumental found, a cache entry repaired). Nothing else
      // would ever schedule them, so they go back in the queue -- a few times at most without
      // progress, so a job that keeps finishing early cannot spin.
      const again = m.type === 'cancelled' || (m.type === 'done' && (session.incompleteDones = (session.incompleteDones || 0) + 1) <= 3);
      if (again && session.needsProcessing && !this.queue.includes(session)) {
        if (this.engine.active === session) this.queue.unshift(session); else this.queue.push(session);
      }
      this.schedule();
    }
  }
}
