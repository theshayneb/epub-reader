import type { BookStorage, DeviceStorage } from "./store";
import type { BookState } from "./types";

const DATABASE_KEY = "omni-book-reader-mod-database";
const STORE_NAME = "books";
const RECORD_KEY = "all";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Book state kept in this device's IndexedDB, outside the vault, so Obsidian Sync never copies it.
 * The database is named per vault (a random name remembered in the vault's local storage).
 */
export class IndexedDbBookStorage implements BookStorage {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly device: DeviceStorage) {}

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      let name = this.device.load(DATABASE_KEY);
      if (typeof name !== "string" || !name) {
        name = `omni-book-reader-mod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        this.device.save(DATABASE_KEY, name);
      }
      const opening = window.indexedDB.open(name as string, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE_NAME)) opening.result.createObjectStore(STORE_NAME);
      };
      this.database = request(opening).catch((error: unknown) => {
        this.database = null;
        throw error;
      });
    }
    return this.database;
  }

  async load(): Promise<unknown> {
    const database = await this.open();
    const value: unknown = await request<unknown>(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(RECORD_KEY));
    return value ?? null;
  }

  async save(books: Record<string, BookState>): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(books, RECORD_KEY);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
    });
  }
}
