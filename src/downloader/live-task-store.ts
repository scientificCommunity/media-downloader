export type LiveTaskStatus = 'recording' | 'stopped' | 'completed' | 'failed';
export type LiveTaskPhase = 'capture' | 'remux';

export interface StoredFileHandle {
  name?: string;
  getFile?(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<{
    write(data: BufferSource | Blob | string): Promise<void>;
    seek(position: number): Promise<void>;
    close(): Promise<void>;
  }>;
  queryPermission?(descriptor?: { mode: 'readwrite' }): Promise<'granted' | 'prompt' | 'denied'>;
  requestPermission?(descriptor?: { mode: 'readwrite' }): Promise<'granted' | 'prompt' | 'denied'>;
}

export interface StoredDirectoryHandle {
  name?: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<StoredFileHandle>;
  removeEntry?(name: string): Promise<void>;
  queryPermission?(descriptor?: { mode: 'readwrite' }): Promise<'granted' | 'prompt' | 'denied'>;
  requestPermission?(descriptor?: { mode: 'readwrite' }): Promise<'granted' | 'prompt' | 'denied'>;
}

export interface LiveTaskRecord {
  id: string;
  sourceUrl: string;
  mediaUrl: string;
  sourcePageUrl?: string;
  suggestedName: string;
  outputExtension: 'ts' | 'mp4';
  variantKey?: string;
  phase?: LiveTaskPhase;
  workingFileName?: string;
  finalFileName?: string;
  directoryHandle?: StoredDirectoryHandle;
  status: LiveTaskStatus;
  startedAt: number;
  updatedAt: number;
  bytesWritten: number;
  segmentsWritten: number;
  retryCount: number;
  lastSequence?: number;
  lastMapKey?: string | null;
  error?: string;
  fileHandle: StoredFileHandle;
}

const DB_NAME = 'video-helper-live-recordings';
const DB_VERSION = 1;
const STORE_NAME = 'tasks';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('sourceUrl', 'sourceUrl', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open live-recording database.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB operation failed.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    });
  } finally {
    database.close();
  }
}

export async function saveLiveTask(task: LiveTaskRecord): Promise<void> {
  await withStore('readwrite', (store) => store.put(task));
}

export async function getLiveTask(id: string): Promise<LiveTaskRecord | null> {
  const result = await withStore<LiveTaskRecord | undefined>('readonly', (store) => store.get(id));
  return result ?? null;
}

export async function getLatestResumableLiveTask(sourceUrl: string): Promise<LiveTaskRecord | null> {
  const tasks = await withStore<LiveTaskRecord[]>('readonly', (store) => store.getAll());
  return tasks
    .filter((task) => task.sourceUrl === sourceUrl && (task.status === 'recording' || task.status === 'failed'))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

export async function deleteLiveTask(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}
