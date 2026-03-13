type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

const now = () => Date.now();

export const getCache = <T>(key: string): T | null => {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
};

export const setCache = (key: string, value: unknown, ttlMs: number) => {
  store.set(key, { value, expiresAt: now() + ttlMs });
};

export const deleteCache = (key: string) => {
  store.delete(key);
};

export const deleteCacheByPrefix = (prefix: string) => {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
};

export const cacheResponse = (ttlMs: number) => {
  return (req: any, res: any, next: any) => {
    if (req.method !== 'GET') return next();
    const key = req.originalUrl || req.url;
    const hit = getCache(key);
    if (hit) {
      res.set('X-Cache', 'HIT');
      return res.json(hit);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) {
        setCache(key, body, ttlMs);
      }
      res.set('X-Cache', 'MISS');
      return originalJson(body);
    };
    return next();
  };
};
