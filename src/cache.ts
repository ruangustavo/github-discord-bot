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

export function isCacheValid<T>(entry: CacheEntry<T>): boolean {
	return Date.now() - entry.fetchedAt < CACHE_TTL;
}
