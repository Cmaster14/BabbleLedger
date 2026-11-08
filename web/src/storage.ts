/**
 * Tiny IndexedDB key-value wrapper for the notebook and ledger. Local-first:
 * nothing here ever leaves the browser. Every call fails soft (private windows,
 * blocked storage) so the app still works, it just won't remember.
 */
const DB_NAME = "blabberledger";
const STORE = "kv";
const STATE_KEY = "state-v1";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadSavedState(): Promise<unknown> {
  try {
    return await withStore("readonly", (s) => s.get(STATE_KEY));
  } catch {
    return undefined;
  }
}

export async function saveState(value: unknown): Promise<boolean> {
  try {
    await withStore("readwrite", (s) => s.put(value, STATE_KEY));
    return true;
  } catch {
    return false;
  }
}
