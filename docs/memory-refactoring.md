# Gnosis 記憶リファクタリング設計書

> **ステータス**: 提案中 (Draft)  
> **作成日**: 2026-04-15  
> **対象ブランチ**: `main`

---

## 目次

1. [問題提起と動機](#1-問題提起と動機)
2. [目標とする記憶モデル](#2-目標とする記憶モデル)
3. [現在のリポジトリ概念との対応](#3-現在のリポジトリ概念との対応)
4. [提案データモデル / スキーマ方針](#4-提案データモデル--スキーマ方針)
5. [実装フェーズ計画](#5-実装フェーズ計画)
6. [既存コミュニティ検出の再利用・適応](#6-既存コミュニティ検出の再利用適応)
7. [リスク・トレードオフ・非ゴール](#7-リスクトレードオフ非ゴール)
8. [将来の拡張について](#8-将来の拡張について)

---

## 1. 問題提起と動機

### 現状の課題

現在の Gnosis は「Vibe Memory」「Knowledge Graph」「Experience」「Guidance Registry」「KnowFlow」という複数の機能を提供しているが、それぞれの**記憶としての役割**が明示的に定義されていない。その結果、以下の問題が生じやすい。

- `vibe_memories` に何でも保存されやすく、検索品質が下がる
- `entities` / `relations` / `communities` がエピソードとしての記憶なのか意味的な知識なのかが曖昧
- `register_guidance` で登録されるものが手順なのかルールなのかテンプレートなのかが不明確
- 「忘却」や「圧縮」の概念がなく、長期運用でデータが肥大化しやすい

### 動機となる設計方針

人間の記憶科学に基づき、記憶を**用途と取り出し方で分類**することで、これらの課題を解消できる。特に以下の原則を採用する。

1. **短期記憶 / ワーキングメモリは LLM の Context Window が担当する**  
   Gnosis はこの層を保持しない。これにより Gnosis の役割が「長期記憶の専門基盤」として明確になる。

2. **Gnosis が担当するのは長期記憶のみ**  
   長期記憶は「エピソード記憶」「意味記憶」「手続き記憶」の 3 層に整理する。

3. **手続き記憶は固定的な SKILL ストアにしない**  
   柔軟なパターン分解・グラフ関係・コミュニティ検出によって進化させる。

---

## 2. 目標とする記憶モデル

### 全体像

```text
┌────────────────────────────────────────────────┐
│              LLM (Context Window)              │
│  短期記憶 / ワーキングメモリ（Gnosis管轄外）     │
└────────────────────────────────────────────────┘
                        │ 長期記憶の参照・保存
┌────────────────────────────────────────────────┐
│                  Gnosis                        │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │  エピソード記憶 (Episodic Memory)         │  │
│  │  いつ・何が・どのような文脈で起きたか     │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │  意味記憶 (Semantic Memory)              │  │
│  │  事実・概念・エンティティ間の関係        │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │  手続き記憶 (Procedural Memory)          │  │
│  │  パターン・プレイブック・方針・テンプレ  │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

### 各層の役割

#### 2-1. エピソード記憶 (Episodic Memory)

| 項目 | 内容 |
|------|------|
| **役割** | 時系列・文脈付きの出来事を記録する |
| **問い** | 「いつ、どこで、何が起きたか」 |
| **取り出し方** | 時系列再構成・類似エピソード検索・セッション復元 |
| **忘却** | 古いものは要約して圧縮。参照カウント・最終参照日で優先度付け |
| **例** | 会話ログ、コードレビュー結果、障害対応記録、調査過程、設計判断メモ |

#### 2-2. 意味記憶 (Semantic Memory)

| 項目 | 内容 |
|------|------|
| **役割** | 普遍的な事実・概念・関係を保持する |
| **問い** | 「何を知っているか」 |
| **取り出し方** | グラフ探索・ベクトル類似検索・エンティティルックアップ |
| **忘却** | 重要度・参照頻度に応じて保持。時間的な鮮度（freshness）を管理 |
| **例** | 「A サービスは B ライブラリに依存する」「このプロジェクトでは Bun を使う」 |

#### 2-3. 手続き記憶 (Procedural Memory)

| 項目 | 内容 |
|------|------|
| **役割** | 「どうやるか」を柔軟なパターンとして保持する |
| **問い** | 「この状況でどう振る舞うべきか」 |
| **取り出し方** | 文脈マッチング・パターン注入・プレイブック呼び出し |
| **忘却** | バージョン管理。廃止フラグ・有効期限で管理 |
| **例** | レビュー手順、デプロイチェックリスト、失敗回避ヒューリスティック |

> **重要**: 手続き記憶は実行可能なコード（SKILL）ではなく、**再利用可能な行動パターン**として表現する。  
> サブタイプ: `pattern` / `playbook` / `policy` / `template` / `heuristic`

---

## 3. 現在のリポジトリ概念との対応

| 現在の概念 | 新モデルでの位置づけ | 変更方針 |
|---|---|---|
| `vibe_memories` | エピソード記憶の主テーブル | `memory_type` フィールドを追加し種別を明確化 |
| `experience_logs` | エピソード記憶（失敗/成功サブタイプ） | エピソード記憶に統合、または `subtype: 'experience'` で識別 |
| `entities` | 意味記憶のノード | `confidence` / `provenance` / `freshness` フィールドを追加 |
| `relations` | 意味記憶のエッジ | `confidence` / `timestamp` / `source_task` を追加 |
| `communities` | 意味記憶のクラスター（中間抽象化層） | コミュニティ検出を手続き記憶のパターン発見にも再利用 |
| `Guidance Registry` | 手続き記憶の保存先 | `procedural_type` でサブタイプを分類 |
| `KnowFlow` | 意味記憶の自動充填パイプライン | 変更なし。取得先をエピソード/意味に振り分け |
| `sync` | エピソード記憶の投入経路 | 変更なし。投入後のルーティングを追加 |
| `synthesis` (reflect) | エピソード → 意味記憶への昇格操作 | 昇格ロジックを明示的な変換パイプラインとして整理 |

---

## 4. 提案データモデル / スキーマ方針

### 4-1. エピソード記憶

既存の `vibe_memories` テーブルに以下のフィールドを追加する方向を提案する。

```typescript
// 追加フィールド（vibe_memories への拡張案）
{
  memoryType: text('memory_type').default('episodic'),
  // 'episodic' | 'experience_success' | 'experience_failure'
  episodeAt: timestamp('episode_at'),       // 出来事が起きた時刻（保存時刻と区別）
  sourceTask: text('source_task'),          // 由来タスク (KnowFlow task ID など)
  importance: real('importance').default(0.5), // 重要度スコア (0-1)
  compressed: boolean('compressed').default(false), // 要約圧縮済みフラグ
}
```

### 4-2. 意味記憶

既存の `entities` / `relations` テーブルに以下を追加する。

```typescript
// entities への拡張案
{
  confidence: real('confidence').default(1.0),   // 確信度 (0-1)
  provenance: text('provenance'),                // 出所 (URL, task_id, manual など)
  freshness: timestamp('freshness'),             // 最終検証日時
  importance: real('importance').default(0.5),  // 重要度スコア
}

// relations への拡張案
{
  confidence: real('confidence').default(1.0),
  recordedAt: timestamp('recorded_at').defaultNow(), // この関係が記録された日時
  sourceTask: text('source_task'),
  provenance: text('provenance'),
}
```

### 4-3. 手続き記憶 (Procedural Patterns)

新テーブル `procedural_patterns` を追加する。

```typescript
export const proceduralPatterns = pgTable('procedural_patterns', {
  id: uuid('id').primaryKey().defaultRandom(),

  // 基本情報
  title: text('title').notNull(),
  proceduralType: text('procedural_type').notNull(),
  // 'pattern' | 'playbook' | 'policy' | 'template' | 'heuristic'

  intent: text('intent').notNull(),         // 達成したいこと
  context: text('context'),                 // 適用文脈
  embedding: vector('embedding', { dimensions: config.embeddingDimension }),

  // 構造化コンテンツ (JSONB)
  when: jsonb('when').default([]),           // 適用条件
  goal: jsonb('goal').default([]),           // 目的
  steps: jsonb('steps').default([]),         // 手順
  constraints: jsonb('constraints').default([]), // 制約
  variants: jsonb('variants').default([]),   // 状況別変形
  examples: jsonb('examples').default([]),   // 実例

  // メタデータ
  confidence: real('confidence').default(1.0),
  provenance: jsonb('provenance').default({}),
  tags: text('tags').array().default([]),
  project: text('project'),
  version: integer('version').default(1).notNull(),
  // バージョン管理: 内容の変更時にインクリメント。同一 title + proceduralType で
  // version > 1 のレコードが存在する場合、古いバージョンは deprecated: true とする。
  deprecated: boolean('deprecated').default(false).notNull(),
  expiresAt: timestamp('expires_at'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

### 4-4. 手続き記憶のグラフ関係

手続き記憶同士の関係（前提・派生・補完など）は既存の Knowledge Graph の仕組みを活用する。  
`entities` に `type: 'procedural_pattern'` のノードを作り、`relations` で `goal → how_to → episode` のような関係を表現する。

```text
[goal: エラー調査]
   │
   └─how_to→ [pattern: 再現手順を先に確認する]
                 │
                 └─grounded_in→ [episode: incident-2026-04-12]
                 └─variant_of→  [pattern: 緊急時の影響範囲優先調査]
```

---

## 5. 実装フェーズ計画

### Phase 0: 概念整理とドキュメント化（本ドキュメント）

- [x] 記憶リファクタリング設計書の作成
- [ ] 既存コードへのコメント追加（`vibe_memories`, `experience_logs`, `guidance` の位置づけを記述）

### Phase 1: エピソード記憶の強化

**目標**: `vibe_memories` を「エピソード記憶」として明示的に扱えるようにする。

- [ ] `vibe_memories` に `memory_type`, `episode_at`, `importance`, `source_task`, `compressed` フィールドを追加するマイグレーション
- [ ] `store_memory` ツールの入力スキーマに `memoryType` / `episodeAt` / `importance` を追加
- [ ] `experience_logs` を `memory_type: 'experience_success' | 'experience_failure'` として統合する方針を検討（破壊的変更のため慎重に）
- [ ] 圧縮・要約パイプラインの設計（古いエピソードを LLM で要約し `compressed: true` でフラグ）

### Phase 2: 意味記憶の品質向上

**目標**: `entities` / `relations` に確信度・出所・鮮度を持たせる。

- [ ] `entities` に `confidence`, `provenance`, `freshness`, `importance` フィールドを追加するマイグレーション
- [ ] `relations` に `confidence`, `source_task`, `provenance` フィールドを追加
- [ ] KnowFlow が知識を保存する際に `provenance` を自動付与するよう修正
- [ ] 鮮度に基づいた検索ランキング調整の実装

### Phase 3: 手続き記憶の実装

**目標**: 柔軟な `procedural_patterns` テーブルとツールを追加する。

- [ ] `procedural_patterns` テーブルのマイグレーション作成
- [ ] ベクトルインデックス（HNSW）の追加
- [ ] `store_procedure` / `search_procedure` / `apply_procedure` MCP ツールの実装
- [ ] 既存 Guidance Registry との統合方針を決定（段階的移行 or 並行運用）
- [ ] `entities` へのリンク（`type: 'procedural_pattern'` ノード）によるグラフ関係の実現

### Phase 4: コミュニティ検出の活用拡大

**目標**: コミュニティ検出をエピソード・手続き記憶のパターン発見にも適用する。

- [ ] エピソード記憶のクラスタリング（類似エピソードのグループ化）
- [ ] 手続きパターンのクラスタリング（似たパターンのコミュニティ化）
- [ ] 「繰り返し出現するパターン」を自動的に `procedural_patterns` へ昇格するパイプライン

### Phase 5: 記憶間の昇格パイプライン整備

**目標**: エピソード → 意味 → 手続きへの知識昇格を自動化する。

- [ ] 既存 `reflect_on_memories` (synthesis) を拡張し、昇格先（意味 or 手続き）を判定するロジックを追加
- [ ] エピソードの繰り返しパターンから `procedural_patterns` を半自動生成する機能
- [ ] 昇格された知識への `provenance` 自動付与

---

## 6. 既存コミュニティ検出の再利用・適応

### 現在の実装

`src/services/community.ts` は graphology + Louvain アルゴリズムを使って、`entities` / `relations` グラフのコミュニティを検出し、LLM で要約している。

```typescript
// 現在の利用
const communityMapping = louvain(graph);
// → entities を communityId でグループ化し、communities テーブルへ保存
```

### 再利用の方針

コミュニティ検出ロジックは「**最終的な知識フォーマット**」ではなく「**パターンクラスタリングの中間抽象化層**」として捉え直す。

#### 6-1. 意味記憶への適用（現状維持・拡張）

- 現在の `buildCommunities` は意味記憶のクラスタリングとして継続利用する
- `communities` テーブルは「意味的なトピッククラスタ」として位置づける
- エンティティの `communityId` は「意味記憶内のグループ」を表す

#### 6-2. エピソード記憶への適用（新規拡張）

- `vibe_memories` のベクトルを使って Louvain を実行し、類似エピソードをクラスタリング
- クラスタを `communities` テーブルに `communityType: 'episodic'` として区別して保存
- クラスタ単位での要約・圧縮に活用

#### 6-3. 手続き記憶への適用（Phase 4）

- `procedural_patterns` のベクトルを使って Louvain を実行
- 繰り返し出現するパターンのグループを検出し、より汎用的なパターンへの昇格候補として提示
- `communities` テーブルに `communityType: 'procedural'` として保存

#### 6-4. 実装への示唆

```typescript
// buildCommunities に communityType を追加するイメージ
export async function buildCommunities(
  deps: BuildCommunitiesDeps & { communityType?: 'semantic' | 'episodic' | 'procedural' } = {},
): Promise<CommunityRebuildResult | { message: string }> {
  const communityType = deps.communityType ?? 'semantic';
  // communityType に応じてグラフ構築元を切り替える
  // ...
}
```

---

## 7. リスク・トレードオフ・非ゴール

### リスク

| リスク | 深刻度 | 対策 |
|--------|--------|------|
| スキーマ変更による既存データの移行コスト | 中 | フィールド追加はデフォルト値付きで後方互換を維持。破壊的変更は Phase 2 以降に先送り |
| `experience_logs` と `vibe_memories` の統合による回帰 | 中 | 統合は任意。並行運用を Phase 3 まで継続できる設計にする |
| 手続き記憶の柔軟すぎるスキーマによる運用の複雑化 | 低-中 | `proceduralType` と `intent` を必須にし、最小限の構造を強制する |
| コミュニティ検出の計算コスト増大（エピソード・手続き分も実行）| 低 | `build_communities` は常時実行ではなく、明示的なトリガー型を維持する |
| Guidance Registry との二重管理 | 中 | Phase 3 で段階的移行の方針を明確化。新規は `procedural_patterns` へ、既存は互換維持 |

### トレードオフ

- **シンプルさ vs 表現力**: `procedural_patterns` の JSONB フィールドは柔軟だが、スキーマが緩くなりすぎるリスクがある。必須フィールドを Zod で厳格に検証することでバランスを取る。
- **統合 vs 分離**: `experience_logs` を `vibe_memories` に統合すると管理がシンプルになるが、Experience 専用ツールの挙動変更が必要になる。移行は慎重に行う。
- **自動化 vs 透明性**: エピソードから手続きへの自動昇格は利便性が高いが、誤昇格のリスクもある。初期は「候補提示」として人間の確認を要する設計にする。

### 非ゴール

- **感覚記憶・プライミング・条件づけの実装**: これらは LLM 側のプロンプト調整層であり、Gnosis のデータ層では管理しない
- **LLM Context Window の管理**: Gnosis はコンテキスト内容を保持しない。あくまで長期記憶の専門基盤
- **リアルタイムの記憶更新**: Gnosis は非同期の長期記憶基盤であり、ミリ秒レベルのリアルタイム更新は目指さない
- **他のエージェントフレームワーク（LangChain 等）への対応**: MCP プロトコルを通じた互換性に留め、特定フレームワーク専用の実装は行わない
- **手続き記憶の実行エンジン化**: `procedural_patterns` はあくまで参照・注入用のデータであり、自律実行エンジンにはしない

---

## 8. 将来の拡張について

### 8-1. 記憶の忘却設計

長期運用でのデータ肥大化を防ぐため、以下の忘却メカニズムを将来的に実装することが望ましい。

- **エピソード記憶の圧縮**: 参照カウントが低く、古いエピソードを LLM で要約し圧縮する定期バッチ
- **意味記憶の鮮度管理**: `freshness` フィールドが古い entities を定期的に再検証または削除候補としてフラグ
- **手続き記憶のバージョン管理**: `deprecated` フラグと `version` フィールドによる世代管理

### 8-2. 記憶間の相互強化

- **エピソード → 意味記憶の昇格**: 複数のエピソードから繰り返し登場するエンティティを意味記憶に自動昇格
- **意味記憶 + エピソード → 手続き記憶の生成**: 「同じ文脈で同じ解決策が有効だった」パターンを手続き記憶として半自動生成
- **手続き記憶の評価ループ**: エピソードのアウトカムから手続きパターンの `confidence` を自動更新

### 8-3. 多テナント・プロジェクト分離

- `project` / `sessionId` / `namespace` の概念を強化し、プロジェクト固有記憶と汎用記憶の明示的な分離を実現
- チーム共有知識と個人記憶の分離設計

### 8-4. 評価基盤との統合

- 記憶の再現率・精度を定量評価する `eval/` 拡張
- 「このエピソードが将来の判断に役立ったか」をトラッキングする活用ログ
- 手続きパターンの適用成功率を記録し、`confidence` の自動更新に活用

### 8-5. Knowledge Federation

- 将来的に複数 Gnosis インスタンス間で意味記憶・手続き記憶を共有する federation 機能
- プロジェクトをまたいだパターン再利用の実現
