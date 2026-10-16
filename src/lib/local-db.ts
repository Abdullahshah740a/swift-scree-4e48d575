import type { VideoRecord } from "./types";

const DB_NAME = "swift-screen";
const DB_VERSION = 1;
const META_STORE = "videos";
const BLOB_STORE = "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable on server"));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return getDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const req = fn(transaction.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putVideoMeta(rec: VideoRecord): Promise<void> {
  await tx(META_STORE, "readwrite", (s) => s.put(rec));
}

export async function getAllVideoMeta(): Promise<VideoRecord[]> {
  try {
    const all = await tx<VideoRecord[]>(
      META_STORE,
      "readonly",
      (s) => s.getAll() as IDBRequest<VideoRecord[]>,
    );
    return all ?? [];
  } catch {
    return [];
  }
}

export async function getVideoMeta(id: string): Promise<VideoRecord | null> {
  try {
    const rec = await tx<VideoRecord | undefined>(
      META_STORE,
      "readonly",
      (s) => s.get(id) as IDBRequest<VideoRecord | undefined>,
    );
    return rec ?? null;
  } catch {
    return null;
  }
}

export async function deleteVideoMeta(id: string): Promise<void> {
  await tx(META_STORE, "readwrite", (s) => s.delete(id));
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  await tx(BLOB_STORE, "readwrite", (s) => s.put(blob, id));
}

export async function getBlob(id: string): Promise<Blob | null> {
  try {
    const blob = await tx<Blob | undefined>(
      BLOB_STORE,
      "readonly",
      (s) => s.get(id) as IDBRequest<Blob | undefined>,
    );
    return blob ?? null;
  } catch {
    return null;
  }
}

export async function deleteBlob(id: string): Promise<void> {
  await tx(BLOB_STORE, "readwrite", (s) => s.delete(id));
}
