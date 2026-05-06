# Vibe Memory MCP Tools 実装計画

実装状況: 完了。

- service: `src/services/vibeMemoryLookup.ts`
- MCP public tools: `memory_search`, `memory_fetch`
- agentic_search 内部 tools: `memory_search`, `memory_fetch`
- tests: `test/vibeMemoryLookup.test.ts`, MCP contract/snapshot, agentic_search registry/runner, agent-first MCP handler
- 検証: `bun run verify:fast`, `bun run doctor`

## 目的

`vibe_memories` に保存された過去の生メモリを、MCP から直接参照できるようにする。

現在の `search_knowledge` は entity knowledge を見る導線であり、`vibe_memories` の raw memory を直接読む導線ではない。過去会話、作業断片、agentic answer の保存結果などを確認したい場合、entity 化・知識化されていない情報にもアクセスできる必要がある。

ただし、`vibe_memories` の raw JSON や metadata 全体を MCP に返すと context が膨らみ、利用者も欲しい部分を探す負担が大きい。そのため、Web 検索の `search` / `fetch` と同じ2段構成で、一覧は薄い snippet、詳細は必要部分だけを抽出して返す。

この機能は、通常の知識取得の主導線ではなく、コンテキスト圧縮で会話・作業履歴の詳細が見えなくなった場合の再取得手段として使う。圧縮後の summary だけでは不足する時に、過去 memory を検索し、必要な範囲だけを `memory_fetch` で読み直す。

## 導入価値と採用条件

導入価値:

- コンテキスト圧縮後でも、圧縮前の作業判断・会話断片・保存済み `agentic_search` answer を再確認できる。
- entity knowledge に昇格していない raw memory を、必要時だけ補助参照できる。
- `memory_search` で候補を絞り、`memory_fetch` で必要な範囲だけ読むため、全文投入より context 使用量を抑えられる。
- 過去の判断理由や「以前どう扱ったか」を確認でき、長いタスクや複数セッションをまたぐ作業の継続性が上がる。
- raw memory を直接 review 判断に混ぜず、参照したい時だけ確認するため、`review_task` の標準 retrieval を肥大化させずに済む。

採用条件:

- `memory_search` / `memory_fetch` は新 MCP tool として公開するが、位置づけは補助 tool とする。
- 通常の reusable knowledge 検索は引き続き `agentic_search` / `search_knowledge` を使う。
- context 圧縮後、summary だけでは足りない過去文脈の確認時に `memory_search` を使う。
- 候補一覧だけで判断せず、必要な場合だけ `memory_fetch` で部分読み込みする。
- `memory_search` / `memory_fetch` の結果は raw memory 由来なので、実装判断やレビュー判断では現在のファイル・entity knowledge・ユーザー指示と照合する。

非採用条件:

- 一般技術知識や現行仕様の確認を `memory_search` に任せる。
- `memory_search` を `agentic_search` の初回 prefetch に入れる。
- `review_task` の標準 retrieval に raw memory を自動注入する。
- raw memory を高信頼 knowledge と同列に扱う。
- まとめて大量取得し、context 圧縮回避のための tool が逆に context を圧迫する使い方をする。

## 実装前コードの前提

- `vibe_memories` の schema は [src/db/schema.ts](/Users/y.noguchi/Code/gnosis/src/db/schema.ts) にあり、主な列は `id`, `sessionId`, `content`, `embedding`, `metadata`, `referenceCount`, `lastReferencedAt`, `createdAt`, `memoryType`, `sourceTask`, `importance`, `compressed`。
- `src/services/memory.ts` には `saveMemory`, `saveMemoryWithOptions`, `searchMemoriesByType`, `searchMemory`, `listMemoriesByMetadata` がある。
- `searchMemoriesByType` は embedding がある場合は vector 検索、embedding が無い場合は full-text fallback を使うが、MCP 用の「vector と LIKE を並べて一覧表示する」契約ではない。
- Gnosis MCP 公開面は `src/mcp/tools/agentFirst.ts` と `src/mcp/tools/index.ts` で定義されている。公開 tool を増やす場合、`docs/mcp-tools.md`, `README.md`, `src/services/agenticSearch/publicSurface.ts`, `test/mcpToolsSnapshot.test.ts`, `test/mcpContract.test.ts` も同じ変更で更新する。
- `agentic_search` の内部 tool layer は `src/services/agenticSearch/toolRegistry.ts` にある。実装前は `knowledge_search`, `brave_search`, `fetch` の3つだけだったが、この実装で `memory_search`, `memory_fetch` を追加した。

