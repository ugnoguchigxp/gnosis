# Astmend 機能要望書

**From**: Gnosis Code Review Agent 実装計画  
**To**: Astmend リポジトリ  
**Date**: 2026-04-15  
**Priority**: 高 → 低の順に記載

---

## 背景

Gnosis は Astmend MCP を以下の用途で利用する計画である。

| Stage | 用途 | 使用ツール |
|-------|------|-----------|
| B | 変更シンボルの参照解析・影響範囲検出 | `analyze_references_from_file`, `detect_impact_from_file` |
| D | 採用された finding に対する安全な修正候補生成 | `apply_patch_to_text` |

現状の Astmend は **単一ファイル内の解析** に限定されており、Gnosis 計画で必要な機能との間にいくつかのギャップがある。

---

## 要望一覧

### REQ-A01: プロジェクト横断の参照解析（優先度: 高）

**現状の課題**:  
`analyze_references_from_file` は `useInMemoryFileSystem: true` で単一ファイルを読み込むため、**同じファイル内の参照しか検出できない**。  
Gnosis は「変更された `getUser` 関数を他のどのファイルが使っているか」を知る必要がある。

**要望**:  
プロジェクトルートまたは複数ファイルパスを受け取り、対象シンボルの **ファイルをまたいだ参照** を返すツールを追加する。

```typescript
// 案 A: プロジェクトルート指定
interface AnalyzeReferencesProjectInput {
  projectRoot: string;         // tsconfig.json を含むルートパス
  target: ReferenceTarget;     // { kind, name }
  entryFile: string;           // target が定義されているファイル
  maxDepth?: number;           // 探索する import チェーンの深さ上限
}

// 案 B: ファイルリスト指定（軽量版）
interface AnalyzeReferencesMultiInput {
  filePaths: string[];
  target: ReferenceTarget;
}
```

**期待するレスポンスの拡張**:

```typescript
interface ReferenceLocation {
  file: string;            // ← 現状は同一ファイル前提で返っていない
  line: number;
  column: number;
  text: string;
  isDefinition: boolean;   // 定義箇所か参照箇所か
}
```

**MCP ツール名（案）**: `analyze_references_from_project`

---

### REQ-A02: diff からの変更シンボル抽出（優先度: 高）

**現状の課題**:  
Gnosis 側では diff から変更シンボルを **正規表現で抽出** しているが、以下のケースで誤検出・見逃しが起きる。

- `export default function` のシンボル名取得漏れ
- アロー関数・メソッドの取りこぼし
- 行をまたぐ宣言
- ネストされた interface / type alias

**要望**:  
unified diff を受け取り、変更・追加・削除されたシンボルを AST ベースで正確に返すツールを追加する。

```typescript
interface ExtractSymbolsInput {
  diff: string;              // unified diff
  sourceText?: string;       // 変更後の全体テキスト（任意: より正確な解析用）
}

interface ChangedSymbol {
  name: string;
  kind: ReferenceTargetKind;
  file: string;
  changeType: 'added' | 'modified' | 'removed';
  line: number;
  isExported: boolean;       // REQ-A03 とセット
}

interface ExtractSymbolsResponse {
  symbols: ChangedSymbol[];
}
```

**MCP ツール名（案）**: `extract_changed_symbols`

> これにより Gnosis の `extractChangedSymbols` の正規表現実装が不要になり、精度が大幅に向上する。

---

### REQ-A03: export / visibility 情報の付与（優先度: 高）

**現状の課題**:  
`ReferenceAnalysis` のレスポンスに対象シンボルが `export` されているかの情報がない。  
Gnosis は「公開 API の変更 + 外部参照あり → `api_break_risk`」を判定するために、export 有無を知る必要がある。

**要望**:  
`analyzeReferences` / `ReferenceAnalysis` のレスポンスに以下を追加する。

