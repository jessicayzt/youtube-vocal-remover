// The separation scheduler against a fake worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeparatorClient } from '../src/offscreen/separator-client.js';

function setup() {
  const workers = [];
  const createWorker = () => { const w = { posted: [], postMessage(m) { this.posted.push(m); }, terminate() { this.dead = true; } }; workers.push(w); return w; };
  const engine = { active: null, registry: {} };
  const client = new SeparatorClient(engine, { createWorker, watchdog: false });
  const session = { needsProcessing: true, processedChunks: 0, events: [], jobParams: () => ({}), onWorkerEvent(m) { this.events.push(m.type); }, broadcastState() {} };
  engine.active = session;
  const starts = () => workers.flatMap((w) => w.posted.filter((m) => m.type === 'start'));
  const last = () => workers[workers.length - 1];
  return { client, session, workers, starts, last };
}

// A job that finishes with blocks still missing (marked for redoing after it read the bitmap) has
// to go back in the queue: nothing else would ever schedule those blocks.
test('a job that finishes with blocks still missing is scheduled again, a few times at most', () => {
  const { client, session, starts } = setup();
  client.request(session);
  assert.equal(starts().length, 1);
  for (let i = 0; i < 3; i++) client.onMessage({ type: 'done', jobId: client.current.jobId });
  assert.equal(starts().length, 4, 'incomplete: run again');
  client.onMessage({ type: 'done', jobId: client.current.jobId });
  assert.equal(starts().length, 4, 'finishing early again and again without progress: no spinning');
  assert.equal(client.current, null);
});

test('progress lets an unfinished job be scheduled again later', () => {
  const { client, session, starts } = setup();
  client.request(session);
  for (let i = 0; i < 3; i++) client.onMessage({ type: 'done', jobId: client.current.jobId });
  client.onMessage({ type: 'progress', jobId: client.current.jobId, processedChunks: 5 });
  client.onMessage({ type: 'done', jobId: client.current.jobId });
  assert.equal(starts().length, 5);
});

test('a failed job is retried, then on WebAssembly, and only then reported', () => {
  const { client, session, workers, starts } = setup();
  client.request(session);
  client.onMessage({ type: 'error', jobId: client.current.jobId, message: 'the model returned no audio (webgpu)' });
  assert.equal(workers.length, 2, 'a fresh worker');
  assert.ok(workers[0].dead);
  assert.equal(client.forceWasm, false);
  client.onMessage({ type: 'error', jobId: client.current.jobId, message: 'again' });
  assert.equal(client.forceWasm, true, 'twice: WebAssembly from here on');
  assert.equal(workers[2].posted[0].forceWasm, true, 'and the new worker is told so');
  assert.equal(starts().length, 3);
  client.onMessage({ type: 'error', jobId: client.current.jobId, message: 'out of memory' });
  assert.ok(session.events.includes('error'), 'the third failure is shown');
  assert.equal(starts().length, 3, 'and not retried');
});

test('an error long ago does not count towards giving up once processing works again', () => {
  const { client, session } = setup();
  client.request(session);
  client.onMessage({ type: 'error', jobId: client.current.jobId, message: 'blip' });
  assert.equal(session.jobErrors, 1);
  client.onMessage({ type: 'progress', jobId: client.current.jobId, processedChunks: 3 });
  assert.equal(session.jobErrors, 0);
});
