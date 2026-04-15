interface CacheEntry<T> {
	data: T;
	fetchedAt: number;
}

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export const cache: {
	collaborators?: CacheEntry<string[]>;
	labels?: CacheEntry<string[]>;
	milestones?: CacheEntry<string[]>;
} = {};

type CacheKey = keyof typeof cache;

export function isCacheValid<T>(entry: CacheEntry<T>): boolean {
	return Date.now() - entry.fetchedAt < CACHE_TTL;
}

export async function getCached(
	key: CacheKey,
	fetch: () => Promise<string[]>,
): Promise<string[]> {
	const entry = cache[key];
	if (entry && isCacheValid(entry)) return entry.data;
	const data = await fetch();
	cache[key] = { data, fetchedAt: Date.now() };
	return data;
}
