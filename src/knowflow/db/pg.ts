/**
 * Minimal database utility shim for tests
 */
export async function closeAllPgPools(): Promise<void> {
  // In Gnosis, we use a global pool. For now, this is a no-op shim to satisfy legacy KnowFlow tests.
  // In a real scenario, we might want to close the global db connection if needed.
}
