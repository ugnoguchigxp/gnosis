import { load } from 'cheerio';

const DEFAULT_MAX_CHARS = 12_000;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export type FetchArgs = { url: string };

export async function runFetch(args: FetchArgs): Promise<Record<string, unknown>> {
  let target: URL;
  try {
    target = new URL(args.url);
  } catch {
    return {
      url: args.url,
      status: 0,
      contentType: null,
      text: '',
      truncated: false,
      degraded: { code: 'INVALID_URL', message: 'Invalid URL' },
    };
  }

  try {
    const response = await fetch(target.toString(), { signal: AbortSignal.timeout(12_000) });
    const contentType = response.headers.get('content-type');
    const maxChars = Number(process.env.GNOSIS_AGENTIC_FETCH_MAX_CHARS ?? DEFAULT_MAX_CHARS);
    if (!response.ok) {
      return {
        url: target.toString(),
        status: response.status,
        contentType,
        text: '',
        truncated: false,
        degraded: { code: 'HTTP_ERROR', message: `HTTP ${response.status}` },
      };
    }

    const body = await response.text();
    let text = body;
    if (contentType?.includes('text/html')) {
      const $ = load(body);
      $('script,style,template,noscript').remove();
      text = normalizeWhitespace($('body').text());
    } else if (contentType?.includes('text/')) {
      text = normalizeWhitespace(body);
    } else {
      return {
        url: target.toString(),
        status: response.status,
        contentType,
        text: '',
        truncated: false,
        degraded: {
          code: 'UNSUPPORTED_CONTENT_TYPE',
          message: `Unsupported content-type: ${contentType}`,
        },
      };
    }

    const truncated = text.length > maxChars;
    return {
      url: target.toString(),
      status: response.status,
      contentType,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
    };
  } catch (error) {
    return {
      url: target.toString(),
      status: 0,
      contentType: null,
      text: '',
      truncated: false,
      degraded: {
        code: 'FETCH_TIMEOUT_OR_NETWORK',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
