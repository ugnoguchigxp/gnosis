# DiffGuard 機能要望書

**From**: Gnosis Code Review Agent 実装計画  
**To**: DiffGuard リポジトリ  
**Date**: 2026-04-15  
**Priority**: 高 → 低の順に記載

---

## 背景

Gnosis は DiffGuard MCP を以下の用途で利用する計画である。

| Stage | 用途 | 使用ツール |
|-------|------|-----------|
| B | diff 構造解析（変更タイプ検出・ファイル分類） | `analyze_diff` |
| B | 決定論的ルールベースレビュー | `review_diff` |
| C | オーケストレータからのパイプライン呼び出し | `review_diff` / `review_batch` |

DiffGuard は既に実用的な基盤を持つが、Gnosis 計画の要件と比較するといくつかのギャップがある。

---

## 要望一覧

### REQ-D01: ChangeType の拡張（優先度: 高）

**現状の課題**:  
`ChangeType` が 3 種類のみ。

| 現状 (3種) | 検出対象 |
|-----------|---------|
| `function-signature` | 関数のシグネチャ変更 |
| `interface-change` | interface の構造変更 |
| `import-change` | import 文の変更 |

Gnosis の `extractRiskSignals` / `classifyFile` は **変更の性質をより細かく** 把握する必要がある。

**要望**:  
以下の ChangeType を追加する。

```typescript
type ChangeType =
  // 既存
  | 'function-signature'
  | 'interface-change'
  | 'import-change'
  // ← 追加
  | 'type-alias-change'      // type X = ... の変更
  | 'enum-change'            // enum の追加・変更
  | 'class-change'           // class 宣言・メソッド・プロパティの変更
  | 'export-change'          // export の追加・削除・変更
  | 'function-body-change'   // シグネチャではなく本体のロジック変更
  | 'config-change'          // .json / .toml / .yaml 設定ファイルの変更
  | 'migration-change';      // DB マイグレーションファイルの変更
```

**影響範囲**:  
- `diffAnalyzer.ts` の `detectChangeTypes` に検出ロジック追加
- `DG001` / `DG002` の対象 ChangeType 拡大
- `analyze_diff` のレスポンスが拡張される

---

### REQ-D02: ファイル分類情報の付与（優先度: 高）

**現状の課題**:  
`analyze_diff` の `FileDiffAnalysis` にはファイルのパス・変更行数・変更タイプが含まれるが、  
そのファイルが **何の役割か** (テスト / 設定 / マイグレーション / インフラ / プロダクション) の情報がない。

Gnosis は独自に `classifyFile` を実装する予定だが、diff のパース結果と同時にファイル分類が返れば MCP 呼び出しが減り、分類精度も上がる。

**要望**:  
`FileDiffAnalysis` に `classification` フィールドを追加する。

```typescript
interface FileClassification {
  isTest: boolean;         // test/ / __tests__ / *.test.* / *.spec.*
  isConfig: boolean;       // *.json / *.toml / *.yaml / *.yml (tsconfig 等)
  isMigration: boolean;    // migration / drizzle / prisma / flyway パス
  isInfra: boolean;        // Dockerfile / docker-compose / k8s / terraform
  isGenerated: boolean;    // generated / __generated__ / .gen.
  framework?: string;      // 検出されたフレームワーク名 ('react' / 'svelte' / 'express' 等)
}

interface FileDiffAnalysis {
  file: string;
  additions: number;
  deletions: number;
  changeTypes: ChangeType[];
  classification: FileClassification;  // ← 追加
}
```

**判定ロジック**: パスパターンとファイル拡張子のマッチングで十分（AST 不要）。

---

### REQ-D03: リスクシグナルの抽出と返却（優先度: 高）

**現状の課題**:  
Gnosis の `extractRiskSignals` は diff テキストに対して正規表現でリスクキーワード（`auth`, `password`, `payment`, `sudo`, `eval` 等）を検出している。  
DiffGuard は既に diff をパースしているため、ここでリスクシグナルも抽出して返したほうが効率的。

