/**
 * Shared bounded cache utility with LRU-style eviction.
 */

export type BoundedCacheSetResult<K, V> = {
  evicted?: {
    key: K;
    value: V;
  };
};

export interface BoundedCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): BoundedCacheSetResult<K, V>;
  delete(key: K): boolean;
  clear(): void;
  size(): number;
}

export function createBoundedCache<K, V>(maxEntries: number): BoundedCache<K, V> {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error(`Bounded cache requires a positive integer maxEntries, got ${JSON.stringify(maxEntries)}.`);
  }

  const entries = new Map<K, V>();

  return {
    get(key: K): V | undefined {
      if (!entries.has(key)) {
        return undefined;
      }

      const value = entries.get(key);
      if (value === undefined) {
        entries.delete(key);
        return undefined;
      }

      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    set(key: K, value: V): BoundedCacheSetResult<K, V> {
      if (entries.has(key)) {
        entries.delete(key);
      }

      entries.set(key, value);

      if (entries.size <= maxEntries) {
        return {};
      }

      const oldest = entries.entries().next();
      if (oldest.done) {
        return {};
      }

      const [oldestKey, oldestValue] = oldest.value;
      entries.delete(oldestKey);
      return {
        evicted: {
          key: oldestKey,
          value: oldestValue,
        },
      };
    },

    delete(key: K): boolean {
      return entries.delete(key);
    },

    clear(): void {
      entries.clear();
    },

    size(): number {
      return entries.size;
    },
  };
}
