import { createHash } from 'node:crypto';

/**
 * 文字列の SHA-256 ハッシュを 16 進数形式で生成します。
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