**要望**:  
`analyze_diff` レスポンスにリスクシグナルを追加する。

```typescript
interface RiskSignal {
  type: string;              // 'auth' | 'payment' | 'crypto' | 'eval' | 'sql' | 'secret' | ...
  file: string;
  line: number;
  matchedPattern: string;    // マッチした文字列
  severity: 'high' | 'medium' | 'low';
}

interface AnalyzeDiffResponse {
  files: FileDiffAnalysis[];
  totalAdditions: number;
  totalDeletions: number;
  riskSignals: RiskSignal[];  // ← 追加
}
```

**組み込みシグナルパターンの例**:

| type | パターン例 | severity |
|------|----------|----------|
| `auth` | `password`, `token`, `secret`, `api_key`, `credentials` | high |
| `payment` | `charge`, `invoice`, `billing`, `stripe`, `payment` | high |
| `crypto` | `encrypt`, `decrypt`, `hash`, `hmac`, `jwt` | medium |
| `eval` | `eval(`, `Function(`, `new Function` | high |
| `sql` | `exec(`, `query(`, `rawQuery`, `$queryRaw` | medium |
| `permission` | `role`, `admin`, `sudo`, `privilege`, `acl` | medium |

---

### REQ-D04: セキュリティルールの追加（優先度: 中）

**現状の課題**:  
DG001–DG004 は API 互換性・構造整合性のルール。  
セキュリティ観点のルールが存在しない。

**要望**:  
以下のルールを追加する。

| Rule ID | 名前 | 検出内容 |
|---------|------|---------|
| DG005 | `hardcoded-secret` | diff 内にハードコードされた秘密情報パターン（`API_KEY = "..."`, `password: "..."` 等）|
| DG006 | `unsafe-eval` | `eval()`, `new Function()`, `vm.runInNewContext()` の新規追加 |
| DG007 | `sql-injection-risk` | 文字列結合による SQL 構築（`"SELECT " + ...`, テンプレートリテラル `${}`内でSQLキーワード）|
| DG008 | `insecure-dependency` | diff で追加された dependency の既知脆弱性チェック（npm audit レベル）|

**severity 基準**:

| Rule | Default Level |
|------|--------------|
| DG005 | error (blocking) |
| DG006 | warning |
| DG007 | warning |
| DG008 | info |

> DG005 は Gnosis の `SECRET_FILTER` と連携し、false positive を減らすために suppressions 設定をサポートすべき。

---

### REQ-D05: finding に confidence / evidence フィールド追加（優先度: 中）

**現状の課題**:  
`Finding` 型は以下の構造。

```typescript
interface Finding {
  ruleId: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  metadata?: Record<string, unknown>;
}
```

Gnosis が finding を取り込む際、**信頼度** と **根拠テキスト** がないと LLM への入力として弱い。  
また `metadata` はアンタイプドで使いにくい。

**要望**:

```typescript
interface Finding {
  ruleId: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  endLine?: number;              // ← 追加: 範囲終了行
  confidence: 'high' | 'medium' | 'low';  // ← 追加
  evidence?: string;             // ← 追加: 検出根拠（マッチした行テキスト等）
  category?: string;             // ← 追加: 'security' | 'compatibility' | 'quality' | ...
  metadata?: Record<string, unknown>;
}
```

**Gnosis 側の利用方法**:
- `confidence: 'high'` の finding → LLM確認不要、直接レポート反映
- `confidence: 'medium'` → LLM で検証
- `confidence: 'low'` → コンテキスト情報として LLM に渡すのみ
- `evidence` → Stage D の修正候補生成でターゲット文字列として利用

---

### REQ-D06: `review_diff` でのコンテキストファイル受け渡し（優先度: 中）

**現状の課題**:  
`review_diff` は diff テキストのみを入力とする。  
DG001 (missing-update) は「関数シグネチャが変わったが呼び出し元が更新されていない」を検出するが、**呼び出し元のファイル内容** がないため diff 内に含まれるファイルしか検査できない。

