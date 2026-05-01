import { afterEach, describe, expect, it, mock } from 'bun:test';
import { runFetch } from '../../src/services/agenticSearch/tools/fetch.js';

const originalFetch = globalThis.fetch;

describe('runFetch', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GNOSIS_AGENTIC_FETCH_MAX_CHARS = undefined;
  });

  it('extracts body text from html and removes script/style', async () => {
    globalThis.fetch = mock(async () => {
      const html =
        '<html><body><h1>A</h1><script>alert(1)</script><style>.x{}</style><p>B</p></body></html>';
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as never;
    const result = await runFetch({ url: 'https://example.com' });
    expect(String(result.text)).toContain('AB');
    expect(String(result.text)).not.toContain('alert');
  });

  it('truncates text by env max chars', async () => {
    process.env.GNOSIS_AGENTIC_FETCH_MAX_CHARS = '5';
    globalThis.fetch = mock(async () => {
      return new Response('123456789', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as never;
    const result = await runFetch({ url: 'https://example.com' });
    expect(result.text).toBe('12345');
    expect(result.truncated).toBe(true);
  });
});
