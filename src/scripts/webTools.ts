/**
 * Web search and content fetching tools — pure async functions.
 * No MCP dependency. Can be imported directly by any TypeScript code.
 */

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

type SearchResult = { title: string; url: string; snippet: string };

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return '検索結果が見つかりませんでした。';
  return results.map((r) => `- ${r.title} (${r.url})\n  ${r.snippet}`).join('\n');
}

function cleanText(text: string, limit = 5000): string {
  const cleaned = text
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => line.split('  ').map((p) => p.trim()))
    .filter(Boolean)
    .join('\n');
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}...` : cleaned;
}

async function searchBrave(query: string): Promise<{ results: SearchResult[]; error?: string }> {
  const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY ?? '';
  if (!BRAVE_SEARCH_API_KEY) return { results: [], error: 'BRAVE_SEARCH_API_KEY not set' };

  try {
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', '10');
    url.searchParams.set('safesearch', 'off');

    const res = await fetch(url.toString(), {
      headers: {
        'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { results: [], error: `Brave HTTP ${res.status}` };

    const data = (await res.json()) as Record<string, unknown>;
    const web = data.web as { results?: Array<Record<string, string>> } | undefined;
    const results: SearchResult[] = (web?.results ?? []).slice(0, 10).map((r) => ({
      title: r.title ?? 'No Title',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
    if (results.length > 0) return { results };
    return { results: [], error: 'Brave search returned no results' };
  } catch (e) {
    return { results: [], error: String(e) };
  }
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const res = await fetch(`https://duckduckgo.com/html/?q=${encoded}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();

  const results: SearchResult[] = [];
  // Split by result blocks — each web-result is a separate entity
  const blocks = html.split(/class="result\s[^"]*web-result/);
  for (const block of blocks.slice(1)) {
    const hrefMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/);
    const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch =
      block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) ??
      block.match(/<td[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/td>/);
    if (!hrefMatch?.[1]) continue;
    let url = hrefMatch[1];
    // DDG wraps URLs in redirect — extract the actual URL
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
    results.push({
      title: titleMatch?.[1]?.replace(/<[^>]*>/g, '').trim() ?? 'No Title',
      url,
      snippet: snippetMatch?.[1]?.replace(/<[^>]*>/g, '').trim() ?? '',
    });
    if (results.length >= 10) break;
  }
  return results;
}

export async function searchWeb(query: string): Promise<string> {
  if (!query?.trim()) return 'Error: query parameter is required.';
  const q = query.trim();

  const brave = await searchBrave(q);
  if (brave.results.length > 0) return formatResults(brave.results);

  try {
    const ddg = await searchDuckDuckGo(q);
    if (ddg.length > 0) return formatResults(ddg);
    if (brave.error)
      return `Error: 検索に失敗しました (Brave: ${brave.error}, Fallback: no results)`;
    return '検索結果が見つかりませんでした。';
  } catch (e) {
    if (brave.error) return `Error: 検索に失敗しました (Brave: ${brave.error}, Fallback: ${e})`;
    return `Error: 検索に失敗しました (${e})`;
  }
}

function extractMainText(html: string): string {
  const cleaned = html.replace(
    /<(script|style|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  const mainMatch = cleaned.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  const contentMatch = cleaned.match(/<[^>]+(?:id|class)="content"[^>]*>([\s\S]*?)<\/[^>]+>/i);
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const target = mainMatch?.[2] ?? contentMatch?.[1] ?? bodyMatch?.[1] ?? cleaned;
  return target
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export async function fetchContent(url: string): Promise<string> {
  if (!url?.trim()) throw new Error('url parameter is required.');
  let target = url.trim();
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    target = `https://${target}`;
  }

  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = extractMainText(html);
    if (text.trim()) return cleanText(text);
    throw new Error('本文を取得できませんでした。');
  } catch (e) {
    try {
      const targetUrl = new URL(target);
      const readerUrl = `https://r.jina.ai/http://${targetUrl.host}${targetUrl.pathname}${targetUrl.search}`;
      const fallback = await fetch(readerUrl, { signal: AbortSignal.timeout(10000) });
      if (fallback.ok) {
        const text = await fallback.text();
        if (text.trim()) return cleanText(text);
      }
    } catch (fe) {
      throw new Error(`内容の取得に失敗しました (${e} / Fallback: ${fe})`);
    }
    throw new Error(`内容の取得に失敗しました (${e})`);
  }
}