**要望**:  
`review_diff` に関連ファイルの内容を渡すオプションを追加する。

```typescript
interface ReviewDiffInput {
  diff: string;
  files?: string[];
  // ← 追加
  relatedSources?: Array<{
    path: string;
    content: string;
  }>;
}
```

**ユースケース**:
- Gnosis が Astmend の参照解析で「`getUser` の呼び出し元は `auth.ts` と `profile.ts`」と判明
- → `relatedSources` に `auth.ts` と `profile.ts` を渡す
- → DG001 が diff 外のファイルも含めて missing-update を検出可能

> Astmend の REQ-A01（プロジェクト横断参照解析）と組み合わせることで精度が大幅に向上する。

---

### REQ-D07: `analyze_diff` でのファイル操作種別（優先度: 低）

**現状の課題**:  
`FileDiffAnalysis` にはファイルが新規追加・削除・リネームされたかの情報がない。  
Gnosis は diff ヘッダー（`--- /dev/null`, `rename from`）を自前でパースしている。

**要望**:

```typescript
interface FileDiffAnalysis {
  file: string;
  operation: 'added' | 'modified' | 'deleted' | 'renamed';  // ← 追加
  oldFile?: string;       // ← renamed の場合のリネーム元
  additions: number;
  deletions: number;
  changeTypes: ChangeType[];
  classification: FileClassification;
}
```

---

### REQ-D08: プラグインからの severity / blocking 制御（優先度: 低）

**現状の課題**:  
プラグインシステムは存在するが、プラグインから `blocking: true` を返す方法が明確でない。  
Gnosis はレビュー結果全体の `blocking` フラグで Gate 判定を行うため、カスタムルールが blocking に寄与できる必要がある。

**要望**:  
プラグインの `ReviewPlugin` インターフェースで finding の level が `error` かつ特定条件で `blocking` に寄与できることを明文化する。  
または `ReviewResult` の `blocking` 算出ロジックにプラグイン finding を含める。

```typescript
interface ReviewPlugin {
  name: string;
  version: string;
  rules: PluginRule[];
}

interface PluginRule {
  id: string;
  // ← 追加
  canBlock?: boolean;  // true の場合、level='error' のfinding が blocking に寄与
  check(context: ReviewContext): Finding[];
}
```

---

## 実装順の提案

```
Phase 1 (Gnosis Stage B に必要):
  REQ-D01 → REQ-D02 → REQ-D03

Phase 2 (Gnosis Stage B~C の精度向上):
  REQ-D05 → REQ-D04

Phase 3 (Astmend 連携・精度向上):
  REQ-D06 → REQ-D07

Phase 4 (拡張性):
  REQ-D08
```

---

## 備考

- DiffGuard の「LLM は optional」「決定論的ルールが主」の原則は変えない前提
- Gnosis 側は DiffGuard 不在時の縮退動作を実装済み（DiffGuard がなくてもレビューは動く）
- REQ-D03 (リスクシグナル) と REQ-D04 (セキュリティルール) は重複するパターンがあるため、シグナル検出を共通基盤として内部的に統合することを推奨
- REQ-D06 は Astmend REQ-A01 との組み合わせが前提。Astmend 側が先に実装されていれば効果が大きい

---

## Astmend ↔ DiffGuard 連携図

```
Gnosis Orchestrator
├── DiffGuard.analyze_diff   ──→ ChangeTypes + FileClassification + RiskSignals
├── Astmend.extract_changed_symbols ──→ ChangedSymbol[]
├── Astmend.analyze_references_from_project ──→ cross-file references
│   └── reference files を DiffGuard.review_diff の relatedSources に渡す
├── DiffGuard.review_diff    ──→ Findings (confidence + evidence 付き)
├── Astmend.detect_impact_from_file ──→ impacted declarations
└── LLM Review (enriched context)
```

上記の連携を最大限に活用するためには、**Astmend の REQ-A01 / REQ-A02 と DiffGuard の REQ-D01 / REQ-D02 / REQ-D06 が最も重要** である。
