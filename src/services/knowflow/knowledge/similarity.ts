import { createHash } from 'node:crypto';

export const normalizeClaimText = (text: string): string => {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const fingerprintText = (text: string): string => {
  const normalized = normalizeClaimText(text);
  return createHash('sha256').update(normalized).digest('hex');
};

const tokenize = (text: string): Set<string> => {
  const normalized = normalizeClaimText(text);
  if (!normalized) return new Set();
  return new Set(normalized.split(' ').filter(Boolean));
};

export const jaccardSimilarity = (a: string, b: string): number => {
  const left = tokenize(a);
  const right = tokenize(b);

  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
};

export const shouldMergeClaimText = (
  existingText: string,
  incomingText: string,
  threshold = 0.85,
): boolean => {
  const existingFingerprint = fingerprintText(existingText);
  const incomingFingerprint = fingerprintText(incomingText);
  if (existingFingerprint === incomingFingerprint) {
    return true;
  }

  return jaccardSimilarity(existingText, incomingText) >= threshold;
};

const isFiniteVector = (value: unknown): value is number[] => {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
};

export const cosineSimilarity = (
  left: number[] | undefined,
  right: number[] | undefined,
): number | null => {
  if (!isFiniteVector(left) || !isFiniteVector(right)) {
    return null;
  }

  if (left.length !== right.length) {
    return null;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] as number;
    const b = right[i] as number;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

export const shouldMergeClaim = (
  existing: { text: string; embedding?: number[] },
  incoming: { text: string; embedding?: number[] },
  options: {
    textThreshold?: number;
    embeddingThreshold?: number;
  } = {},
): boolean => {
  const textThreshold = options.textThreshold ?? 0.85;
  const embeddingThreshold = options.embeddingThreshold ?? 0.92;

  if (shouldMergeClaimText(existing.text, incoming.text, textThreshold)) {
    return true;
  }

  const score = cosineSimilarity(existing.embedding, incoming.embedding);
  if (score === null) {
    return false;
  }

  return score >= embeddingThreshold;
};
