// IndexedDB cache for decoded mixtures and processed instrumentals, so revisiting a video
// (or reloading the page) does not repeat capture or separation. Values are Int16 PCM.
//
// Two object stores: `tracks` holds the audio records (hundreds of megabytes each), `meta` holds
// one small { key, bytes, updatedAt } per track. Eviction and stats read `meta` only; reading the
// audio records just to sum their sizes pulled the whole cache into memory after every save.
//
// The PCM arrays are stored as Blobs. Chrome refuses to serialize an IndexedDB value above about
// 127 MB, which the mixture of any video longer than some twelve minutes exceeds, so those saves
// failed -- quietly, after copying the whole track -- every time. Blobs are stored by reference.
const DB_NAME = 'vrx-cache';
const DB_VERSION = 2;
const STORE = 'tracks';
const META = 'meta';

export class TrackCache {
  constructor({ limitBytes = 2 * 1024 * 1024 * 1024 } = {}) {
    this.limitBytes = limitBytes;
    this.dbPromise = null;
  }

  open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains(META)) {
          const meta = db.createObjectStore(META, { keyPath: 'key' });
          meta.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('cache database is open elsewhere'));
    });
    this.dbPromise.catch(() => { this.dbPromise = null; }); // a failed open is retried next time
    return this.dbPromise;
  }

  /** Runs fn(tx) in one transaction over `stores`; resolves with fn's request result (or return value) once the transaction completes. */
  async _tx(mode, stores, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      try { result = fn(tx); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  async load(key) {
    try {
      const record = await this._tx('readonly', [STORE], (tx) => tx.objectStore(STORE).get(key));
      if (!record) return null;
      for (const [k, v] of Object.entries(record)) if (v instanceof Blob) record[k] = await v.arrayBuffer();
      return record;
    } catch (e) { console.warn('[VocalRemover] cache load failed', e); return null; }
  }

  async touch(key) {
    try {
      await this._tx('readwrite', [META], (tx) => {
        const meta = tx.objectStore(META);
        const r = meta.get(key);
        r.onsuccess = () => { if (r.result) { r.result.updatedAt = Date.now(); meta.put(r.result); } };
      });
    } catch (e) { /* ignore */ }
  }

  /** record: plain object with ArrayBuffer fields; `bytes` must be set by the caller. */
  async save(record) {
    record.updatedAt = Date.now();
    try {
      const stored = {};
      for (const [k, v] of Object.entries(record)) stored[k] = v instanceof ArrayBuffer ? new Blob([v]) : v;
      await this._tx('readwrite', [STORE, META], (tx) => {
        tx.objectStore(STORE).put(stored);
        tx.objectStore(META).put({ key: record.key, bytes: record.bytes || 0, updatedAt: record.updatedAt });
      });
      await this.evict();
      return true;
    } catch (e) { console.warn('[VocalRemover] cache save failed', e); return false; }
  }

  async evict(limitBytes = this.limitBytes) {
    const metas = (await this._tx('readonly', [META], (tx) => tx.objectStore(META).getAll())) || [];
    let total = 0;
    for (const m of metas) total += m.bytes || 0;
    if (total <= limitBytes) return;
    metas.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)); // oldest first
    for (const m of metas) {
      if (total <= limitBytes) break;
      await this._delete(m.key);
      total -= m.bytes || 0;
    }
  }

  _delete(key) {
    return this._tx('readwrite', [STORE, META], (tx) => { tx.objectStore(STORE).delete(key); tx.objectStore(META).delete(key); });
  }

  /** Delete every record whose key does not start with the current version prefix. */
  async purgeOtherVersions(prefix) {
    try {
      const all = await this._tx('readonly', [STORE], (tx) => tx.objectStore(STORE).getAllKeys());
      const stale = (all || []).filter((k) => typeof k === 'string' && !k.startsWith(prefix));
      for (const k of stale) await this._delete(k);
      if (stale.length) console.info('[VocalRemover] dropped', stale.length, 'cached tracks from an older version');
    } catch (e) { /* ignore */ }
  }

  async clear() {
    try { await this._tx('readwrite', [STORE, META], (tx) => { tx.objectStore(STORE).clear(); tx.objectStore(META).clear(); }); return true; } catch (e) { return false; }
  }

  async stats() {
    try {
      const metas = (await this._tx('readonly', [META], (tx) => tx.objectStore(META).getAll())) || [];
      let bytes = 0; for (const m of metas) bytes += m.bytes || 0;
      return { count: metas.length, bytes };
    } catch (e) { return { count: 0, bytes: 0 }; }
  }
}
