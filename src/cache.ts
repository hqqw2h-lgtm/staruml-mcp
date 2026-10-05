/**
 * A least-recently-used map with hit and miss counts. Map iteration follows insertion order, so
 * re-inserting on every hit keeps the least recently used entry first.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();
  hits = 0;
  misses = 0;

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const [oldest] = this.entries.keys();
      this.entries.delete(oldest!);
    }
  }

  /** Removes `key` only while it still maps to `value`, so a newer entry survives. */
  deleteIf(key: string, value: V): void {
    if (this.entries.get(key) === value) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * The promise cached for `key`, or `load()`'s, cached while it is pending so concurrent callers
 * share one upstream call. A rejection is passed on and not kept.
 */
export function memo<T>(
  cache: LruCache<Promise<unknown>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached as Promise<T>;
  const pending = load();
  cache.set(key, pending);
  pending.catch(() => cache.deleteIf(key, pending));
  return pending;
}
