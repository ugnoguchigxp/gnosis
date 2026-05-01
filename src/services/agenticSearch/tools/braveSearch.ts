const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export type BraveSearchArgs = {
  query: string;
  count?: number;
};

export async function runBraveSearch(args: BraveSearchArgs): Promise<Record<string, unknown>> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY ?? '';
  if (!apiKey) {
    return { results: [], degraded: { code: 'BRAVE_API_KEY_MISSING', message: 'BRAVE_SEARCH_API_KEY not set' } };
  }

  try {
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set('q', args.query);
    url.searchParams.set('count', String(args.count ?? 5));
    const response = await fetch(url.toString(), {
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        results: [],
        degraded: { code: 'BRAVE_HTTP_ERROR', message: `Brave HTTP ${response.status}` },
      };
    }
    const payload = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
    };
    return {
      results: (payload.web?.results ?? []).slice(0, args.count ?? 5).map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        description: item.description ?? '',
        publishedAt: item.age ?? null,
        source: 'brave',
      })),
    };
  } catch (error) {
    return {
      results: [],
      degraded: {
        code: 'BRAVE_TIMEOUT_OR_NETWORK',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