## 追加する MCP Tool

共通方針:

- MCP handler は DB row をそのまま返さない。service が整形した DTO だけを `JSON.stringify(dto, null, 2)` した text として返す。
- `metadata`, `embedding`, raw `content` 全文、stack trace、内部 error object は返さない。
- 入力 schema の不正は既存 MCP handler と同じく zod parse error として `isError=true` に寄せる。
- DB/embedding など実行時の部分失敗は、可能なら `degraded` 付き DTO で返す。検索結果0件や embedding unavailable を MCP transport error にしない。

### 1. `memory_search`

Vibe Memory の一覧検索用 tool。Web 検索と同じく、候補 ID と短い snippet だけを返す。

入力:

```ts
{
  query: string;
  mode?: "hybrid" | "vector" | "like";
  limit?: number; // default 5, max 20
  sessionId?: string;
  memoryType?: "raw"; // MVP は raw のみ
  maxSnippetChars?: number; // default 240, max 1000
}
```

出力:

```ts
{
  items: Array<{
    id: string;
    sessionId: string;
    createdAt: string;
    source: "vector" | "like";
    matchSources: Array<"vector" | "like">;
    score: number;
    snippet: string;
  }>;
  retrieval: {
    query: string;
    mode: "hybrid" | "vector" | "like";
    vectorHitCount: number;
    likeHitCount: number;
    returnedCount: number;
    embeddingStatus: "used" | "unavailable" | "not_attempted";
  };
  degraded?: {
    code: string;
    message: string;
  };
}
```

返さないもの:

- `metadata` 全体
- `embedding`
- `content` 全文
- DB row の raw JSON

検索方式:

- `vector`: `generateEmbedding(query, { type: "query", priority: "high" })` で query vector を作り、`vibe_memories.embedding` との cosine similarity で検索する。
- query embedding は `memory_search` の責務として実装する。`saveMemory` 時の passage embedding とは分け、検索時は必ず `type: "query"` を指定する。
- `like`: `position(lower(query) in lower(content)) > 0` または `ILIKE` による文字列一致で検索する。ユーザー要望に合わせ、MVP では full-text search ではなく LIKE 系を明示的に使う。
- `hybrid`: vector と LIKE を両方実行し、同じ `id` を merge する。score が高い候補を優先し、同点では `createdAt` が新しいものを優先する。
- embedding 生成が失敗した場合、`hybrid` は LIKE のみで継続し、`retrieval.embeddingStatus = "unavailable"` と `degraded.code = "EMBEDDING_UNAVAILABLE"` を返す。
- `mode = "like"` の場合は embedding を生成しない。`retrieval.embeddingStatus = "not_attempted"` を返す。

ranking/merge:

- `candidateLimit = max(limit * 3, 10)` で vector / LIKE をそれぞれ取得し、merge 後に `limit` 件へ切る。
- 同一 `id` が vector と LIKE の両方で出た場合、`matchSources = ["vector", "like"]` とする。
- `source` は最高 score を出した retrieval source とする。同点なら `vector` を優先する。
- `score` は `0..1` に丸める。
  - vector score は cosine similarity をそのまま使う。
  - LIKE score は full query phrase match を `1.0` とし、MVP では token 単位の LIKE score は実装しない。
