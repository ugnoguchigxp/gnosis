# Gnosis: セキュリティニュース収集とキュレーション実装計画

## 1. 目的と概要

Tauriで構築中のGnosis監視アプリに「セキュリティニュースのキュレーション」機能を追加する。
`localLlm` をバックグラウンドで活用していくつかのセキュリティ情報ソースを定期チェックし、
Knowledge Graph（KG）に記録されているプロジェクトの技術スタックと記事の内容を照合する。
関連するセキュリティの脅威や脆弱性が確認された場合、監視アプリの「Security News」ボタンを通じて、
キュレーションされたニュースリンクを開発者に提示する。

---

## 2. アーキテクチャと要素技術

### 2.1 ニュース収集プロセス (Crawler & LLM Analyzer)

- **バッチ処理**: 1日1回を基本とし、macOS LaunchAgent で登録・管理する（`com.gnosis.secnews.plist`）。
- **ターゲットソース**: 以下4サイトのトップページをHTMLスクレイピングで取得し、記事リストを抽出する。

| サイト | URL | 取得方法 | 特徴 |
|--------|-----|---------|------|
| [The Hacker News](https://thehackernews.com/) | `https://thehackernews.com/` | HTML scraping | 英語・セキュリティ専門・更新頻度高 |
| [BleepingComputer](https://www.bleepingcomputer.com/) | `https://www.bleepingcomputer.com/` | HTML scraping | 英語・マルウェア/CVE速報が豊富 |
| [CSO Online](https://www.csoonline.com/) | `https://www.csoonline.com/` | HTML scraping | 英語・企業向けセキュリティ記事 |
| [ITmedia エンタープライズ（セキュリティ）](https://www.itmedia.co.jp/enterprise/security/) | `https://www.itmedia.co.jp/enterprise/security/` | HTML scraping | 日本語・国内脅威情報もカバー |

#### 各サイトのスクレイピング仕様

```typescript
// src/scripts/secnews-fetch.ts
// fetch() + HTMLRewriter (Bun組み込み) または cheerio でDOM解析

const SOURCES = [
  {
    id: 'thehackernews',
    url: 'https://thehackernews.com/',
    lang: 'en',
    // 記事リストのCSSセレクタ（トップページの記事カード）
    articleSelector: 'div.body-post',
    titleSelector: 'h2.home-title',
    linkSelector: 'a.story-link',
    summarySelector: 'div.home-desc',
  },
  {
    id: 'bleepingcomputer',
    url: 'https://www.bleepingcomputer.com/',
    lang: 'en',
    articleSelector: 'div.bc_latest_news_text',
    titleSelector: 'h4 > a',
    linkSelector: 'h4 > a',
    summarySelector: 'p',
  },
  {
    id: 'csoonline',
    url: 'https://www.csoonline.com/',
    lang: 'en',
    articleSelector: 'div.card--article',
    titleSelector: 'h3.card__title',
    linkSelector: 'a.card__title-link',
    summarySelector: 'p.card__description',
  },
  {
    id: 'itmedia-enterprise-security',
    url: 'https://www.itmedia.co.jp/enterprise/security/',
    lang: 'ja',
    articleSelector: 'div.colBoxIndex ul li',
    titleSelector: 'a',
    linkSelector: 'a',
    summarySelector: 'p',
  },
] satisfies ScrapeSource[];
```

> **注意**: 各サイトのDOM構造は変更される場合があるため、セレクタは定数として管理し、フォールバック（テキスト全文抽出）を持たせる。
> スクレイピングは相手サーバーへの配慮として1サイトあたり1リクエストのみ（トップページのHTMLのみ取得）とし、個別記事への自動クロールは行わない。

---

### 2.2 処理フロー（スクレイピング → 2段階フィルタリング → LLM評価）

LLMへの不要な呼び出しを抑えるため、以下の順序で処理する。

```
[Step 0: 4サイトのトップページをHTMLスクレイピング]
  - fetch() でHTMLを取得 → cheerio/HTMLRewriter でDOM解析
  - 記事タイトル・URL・概要テキストを構造化して抽出
  - 1サイト = 1リクエスト（トップページのみ、クロールなし）
    │ 抽出された記事リスト（全サイト合計: 目安30〜60件）
    ▼
[Step 1: ルールベース一次フィルタ]  ← LLMを使わない高速フィルタ
  - dedupeキー確認（既処理URLはスキップ）
  - CVE番号パターン (CVE-YYYY-NNNN) の有無を確認
  - KGの技術スタック名キーワードとタイトル/概要を文字列照合
    （例: "Bun", "TypeScript", "Rust", "PostgreSQL", "Svelte", "npm", "Node.js" 等）
  - 明らかに無関係な記事を除外（Windows固有、iOS/Android固有、物理セキュリティ等）
    │ 通過した記事のみ（目安: 5〜15件）
    ▼
[Step 2: LLM評価 (localLlm)]  ← 1記事ずつ順次処理、skip-if-busy
  - タイトル + 概要テキストをプロンプトに渡す
  - 出力: matchedStacks（影響技術）/ severity（CRITICAL/HIGH/MEDIUM/LOW）
           / summary（1〜2行の日本語要約）/ affectedVersions
  - LLMが「関係なし」と判定した記事はここで除外
    │
    ▼
[Step 3: 保存]
  - logs/security_news.jsonl に追記
  - syncState テーブルのカーソルを更新（冪等保証）
```

#### LLM評価プロンプト仕様

```typescript
// 1記事あたりのプロンプト（トークン数を抑えるためタイトル+概要のみ渡す）
const prompt = `
以下のセキュリティニュース記事を読み、プロジェクトの技術スタックへの関連性を評価してください。

【対象技術スタック】
${stackNames.join(', ')}

【記事情報】
タイトル: ${article.title}
概要: ${article.summary}
URL: ${article.url}

以下のJSON形式のみで返答してください。余分な説明は不要です。
{
  "relevant": true または false,
  "matchedStacks": ["マッチした技術名"],
  "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
  "summary": "1〜2行の日本語要約（relevantがfalseの場合は空文字）",
  "affectedVersions": "影響バージョン範囲（不明な場合はnull）"
}
`.trim();
```

---

### 2.3 KGからの技術スタック取得方法

KGの `entities` テーブルから、`type` が技術スタック関連のエンティティを一括取得して照合キーとして使う。

```typescript
// 利用する既存関数: src/services/graph.ts
import { searchEntitiesByText } from '../services/graph.js';

// 技術スタック一覧の取得（type: "Technology" / "Library" / "Framework" 等でフィルタ）
// drizzle で直接クエリする場合:
const stackEntities = await db
  .select({ id: entities.id, name: entities.name, type: entities.type })
  .from(entities)
  .where(inArray(entities.type, ['Technology', 'Library', 'Framework', 'Tool']));
```

> **Note**: KGに登録されていない技術スタックは検出対象外になる。初期セットアップ時に代表的な技術（Bun, TypeScript, Rust, Tauri, PostgreSQL, Drizzle, Svelte, Node.js 等）がKGに登録済みであることを前提とする。

---

### 2.4 保存スキーマ

#### JSONL形式（`logs/security_news.jsonl`）

各行が1件のキュレーション済みニュースを表す。

```jsonc
{
  "id": "CVE-2024-12345",               // CVE番号 or URLベースのdedupeキー
  "title": "...",                        // 記事タイトル
  "url": "https://...",                 // 元記事URL
  "source": "osv.dev",                  // 収集元ソース
  "publishedAt": "2024-01-15T00:00:00Z", // 公開日時 (ISO8601)
  "severity": "HIGH",                   // CRITICAL / HIGH / MEDIUM / LOW
  "cvss": 8.5,                          // CVSS スコア (nullable)
  "matchedStacks": ["Bun", "Node.js"],   // KGとマッチした技術スタック名
  "summary": "...",                     // LLMが生成した1〜2行の要約
  "affectedVersions": "< 1.2.0",        // 影響バージョン (nullable)
  "isRead": false,                      // 既読フラグ
  "curatedAt": "2024-01-16T00:00:00Z"   // キュレーション日時
}
```

> **Note**: JSONLは追記専用のため、既読更新は「id一致でフラグ更新した全件を再書き出し」するか、
> 別ファイル（`logs/security_news_state.json`）に既読IDセットを保持する簡易方式を採用する。
> ※ DB管理に昇格する場合は後述のDrizzleスキーマ案を参照。

#### DBテーブル案（将来拡張）

JSONLではなくDB管理に移行する場合は、`schema.ts` に以下を追加し `drizzle-kit push` でマイグレーションする。

```typescript
export const securityNews = pgTable(
  'security_news',
  {
    id: text('id').primaryKey(),           // CVE番号 or URL hash
    title: text('title').notNull(),
    url: text('url').notNull(),
    source: text('source').notNull(),
    publishedAt: timestamp('published_at'),
    severity: text('severity').notNull(),  // 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'
    cvss: real('cvss'),
    matchedStacks: jsonb('matched_stacks').default([]).notNull(),
    summary: text('summary'),
    affectedVersions: text('affected_versions'),
    isRead: boolean('is_read').default(false).notNull(),
    curatedAt: timestamp('curated_at').defaultNow().notNull(),
  },
  (table) => ({
    severityIdx: index('security_news_severity_idx').on(table.severity),
    curatedAtIdx: index('security_news_curated_at_idx').on(table.curatedAt),
  }),
);
```

---

### 2.5 重複排除（Deduplication）

- **CVE番号ベース**: 同一CVEが複数ソース（NVD + Snyk等）に載る場合、`id = CVE番号` をdedupeキーとして扱い、後発情報でupsertする。
- **CVE番号なし記事**: URLをSHA256ハッシュしたものをdedupeキーとする。
- **冪等実行**: 既存の `syncState` テーブル（`src/db/schema.ts`）を活用し、ソースごとに最終取得カーソル（`lastFetchedAt`）を記録する。これにより再実行時に同じ記事を二重処理しない。

```typescript
// syncState テーブルのID規則
// 'secnews:osv.dev', 'secnews:nvd', 'secnews:github-advisory' 等
```

---

### 2.6 LLMロック競合戦略

既存の `withGlobalLock('local-llm', ...)` と競合するため、以下の **skip-if-busy** 方針を採用する。

```typescript
// セキュリティニュースバッチはロックが取れない場合はスキップ（エラーにしない）
const result = await tryGlobalLock('local-llm', async () => {
  return await analyzeArticleWithLlm(article);
});
if (!result) {
  console.log('[SecNews] LLM busy, skipping article analysis. Will retry next batch.');
  return;
}
```

> **理由**: セキュリティニュースは数時間〜1日の遅延が許容されるため、KnowFlowワーカー等の優先度が高いジョブをブロックしない。スキップされた記事は次回バッチで再処理する（syncStateのカーソルを進めない）。

---

### 2.7 Tauri 監視アプリへの統合 (UI)

#### Rust バックエンド (Collector)

- `tauri-monitoring-implementation-plan.md` の「CLI先行」原則を踏襲し、Rustバックエンドは **CLIコマンド経由** でJSONLを読み取る。

```rust
// src-tauri/src/monitor/cli.rs に追加
// `bun run src/scripts/monitor-secnews.ts` を呼び出し、JSONを受け取る
```

- Tauri起動時 + 30分に1回 `logs/security_news.jsonl` の更新を `notify-rs` で検知し、変化があればフロントエンドに `secnews_updated` イベントをpushする。

#### SvelteKit フロントエンド (UI)

- **Security News ボタン**: ヘッダーに追加。未読件数 > 0 かつ CRITICAL/HIGH が含まれる場合は赤バッジを表示。MEDIUM以下のみの場合は黄バッジ。
- **詳細パネル (Sheet)**: ボタン押下でスライドインし、キュレーションされたニュースをリスト表示。
- **表示項目**: タイトル / 影響スタック（Badgeタグ） / 重要度（色付きBadge） / 公開日 / 外部リンク
- **既読フラグ**: パネル表示時に一括既読（または個別に既読ボタン）。既読IDセットを `logs/security_news_state.json` に書き戻す（Tauri `fs` API経由）。

---

## 3. 実装フェーズ

### Phase 1: 収集と判定ロジックの実装 (Bun)

- [ ] `src/scripts/secnews-fetch.ts` — OSV.dev / GitHub Advisory API から記事を取得し、ルールベース一次フィルタを実施
- [ ] `src/scripts/secnews-analyze.ts` — LLM解析プロンプト定義、KG照合、スコアリング
- [ ] `src/scripts/secnews-curator.ts` — 上記2つを組み合わせ `logs/security_news.jsonl` へ保存するエントリポイント
- [ ] `syncState` テーブルへのカーソル記録（冪等実行の保証）

### Phase 2: バッチ定期実行化

- [ ] `scripts/automation/com.gnosis.secnews.plist` の作成
  - 実行タイミング: 毎朝4:00（KnowFlowワーカーの稼働が少ない時間帯）
  - ログ出力先: `logs/secnews.log`
- [ ] `scripts/setup-automation.sh` にインストールステップを追記

### Phase 3: Tauri UI 改修 (Rust + SvelteKit)

- [ ] `src-tauri/src/monitor/cli.rs` — `monitor-secnews` CLIの呼び出し追加
- [ ] `src-tauri/src/monitor/state.rs` — SecurityNews ストアの追加（リングバッファ、最大100件）
- [ ] `src-tauri/src/monitor/ws.rs` — `secnews_updated` イベントの配信
- [ ] `apps/monitor/src/lib/monitor/types.ts` — `SecurityNewsItem` 型の追加
- [ ] `apps/monitor/src/routes/+page.svelte` — Security News ボタン・バッジ・Sheetの追加

---

## 4. 考慮事項と課題

- **LLMの負荷制御**: ルールベース一次フィルタで対象記事を絞り込み、LLMには1バッチあたり最大10〜20件のみ渡す。
- **過検知（False Positives）**: 技術名が一般的な単語と同じ場合（Go, Node等）は、CVE番号または公式記述との組み合わせで判定。今回はあくまで「関連ニュースの提示」であり、「確実に影響あり」とは明示しない。
- **保持期間**: キュレーション済みニュースは **30日** を上限とし、バッチ実行時に古いエントリを自動削除（JSONLの全件再書き出し）する。
- **オフライン時**: ネットワーク取得に失敗した場合はサイレントにスキップ（ログ記録のみ）し、次回バッチで再試行する。syncStateのカーソルは進めない。
- **重要度アラートレベル**:
  - `CRITICAL`（CVSS 9.0+）: 赤バッジ + 即時macOS通知
  - `HIGH`（CVSS 7.0〜8.9）: 赤バッジのみ
  - `MEDIUM`以下: 黄バッジのみ（通知なし）
- **リアルタイム性**: メトリクス監視（Queue/Worker）は秒単位、セキュリティニュースは数時間〜1日遅れのバッチ反映で許容する。

---

## 5. 受け入れ基準

- OSV.dev / GitHub Advisory から最新の脆弱性情報を取得し、プロジェクトのKGスタックとの照合が動作すること
- 関連ニュースが1件以上ある場合、監視アプリのSecurityNewsボタンにバッジが表示されること
- ボタン押下でキュレーション済みニュース一覧がSheetに表示され、外部リンクへ遷移できること
- 既読フラグが正しく保존・反映され、全件既読後はバッジが消えること
- LLMバッチ実行中にKnowFlowワーカー等の他ジョブをブロックしないこと（skip-if-busy）
- 1か月連続稼働でJSONLの件数が上限（30日分）を超えないこと
