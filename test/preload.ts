const networkDisabledError =
  'Unexpected network access in tests. Mock `fetch` in the test or inject dependencies.';

globalThis.fetch = (async () => {
  throw new Error(networkDisabledError);
}) as unknown as typeof fetch;
