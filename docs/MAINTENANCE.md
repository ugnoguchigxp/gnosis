# Gnosis 記憶メンテナンスガイド

Gnosis では、記憶（Vibe Memory）およびエンティティ（Knowledge Graph）の利用実績を自動的にトラッキングしています。データが肥大化した際や、不要な記憶を整理したい際の指針として活用してください。

## トラッキング指標

各レコードには以下のフィールドが自動付与・更新されます：

- `reference_count`: その情報が検索結果に含まれた回数。
- `last_referenced_at`: その情報が最後に検索（参照）された日時。

## 整理の指針

データ整理の際は、以下の「冷えたデータ（Cold Data）」を優先的に削除することをお勧めします。

### 1. 長期間参照されていないデータ
最新の文脈から外れ、かつ最近使用されていない知識です。
```sql
-- 例: 30日以上一度も参照されていないエンティティを特定
SELECT name, description, reference_count 
FROM entities 
WHERE last_referenced_at < NOW() - INTERVAL '30 days' 
  AND reference_count = 0;
```

### 2. 重要度の低い（参照回数が少ない）古いデータ
過去に一度だけ記録されたが、その後役に立っていない情報です。
```sql
-- 例: 180日以上経過し、参照回数が1回以下のメモリを特定
SELECT content, reference_count 
FROM vibe_memories 
WHERE createdAt < NOW() - INTERVAL '180 days' 
  AND reference_count <= 1;
```

## 物理削除の実行（TODO）

現在は自動削除機能を搭載していません（誤削除防止のため）。
必要に応じて、上記のクエリを参考に `DELETE` 文を実行するか、`delete_memory` ツールを使用して個別に整理を行ってください。将来的に、これらの指標に基づいた自動アーカイブ・削除ツールの導入を検討してください。

---

*注: 削除前にバックアップ（データベースのダンプ）を推奨します。*