- sort は `score desc`, `matchSources.length desc`, `createdAt desc` の順にする。
- `snippet` は query phrase の最初の match 周辺から作る。LIKE match が無い vector-only 候補は先頭から `maxSnippetChars` を返す。

### 2. `memory_fetch`

`memory_search` で得た ID を指定し、該当 memory の必要部分だけを抽出して返す tool。Web の `fetch` と同じ2段目として使う。

入力:

```ts
{
  id: string;
  query?: string;
  start?: number; // 0-based character offset, inclusive
  end?: number; // 0-based character offset, exclusive
  maxChars?: number; // default 1000, max 5000
}
```

出力:

```ts
{
  id: string;
  sessionId: string;
  createdAt: string;
  range: {
    start: number;
    end: number;
    totalChars: number;
    source: "explicit_range" | "query_match" | "prefix_fallback";
  };
  excerpts: Array<{
    text: string;
    matched: boolean;
    start: number;
    end: number;
  }>;
  text: string;
  truncated: boolean;
  degraded?: {
    code: string;
    message: string;
  };
}
```

抽出ルール:

- `start` / `end` は `content` の文字オフセットとして扱う。JavaScript の `slice(start, end)` と同じく、`start` は含み、`end` は含まない。
- 文字オフセットは JavaScript string index とする。つまり UTF-16 code unit 基準であり、DB byte offset や token offset ではない。
- `start` / `end` の両方がある場合:
  - `content.slice(start, end)` を返す。
  - 範囲が本文端を超える場合は存在する範囲に丸める。
  - 範囲が `maxChars` を超える場合は `maxChars` に丸め、`truncated: true` とする。
  - `end <= start` または負数などの不正値は `degraded.code = "INVALID_RANGE"` として返す。
- `start` のみ指定された場合:
  - `start` から `start + maxChars` までを返す。
- `end` のみ指定された場合:
  - `max(0, end - maxChars)` から `end` までを返す。
- `start` / `end` が指定されていない場合:
  - `query` があれば、まず query 全体の phrase match を探す。
  - phrase match が無ければ、query を空白で token 化し、2文字以上の token の最初の match を探す。
  - match がある場合は、その match を中心に合計 `maxChars` 文字を返す。既定は1000文字。
  - match 範囲が本文端に近い場合は、存在する範囲に寄せて合計 `maxChars` 以内に収める。
  - `query` が無い、または一致が無い場合は、先頭1000文字を返しつつ `degraded.code = "NO_EXACT_EXCERPT_MATCH"` を付ける。
- fetch 成功時は `referenceCount` / `lastReferencedAt` を更新する。

優先順位:

1. `start` / `end` が1つでも指定されている場合は explicit range を優先し、`query` は match 判定に使わない。
2. `start` / `end` が無く `query` がある場合だけ query phrase/token の周辺抽出を行う。
3. `start` / `end` / `query` が無い場合は先頭1000文字を返す。

range validation:

- `start` / `end` / `maxChars` は整数だけを受け付ける。schema で `int().nonnegative()` と `max(5000)` を使う。
- `maxChars` の既定は1000、最大は5000。
- `start` が本文長以上の場合は `degraded.code = "RANGE_OUT_OF_BOUNDS"` を返し、`text` は空にする。
- `end` が本文長を超える場合は本文長へ丸める。
- `end <= start` は `INVALID_RANGE` として扱う。

例:

```ts
// 1200文字目から1800文字目までを明示的に読む
{ id: "memory-id", start: 1200, end: 1800 }

// 4000文字目から既定1000文字だけ読む
{ id: "memory-id", start: 4000 }

// "review_task timeout" の最初のヒット周辺を既定1000文字だけ読む
{ id: "memory-id", query: "review_task timeout" }
```

返さないもの:

- `metadata` 全体
- raw JSON
- `embedding`
- `referenceCount` などの運用内部値

## Agentic Search への接続方針

`agentic_search` の内部 tool layer にも `memory_search` / `memory_fetch` を追加する。ただし、初回 prefetch には入れない。

理由:

