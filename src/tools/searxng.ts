export interface SearxngResultItem {
  title: string;
  url: string;
  content: string;
  engine?: string;
  score?: number;
}

export interface SearxngSearchResponse {
  query: string;
  results: SearxngResultItem[];
  count: number;
}

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8080';

/**
 * Realiza una búsqueda web en tiempo real a través de la instancia local de SearXNG.
 */
export async function searchWebSearxng(
  query: string,
  limit: number = 5,
  engines?: string[]
): Promise<SearxngSearchResponse> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return { query: '', results: [], count: 0 };
  }

  const url = new URL('/search', SEARXNG_URL);
  url.searchParams.set('q', cleanQuery);
  url.searchParams.set('format', 'json');
  if (engines && engines.length > 0) {
    url.searchParams.set('engines', engines.join(','));
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Syllabot-Agent/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG devolvió HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    query?: string;
    results?: Array<{ title?: string; url?: string; content?: string; engine?: string; score?: number }>;
  };

  const results: SearxngResultItem[] = (data.results || [])
    .slice(0, limit)
    .map((item) => ({
      title: item.title || 'Sin título',
      url: item.url || '',
      content: item.content || '',
      engine: item.engine,
      score: item.score,
    }));

  return {
    query: cleanQuery,
    results,
    count: results.length,
  };
}
