/**
 * LLM が生成した type + name から決定的なエンティティ ID を生成します。
 * 同じ概念が異なる表記で重複登録されることを防ぎます。
 *
 * @example
 * generateEntityId('library', 'Drizzle ORM') // => 'library/drizzle-orm'
 * generateEntityId('task', '差分の安全性を確認する') // => 'task/差分の安全性を確認する'
 * generateEntityId('tool', 'biome') // => 'tool/biome'
 */
export function generateEntityId(type: string, name: string): string {
  // name を正規化: 小文字化、連続スペースを単一ハイフンに、先頭末尾トリム
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '-');
  // type + "/" + normalized でスラッグ化
  return `${type}/${normalized}`;
}