- Vibe Memory は生ログに近く、毎回 prefetch すると context が膨らむ。
- 通常の知識取得は引き続き `knowledge_search` が主導線。
- `memory_search` は「entity knowledge に無い過去会話や作業断片を確認したい」場合だけ使うべき。

System context の追加方針:

- `knowledge_search` は reusable knowledge / concept entity 用。
- `memory_search` は raw vibe memory 用。
- 過去会話、保存済み agentic answer、作業ログ断片、entity 化前の記録が必要な時だけ `memory_search` を使う。
- `memory_search` の snippet だけで不足する場合は `memory_fetch` で本文 excerpt を読む。
- `memory_fetch` 結果も raw JSON ではなく excerpt として扱う。

## 実装対象

### Service

新規ファイルを追加する。

- `src/services/vibeMemoryLookup.ts`

責務:

- `searchVibeMemories(input)`
- `fetchVibeMemory(input)`
- `memory_search` query の embedding 生成
- snippet/excerpt 整形
- vector/LIKE merge
- raw metadata を返さない DTO 変換

`src/services/memory.ts` に全てを詰め込むと既存保存・embedding 関数がさらに肥大化するため、MCP 用 lookup は別 service に分ける。

想定 interface:

```ts
export type VibeMemorySearchMode = "hybrid" | "vector" | "like";

export type SearchVibeMemoriesInput = {
  query: string;
  mode?: VibeMemorySearchMode;
  limit?: number;
  sessionId?: string;
  memoryType?: "raw";
  maxSnippetChars?: number;
  database?: VibeMemoryLookupDb;
  generateQueryEmbedding?: typeof generateEmbedding;
};

export type FetchVibeMemoryInput = {
  id: string;
  query?: string;
  start?: number;
  end?: number;
  maxChars?: number;
  database?: VibeMemoryLookupDb;
};
```

`VibeMemoryLookupDb` は service test で mock しやすいように、最初は `Pick<typeof db, "select" | "update">` に限定する。

SQL sketch:

```ts
// vector
const similarity = sql<number>`1 - (${vibeMemories.embedding} <=> ${embeddingStr}::vector)`;

// like
sql`position(lower(${query}) in lower(${vibeMemories.content})) > 0`;

// fetch by id
eq(vibeMemories.id, id);
```

### MCP

更新する。

- `src/mcp/tools/agentFirst.ts`
  - `memorySearchSchema`
  - `memoryFetchSchema`
  - handler 追加
  - `initial_instructions` に補助用途を明記する。
- `src/mcp/tools/index.ts`
  - public MCP tool として `memory_search`, `memory_fetch` を追加
- `src/services/agenticSearch/publicSurface.ts`
  - public surface を6件から8件へ更新
- `docs/mcp-tools.md`
  - tool 一覧、仕様、doctor 期待値を更新
- `README.md`
  - primary tools の説明を更新

`initial_instructions` への追記方針:

```md
- memory_search / memory_fetch: context 圧縮後に過去の会話・作業履歴・保存済み回答の詳細を確認する補助ツール。
  - まず agentic_search / search_knowledge / review_task の主導線で足りるか確認する。
  - 圧縮 summary だけでは不足する時だけ memory_search で候補を探す。
  - 詳細が必要な候補だけ memory_fetch で部分読み込みする。
  - raw memory は補助参照であり、現在のファイル・ユーザー指示・entity knowledge と照合して使う。
```

MCP 公開面の整理:

- 実装後の Gnosis public surface は `initial_instructions`, `agentic_search`, `search_knowledge`, `record_task_note`, `review_task`, `doctor`, `memory_search`, `memory_fetch` の8件とする。
- ただし、主要導線は引き続き `agentic_search` / `review_task` / `search_knowledge` / `record_task_note` であり、`memory_search` / `memory_fetch` は context 圧縮回避・過去文脈確認の補助導線として説明する。
- `doctor` の `exposedToolCount`、MCP contract、snapshot、README、`docs/mcp-tools.md` は8件に合わせて更新する。

