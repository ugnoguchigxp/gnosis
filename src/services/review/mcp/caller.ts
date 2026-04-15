export interface ReviewMcpToolCaller {
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

export async function callReviewMcpTool<T = unknown>(
  caller: ReviewMcpToolCaller | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  if (!caller) return null;

  try {
    return await caller.callTool<T>(name, args);
  } catch {
    return null;
  }
}