```typescript
interface ReferenceAnalysis {
  target: ReferenceTarget;
  isExported: boolean;         // ← 追加
  exportKind?: 'named' | 'default' | 'namespace';  // ← 追加
  references: ReferenceLocation[];
  impactedDeclarations: ImpactedDeclaration[];
}
```

---

### REQ-A04: バッチ解析 API（優先度: 中）

**現状の課題**:  
Gnosis は変更されたシンボルごとに `analyze_references_from_file` + `detect_impact_from_file` を **逐次呼び出し** している。  
10 シンボル変更があると 20 回の MCP 往復が発生する。

**要望**:  
複数 target をまとめて解析するバッチツールを追加する。

```typescript
interface BatchAnalyzeInput {
  filePath: string;
  targets: ReferenceTarget[];
}

interface BatchAnalyzeResponse {
  results: Array<{
    target: ReferenceTarget;
    references: ReferenceLocation[];
    impactedDeclarations: ImpactedDeclaration[];
  }>;
}
```

**MCP ツール名（案）**: `batch_analyze_references`

> REQ-A01 と組み合わせてプロジェクト横断バッチ解析が可能なら理想的。

---

### REQ-A05: パラメータ / プロパティ削除操作（優先度: 中）

**現状の課題**:  
パッチ操作として `add_param` / `add_property` / `add_import` / `remove_import` は存在するが、  
`remove_param` / `remove_property` がない。

Gnosis Stage D の修正候補生成で以下のケースが対応不可。

| Finding カテゴリ | 必要な操作 | 現状 |
|----------------|----------|------|
| `unused-parameter` | `remove_param` | ❌ 未対応 |
| `deprecated-property` | `remove_property` | ❌ 未対応 |
| `unused-import` | `remove_import` (named 指定) | ✅ 対応済み |

**要望**:

```typescript
// update_function に remove_param を追加
interface UpdateFunctionChanges {
  add_param?: { name: string; type: string };
  remove_param?: { name: string };  // ← 追加
}

// update_interface に remove_property を追加
interface UpdateInterfaceChanges {
  add_property?: { name: string; type: string };
  remove_property?: { name: string };  // ← 追加
}
```

---

### REQ-A06: `remove_import` のモジュール全体削除対応（優先度: 低）

**現状の課題**:  
`remove_import` は `named: [{ name }]` の指定が必須。  
DiffGuard `DG003` (unused-import) が返す情報からは、`symbol` (e.g. `unusedHelper`) は取れるがモジュールパスとの紐付けが必要。

**要望**:

```typescript
// named を省略した場合、module のインポート宣言全体を削除
interface RemoveImportOperation {
  type: 'remove_import';
  file: string;
  module: string;
  named?: NamedImport[];  // ← optional に変更。省略時はモジュール全体削除
}
```

---

### REQ-A07: rename_symbol 操作（優先度: 低）

**現状の課題**:  
将来的に Stage D でリファクタリング提案を生成する際、シンボル名の変更が必要になる可能性がある。

**要望**:

```typescript
interface RenameSymbolOperation {
  type: 'rename_symbol';
  file: string;
  target: { kind: ReferenceTargetKind; name: string };
  newName: string;
}
```

> これは優先度低。REQ-A01 (プロジェクト横断) が実現した後に意味を持つ。

---

## 実装順の提案

```
Phase 1 (Gnosis Stage B に必要):
  REQ-A03 → REQ-A02 → REQ-A01

Phase 2 (Gnosis Stage D に必要):
  REQ-A05 → REQ-A06

Phase 3 (効率化):
  REQ-A04

Phase 4 (将来):
  REQ-A07
```

---

## 備考

- Astmend の「ファイル保存しない」「diff で返す」「冪等性」の原則は変えない前提
- Gnosis 側はすべての Astmend 呼び出しで **不在時の縮退動作** を実装済み（Astmend がなくてもレビューは動く）
- REQ-A01 が `ts-morph` の `Project` をディスクファイルシステムで構築する必要がある点は、パフォーマンスとの兼ね合いで検討が必要