### Agentic Search Tool Layer

更新する。

- `src/services/agenticSearch/types.ts`
  - `AgenticSearchToolName` に `memory_search`, `memory_fetch` を追加
- `src/services/agenticSearch/toolRegistry.ts`
  - schema と executor を追加
- `src/services/agenticSearch/tools/memorySearch.ts`
  - `searchVibeMemories` の薄い wrapper を追加
- `src/services/agenticSearch/tools/memoryFetch.ts`
  - `fetchVibeMemory` の薄い wrapper を追加
- `src/services/agenticSearch/toolContext.ts`
  - follow-up instruction を追加
- `src/services/agenticSearch/systemContext.ts`
  - raw memory と entity knowledge の使い分けを短く追記
- `src/services/agenticSearch/runner.ts`
  - tool name guard と casts を union 対応
  - 初回 prefetch は現行の `knowledge_search` + `brave_search` のまま維持

runner 実装時の注意:

- `isAgenticSearchToolName` は literal を手で列挙し続けず、`Set<AgenticSearchToolName>` などで1箇所管理に寄せる。
- `executeTool` 内の casts は `AgenticSearchToolName` へ寄せ、`'knowledge_search' | 'brave_search' | 'fetch'` の局所 union を残さない。
- fallback answer は引き続き `knowledge_search` 結果だけを使う。`memory_search` の raw memory は fallback answer へ自動注入しない。

## 非ゴール

- `vibe_memories.metadata` の raw JSON を MCP へ返さない。
- query DSL、複雑な filters、cursor pagination は追加しない。
- memory fetch で LLM 要約はしない。MVP は deterministic excerpt のみ。
- byte range / token range / chunk index は追加しない。部分読み込みは JavaScript string index の `start` / `end` のみ。
- query embedding の短期 cache は追加しない。まずは検索ごとに embedding を生成し、性能問題が実測されたら別計画で扱う。
- `memory_search` を `agentic_search` の初回 prefetch に入れない。
- entity knowledge と vibe memory を同じ tool に混ぜない。`search_knowledge` は entity、`memory_search` は vibe memory と分ける。
- retired startup/task lifecycle tools は復活させない。

## テスト計画

追加・更新するテスト:

- `test/vibeMemoryLookup.test.ts`
  - `memory_search` の `vector` mode が `generateEmbedding(query, { type: "query", priority: "high" })` を呼ぶ。
  - `memory_search` の `like` mode が embedding を生成せず、`embeddingStatus = "not_attempted"` を返す。
  - `memory_search` が `limit` / `maxSnippetChars` を clamp する。
  - `memory_search` が vector と LIKE の同一 ID を `matchSources` 付きで merge する。
  - `memory_search` が vector-only 候補の snippet を先頭から作る。
  - vector 検索結果が snippet DTO として返る。
  - LIKE 検索結果が snippet DTO として返る。
  - hybrid が同一 ID を merge する。
  - embedding 失敗時に LIKE で degraded 継続する。
  - `metadata` / `embedding` / raw `content` 全文が search 出力に漏れない。
  - `memory_fetch` が `start` / `end` の明示範囲だけを返す。
  - `memory_fetch` が `start` のみ指定時に `start + maxChars` まで返す。
  - `memory_fetch` が `end` のみ指定時に `end - maxChars` から返す。
  - `memory_fetch` が範囲未指定時に query phrase の最初のヒット周辺1000文字を返す。
  - `memory_fetch` が phrase 不一致時に token match 周辺1000文字へ fallback する。
  - `memory_fetch` が query ありでも `start` / `end` 指定を優先する。
  - `memory_fetch` が `maxChars` を守る。
  - `memory_fetch` が不正 range を `degraded.code = "INVALID_RANGE"` として返す。
  - `memory_fetch` が本文長外の start を `RANGE_OUT_OF_BOUNDS` として返す。
  - `memory_fetch` が `referenceCount` / `lastReferencedAt` を更新する。
  - not found を `degraded.code = "MEMORY_NOT_FOUND"` として返す。
