import { afterEach, describe, expect, it, mock } from 'bun:test';
import { fetchContent } from '../../src/scripts/webTools.js';

const originalFetch = globalThis.fetch;

describe('webTools.fetchContent', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws instead of returning error text when url is empty', async () => {
    await expect(fetchContent('')).rejects.toThrow('url parameter is required');
  });

  it('uses the reader fallback URL after direct fetch fails', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (calls.length === 1) {
        throw new Error('network');
      }
      return new Response('Fallback body', { status: 200 });
    }) as never;

    const text = await fetchContent('https://example.com/docs?q=1');

    expect(text).toContain('Fallback body');
    expect(calls).toEqual([
      'https://example.com/docs?q=1',
      'https://r.jina.ai/http://example.com/docs?q=1',
    ]);
  });
});
