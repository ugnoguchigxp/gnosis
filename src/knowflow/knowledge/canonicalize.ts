export const normalizeTopic = (topic: string): string => {
  return topic
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M}+#.\-\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
};

export const canonicalizeTopic = (topic: string): string => {
  const normalized = normalizeTopic(topic);
  return normalized.length > 0 ? normalized : 'unknown';
};

export const uniqueNormalizedStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeTopic(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};