- `test/mcp/tools/agentFirst.test.ts`
  - `memory_search` handler が service 結果を返す。
  - `memory_fetch` handler が service 結果を返す。
  - raw JSON を返さない代表 assertion を入れる。
  - schema が `limit <= 20`, `maxSnippetChars <= 1000`, `maxChars <= 5000`, `start/end >= 0` を拒否できることを確認する。
- `test/agenticSearch/toolRegistry.test.ts`
  - tool names を `knowledge_search`, `brave_search`, `fetch`, `memory_search`, `memory_fetch` に更新。
  - schema required fields を確認。
  - executor routing を確認。
- `test/agenticSearch/runner.test.ts`
  - 初回 prefetch に `memory_search` が含まれないことを確認。
  - LLM が `memory_search` を要求した場合だけ executor が呼ばれることを確認。
  - LLM が `memory_fetch` を要求した場合だけ executor が呼ばれることを確認。
  - `memory_search` 結果が fallback answer へ自動混入しないことを確認。
- `test/mcpContract.test.ts`
  - public tool list に `memory_search`, `memory_fetch` が含まれることを確認。
- `test/mcpToolsSnapshot.test.ts`
  - schema hash を更新。

## 受け入れ条件

- MCP `tools/list` に `memory_search` と `memory_fetch` が追加される。
- `memory_search` の vector/hybrid 検索は query を `type: "query"` の embedding に変換してから `vibe_memories.embedding` と照合する。
- `memory_search` の LIKE-only 検索は embedding を生成しない。
- `memory_search` は vector / LIKE / hybrid で候補一覧を返せる。
- `memory_search` は vector/LIKE の重複候補を `matchSources` にまとめ、同一 memory を重複表示しない。
- `memory_search` の返却は `id`, `sessionId`, `createdAt`, `source`, `score`, `snippet` などの薄い情報だけで、raw JSON を含まない。
- `memory_fetch` は `id` から memory を読み、`start` / `end` がある場合は指定文字範囲だけを返す。
- `memory_fetch` は `start` / `end` が無く `query` がある場合、ヒットした語句・フレーズ周辺1000文字を返す。
- `memory_fetch` は `start` / `end` / `query` がいずれも無い場合、先頭1000文字だけを返す。
- `memory_fetch` は `metadata`, `embedding`, raw DB row を返さない。
- MCP handler と agentic_search tool layer はどちらも同じ `searchVibeMemories` / `fetchVibeMemory` service を使い、契約が二重化しない。
- `agentic_search` は必要時に `memory_search` / `memory_fetch` を tool call できる。
- `agentic_search` の初回 prefetch は現行どおり `knowledge_search` + `brave_search` のみ。
- `doctor` / MCP contract / snapshot が新しい public surface と整合している。

## 実装順

1. `src/services/vibeMemoryLookup.ts` を追加し、service 単体テストを通す。
2. `src/mcp/tools/agentFirst.ts` に `memory_search` / `memory_fetch` schema と handler を追加する。
3. `src/mcp/tools/index.ts` で public surface に追加し、MCP contract/snapshot を更新する。
4. `src/services/agenticSearch/*` に tool registry 接続を追加する。ただし prefetch は変更しない。
5. `docs/mcp-tools.md`, `README.md`, `publicSurface.ts` の公開面説明を更新する。
6. focused tests を実行する。
7. `bun run typecheck`, `bun run lint`, `bun run verify:fast` を実行する。

## 検証コマンド

```bash
bun test test/vibeMemoryLookup.test.ts
bun test test/mcp/tools/agentFirst.test.ts test/mcpContract.test.ts test/mcpToolsSnapshot.test.ts
bun test test/agenticSearch/toolRegistry.test.ts test/agenticSearch/runner.test.ts
bun run typecheck
bun run lint
bun run verify:fast
```
