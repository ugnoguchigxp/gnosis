# Guidance 機能改善の実装計画

## 1. 背景と目的
現在の Guidance 機能（SkillやRuleの登録・適用）はすでに高度なグラフベースRAGとして機能していますが、LLMの挙動をさらに正確に制御し、誤適用を減らすために以下の2点の改善を行います。

1. **Applicability（適用条件）の表現力強化**: 否定条件（excludes）や依存関係（depends_on）を追加し、適用されるべきではないケースや、前提知識の連鎖を表現できるようにします。
2. **検証基準（validationCriteria）の追加**: 単なるテキストの手順を「実行可能なチェックリスト」へと昇華させ、LLM自身が作業後に自己レビュー（Self-Review）を行えるようにします。

---

## 2. 実装計画

### Phase 1: スキーマ（Domain / Zod）の拡張
ファイル: `src/domain/schemas.ts`, `src/services/guidance/types.ts`

1. **`GuidanceApplicabilitySchema` の拡張**
   - 既存の構造に `excludes` オブジェクトを追加し、ポジティブ条件（包含）とネガティブ条件（除外）を明確に分離します。
   - 例: `excludes: z.object({ paths: z.array(z.string()).optional(), signals: z.array(z.string()).optional(), ... })`
2. **依存関係（Dependencies）の追加**
   - 他のガイダンス（親ルールや前提スキル）の ID またはタイトルを指定する `dependsOn: z.array(z.string()).optional()` を追加します。
3. **検証基準の追加**
   - `GuidanceChunkSchema` および `GuidanceManifestSchema` に `validationCriteria: z.array(z.string()).optional()` を追加します。

### Phase 2: MCPツール入力の更新
ファイル: `src/mcp/tools/guidance.ts`

1. **`registerGuidanceSchema` のアップデート**
   - `validationCriteria` の受け入れ（Array of Strings）。
   - `applicability.excludes` と `dependsOn` の受け入れ。

### Phase 3: 保存・グラフ構築ロジックの拡張
ファイル: `src/services/guidance/register.ts`

1. **`saveGuidance` 内の Entity Metadata への保存**
   - `validationCriteria`, `dependsOn`, `excludes` などの新しいフィールドを、`vibeMemories` のメタデータおよび `entities` のメタデータにシリアライズして保存します。
2. **否定条件（Excludes）の Relation 構築**
   - `applicability.excludes` に定義された条件（例: `paths: ["tests/"]`）について、`context` エンティティを生成（または取得）します。
   - その `context` エンティティと登録する Guidance エンティティの間に **`when_not`** または **`bypassed_by`** といった新しい RelationType のエッジを作成します。
3. **依存関係（Depends On）の Relation 構築**
   - `dependsOn` で指定された対象が存在する場合、対象エンティティに向けて **`depends_on`** もしくは **`extends`** の関係（Relation）を作成します。

### Phase 4: 検索・取得ロジック（Graph RAG）への反映
ファイル: `src/mcp/tools/queryProcedure.ts`, `src/services/guidance/search.ts` 等

1. **コンテキスト解決時の `when_not` の評価**
   - グラフをトラバースしてガイダンスを取得する際、現在のコンテキストが `when_not` の条件に合致している場合は、そのガイダンスを結果から除外するロジックを強化します。
2. **依存関係の同時ロード**
   - `depends_on` のエッジを辿り、前提となる Guidance（親ルール）も自動的にシステムプロンプトのコンテキストに含まれるように調整します。
3. **LLMプロンプトへの ValidationCriteria の注入**
   - 取得した Guidance を LLM に提示する際、「この手順を満たしているか、以下の Criteria を使って確認してください」という形で `validationCriteria` を明示的に表示します。

---

## 3. 期待される効果
* **誤適用の激減**: `excludes` により、「テストファイルにはこのプロダクション用ルールを適用しない」といった制御が容易になります。
* **自己修復能力の向上**: `validationCriteria` を持つことで、LLMはコード生成直後に「Criteriaを満たしているか？」と自問自答でき、後戻り工数が減少します。
* **ナレッジの体系化**: `depends_on` により、「共通ルール」と「個別ルール」をモジュール化して管理できるようになります。
