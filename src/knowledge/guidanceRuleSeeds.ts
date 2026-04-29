// Auto-generated from the local Gnosis guidance database.
// Generated on 2026-04-29. Re-apply with scripts/seed-guidance-rules.ts.

export type GuidanceRuleSeed = {
  title: string;
  content: string;
  guidanceType: 'rule';
  scope: 'always' | 'on_demand';
  priority: number;
  tags: string[];
  category?: string;
  appliesWhen?: {
    intents?: Array<'plan' | 'edit' | 'debug' | 'review' | 'finish'>;
    changeTypes?: string[];
    fileGlobs?: string[];
    technologies?: string[];
    keywords?: string[];
    severity?: 'blocking' | 'required' | 'advisory';
  };
  archiveKey?: string;
  sourceIds?: {
    vibeMemoryId?: string;
    entityId?: string;
  };
};

export const GUIDANCE_RULE_SEEDS = [
  {
    title: '.envファイル変更はユーザー許可なく禁止',
    content: '.envファイル変更はユーザー許可なく禁止',
    guidanceType: 'rule',
    scope: 'always',
    priority: 100,
    tags: ['nipro-template', 'coding-rule'],
    category: 'coding_convention',
    appliesWhen: {
      severity: 'blocking',
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/.envファイル変更はユーザー許可なく禁止',
    },
  },
  {
    title: 'pnpm build/test実行 / ESLint/型チェック実行',
    content:
      '### コードレビュー\n\n**📋 コード変更時の必須チェック**:\n- pnpm build/test実行\n- ESLint/型チェック実行\n- 可読性・設計・重複・性能チェック\n- 既存共通部品利用優先\n\n**📝 ドキュメント編集のみの場合**:\n- **.mdファイルのみ編集**: ビルド・Lintチェック**不要**\n- **コード変更を含む場合**: ビルド・Lintチェック**必須**',
    guidanceType: 'rule',
    scope: 'always',
    priority: 100,
    tags: ['nipro-template', 'technology', 'tooling', 'eslint', 'typescript', 'javascript'],
    category: 'testing',
    appliesWhen: {
      severity: 'required',
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/pnpm-build/test実行-/-eslint/型チェック実行',
    },
  },
  {
    title: 'verifyコマンドを作り、品質チェック時に実施すること',
    content:
      'tsc —noEmit\neslint . —max-warnings=0\nPrettier —check .\nvutest run\n\nBiome 時\nbiome check .  —write\ntsc —noEmit\nvitest run \ntsup\nvite build \nなどを含んだコマンドを作る事。　タスクが終わり次第このコマンドを実施し、品質に問題がないか確認すること',
    guidanceType: 'rule',
    scope: 'always',
    priority: 100,
    tags: ['Typescript'],
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'constraint/verifyコマンドを作り、品質チェック時に実施すること',
    },
  },
  {
    title: 'サーバー独自起動禁止 / 認証バイパス実装禁止',
    content:
      '### 必須事項\n\n- サーバー独自起動禁止\n- 認証バイパス実装禁止\n- useRef・useEffect無限ループ防止\n- **Git操作は明示的なユーザー指示なしには絶対禁止（git add, git commit, git push等）**\n- コミット・PR作成前ユーザー確認必須\n- **API mutation作成時はuseQueryClient+invalidateQueries必須（UI更新されない原因）**',
    guidanceType: 'rule',
    scope: 'always',
    priority: 100,
    tags: ['nipro-template', 'technology', 'frontend', 'react', 'tanstack-query', 'typescript'],
    category: 'security',
    appliesWhen: {
      severity: 'blocking',
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/サーバー独自起動禁止-/-認証バイパス実装禁止',
    },
  },
  {
    title: 'KISS + YAGNI: シンプル優先、未確定機能作成禁止 / DRY: 重複コード共通化',
    content:
      '## 🏛️ 設計原則\n- **DRY**: 重複コード共通化\n- **KISS + YAGNI**: シンプル優先、未確定機能作成禁止\n- **単一責任・関心分離**: 1コンポーネント1責務。UI・ロジック・データ取得分離\n- **依存性逆転**: 具象(`fetch`)でなく抽象(`useApiClient`)依存\n- **合成 > 継承**: コンポーネントは合成(Composition)\n- **最小驚愕**: 直感的な命名と振る舞い',
    guidanceType: 'rule',
    scope: 'always',
    priority: 80,
    tags: ['technology', 'frontend', 'react'],
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/kiss-+-yagni:-シンプル優先、未確定機能作成禁止-/-dry:-重複コード共通化',
    },
    category: 'architecture',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'react',
        'kiss + yagni: シンプル優先、未確定機能作成禁止 / dry: 重複コード共通化',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'api', 'refactor'],
      technologies: ['react'],
    },
  },
  {
    title: '600行超過ファイルは分割検討',
    content: '600行超過ファイルは分割検討',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'coding-rule'],
    category: 'architecture',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['nipro-template', 'coding-rule', '600行超過ファイルは分割検討'],
      severity: 'required',
      fileGlobs: [],
      changeTypes: ['refactor'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/600行超過ファイルは分割検討',
    },
  },
  {
    title: 'API仕様・バックエンド - Zod検証必須、エラーは400返却 / JSDoc記述、OpenAPI自動生成',
    content:
      '### API仕様・バックエンド\n\n- Zod検証必須、エラーは400返却\n- 統一エラーフォーマット: {"status":"error","message":string,"code":string,"details":any?}\n- JSDoc記述、OpenAPI自動生成\n- MSAL保護\n- リクエストサニタイズ実施\n- レートリミット: 同一ユーザー秒間50回制限',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: [
      'nipro-template',
      'technology',
      'language',
      'typescript',
      'validation',
      'zod',
      'cloud',
      'azure',
      'auth',
      'msal',
    ],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'language',
        'typescript',
        'validation',
        'zod',
        'cloud',
        'azure',
        'auth',
        'msal',
        'api仕様・バックエンド - zod検証必須、エラーは400返却 / jsdoc記述、openapi自動生成',
      ],
      severity: 'required',
      fileGlobs: ['src/**/routes/**'],
      changeTypes: ['api', 'auth'],
      technologies: ['typescript', 'zod'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/api仕様・バックエンド---zod検証必須、エラーは400返却-/-jsdoc記述、openapi自動生成',
    },
  },
  {
    title:
      'API実装・通信 - src/lib/api（統合APIクライアント）使用 / src/lib/websocket（統合クライアント）使用',
    content:
      '### API実装・通信\n\n- src/lib/api（統合APIクライアント）使用\n- src/lib/websocket（統合クライアント）使用\n- TanStack Query必須: 状態管理簡略化、ローディング・エラー自動管理、リトライ、キャッシュ管理\n- React Context + useState/useReducerのみ',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'technology', 'frontend', 'react', 'tanstack-query', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'frontend',
        'react',
        'tanstack-query',
        'typescript',
        'api実装・通信 - src/lib/api（統合apiクライアント）使用 / src/lib/websocket（統合クライアント）使用',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'api'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/api実装・通信---src/lib/api（統合apiクライアント）使用-/-src/lib/websocket（統合クライアント）使用',
    },
  },
  {
    title:
      'backend/issues/配下のファイル直接編集許可 - 開発前必須作成、95%実現目標でセルフレビュー実施 / 各チケット（P-0001等）につき3つのファイル：',
    content:
      '#### **backend/issues/配下のファイル直接編集許可**\n\n各チケット（P-0001等）につき3つのファイル：\n\n1. **P-0001.md** - **基本チケット情報と詳細仕様書**\n   - 機能概要、現状分析、要求仕様、技術仕様、実装フェーズ等\n   - 開発者向けの包括的な技術文書・実装ガイド\n   - 開発前必須作成、95%実現目標でセルフレビュー実施\n   - 期間や、コスト見積もりは一切不要、実装用の仕様のみ記載すること\n\n2. **P-0001-complete.md** - **実装完了報告書（必須作成ルール）**\n\n**📋 作成必須条件:**\n   - 完了報告であること（過去形で記述）\n   - 実際の実装を調査して作成すること（推測禁止）\n   - 設計書としての構成であること（単なるコードコピー禁止）\n   - 実現可能性100％のドキュメントであること（既実装済み前提）\n   - 自然言語での詳細説明を含むこと（コードのみ禁止）\n\n**📁 必須記載内容:**\n   - **システムアーキテクチャ**: 設計思想、全体構成図、技術選択理由\n   - **完全実装ガイド**: 環境準備、コード詳細解説\n\n**🎯 品質基準:**\n   - **技術精度**: 100%実装済み内容のみ記載、推測・仮定禁止\n   - **再現性保証**: 記載手順で完全に再実装可能な詳細度\n   - **実用性重視**: 開発者が実際に参照できる実践的内容\n\n3. **P-0001-spec.md** - **一般人向け仕様書**  \n   - 非技術者でも理解できる機能説明・ビジネス価値中心\n   - 自然言語構成、技術詳細は最小限\n   - ステークホルダー・承認者向け説明資料\n\n4. **ドキュメント完成後** ドキュメントレビューを行い、足りない記述が無い様に改善する事',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'workflow',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'backend/issues/配下のファイル直接編集許可 - 開発前必須作成、95%実現目標でセルフレビュー実施 / 各チケット（p-0001等）につき3つのファイル：',
      ],
      severity: 'required',
      fileGlobs: ['src/services/**', 'docs/**'],
      changeTypes: ['backend', 'docs', 'review'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/backend/issues/配下のファイル直接編集許可---開発前必須作成、95%実現目標でセルフレビュー実施-/-各チケット（p-0001等）につき3つのファイル：',
    },
  },
  {
    title: 'ESLint警告・エラーは解消',
    content: 'ESLint警告・エラーは解消',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: [
      'nipro-template',
      'coding-rule',
      'technology',
      'tooling',
      'eslint',
      'typescript',
      'javascript',
    ],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'coding-rule',
        'technology',
        'tooling',
        'eslint',
        'typescript',
        'javascript',
        'eslint警告・エラーは解消',
      ],
      severity: 'required',
      fileGlobs: ['*.json', '*.toml'],
      changeTypes: ['config', 'build'],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/eslint警告・エラーは解消',
    },
  },
  {
    title: 'if文の巨大化等、結果が多様になりすぎる実装を避ける (ユニットテストの複雑化の抑制)',
    content: 'if文の巨大化等、結果が多様になりすぎる実装を避ける (ユニットテストの複雑化の抑制)',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'coding-rule'],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'coding-rule',
        'if文の巨大化等、結果が多様になりすぎる実装を避ける (ユニットテストの複雑化の抑制)',
      ],
      severity: 'required',
      fileGlobs: ['test/**'],
      changeTypes: ['test', 'refactor'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/if文の巨大化等、結果が多様になりすぎる実装を避ける-(ユニットテストの複雑化の抑制)',
    },
  },
  {
    title: 'Kanban仕様分割時にMCP todo使用 / チケット番号（P-00xx）必須記載',
    content:
      '### Todo管理\n\n- Kanban仕様分割時にMCP todo使用\n- チケット番号（P-00xx）必須記載\n- 作業中断時の再開ポイント\n- Kanbanクローズ時は物理削除\n- 形式: { content: "[P-0001] タスク内容", status: "pending|in_progress|completed" }',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'mcp',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'kanban仕様分割時にmcp todo使用 / チケット番号（p-00xx）必須記載',
      ],
      severity: 'required',
      fileGlobs: ['src/mcp/**'],
      changeTypes: ['mcp'],
      technologies: ['mcp'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/kanban仕様分割時にmcp-todo使用-/-チケット番号（p-00xx）必須記載',
    },
  },
  {
    title: 'MCP Server統合設定・利用可能ツール: mcp-config-update.json参照',
    content:
      '### 設定・機能一覧\n\n**📋 MCP Server統合設定・利用可能ツール**: `mcp-config-update.json`参照\n\n- 統合サーバー設定（Wiki・Kanban・Todo全機能）\n- 全ツール・リソース一覧\n- Claude Desktop等のMCPクライアント設定用',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'mcp',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'mcp server統合設定・利用可能ツール: mcp-config-update.json参照',
      ],
      severity: 'required',
      fileGlobs: ['src/mcp/**', '*.json', '*.toml'],
      changeTypes: ['mcp', 'config'],
      technologies: ['mcp'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/mcp-server統合設定・利用可能ツール:-mcp-config-update.json参照',
    },
  },
  {
    title: 'MonoRepo構成とfrontend/backend開発ポート',
    content:
      '## 事前知識\n\n- このプロジェクトはMonoRepoプロジェクトです。frontend,backendともにtypescriptで書かれています\n- frontendはpnpm run devで起動されたサーバーは 8000番ポートが使われます\n- backendはpnpm run devで起動されたサーバーは 3003番ポートが使われます',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'technology', 'language', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'language',
        'typescript',
        'monorepo構成とfrontend/backend開発ポート',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/services/**'],
      changeTypes: ['frontend', 'backend', 'build'],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/monorepo構成とfrontend/backend開発ポート',
    },
  },
  {
    title:
      'React Query Mutation 必須手順（絶対厳守） - useQueryClientをimport / queryClient.invalidateQueries()をonSuc…',
    content:
      "### ⚡ React Query Mutation 必須手順（絶対厳守）\n\n**新規mutation実装時、以下を必ず全て実行:**\n\n1. `useQueryClient`をimport\n2. `queryClient.invalidateQueries()`をonSuccessに追加\n3. 手動状態更新（setState等）は削除してキャッシュ依存\n\n**例:**\n\n```typescript\nexport const useUpdateSomething = () => {\n  const apiClient = useApiClient();\n  const queryClient = useQueryClient(); \n  \n  return useApiMutation<Result, Params>(\n    async (params) => apiClient.put(...),\n    {\n      onSuccess: (_, params) => {\n        queryClient.invalidateQueries({ queryKey: ['something', params.id] });\n        queryClient.invalidateQueries({ queryKey: ['somethings'] });\n      }\n    }\n  );\n};\n```",
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: [
      'nipro-template',
      'technology',
      'language',
      'typescript',
      'frontend',
      'react',
      'tanstack-query',
    ],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'language',
        'typescript',
        'frontend',
        'react',
        'tanstack-query',
        'react query mutation 必須手順（絶対厳守） - usequeryclientをimport / queryclient.invalidatequeries()をonsuc…',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'api'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/react-query-mutation-必須手順（絶対厳守）---usequeryclientをimport-/-queryclient.invalidatequeries()をonsuc…',
    },
  },
  {
    title: 'インターフェース名はIプレフィックス',
    content: 'インターフェース名はIプレフィックス',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'coding-rule'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['nipro-template', 'coding-rule', 'インターフェース名はiプレフィックス'],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/インターフェース名はiプレフィックス',
    },
  },
  {
    title: 'キー→ID変換: curl GET /api/kanban/tickets/key/P-0001',
    content:
      '### 運用上の注意点\n\n- **ticketId形式**: UUID（P-0001形式ではない）\n- **キー→ID変換**: `curl GET /api/kanban/tickets/key/P-0001`\n- **ステータス**: TODO/IN_PROGRESS/DONE/CLOSED\n- **トークンリミット**: 25000上限\n- **長大チケット**: Read()で部分読み推奨\n\nこの統一ルールを主要ガイドラインとして運用する。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['nipro-template', 'キー→id変換: curl get /api/kanban/tickets/key/p-0001'],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'api'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/キー→id変換:-curl-get-/api/kanban/tickets/key/p-0001',
    },
  },
  {
    title: 'ドキュメントは日本語、コードは英語（識別子・コメント・ログ）',
    content: 'ドキュメントは日本語、コードは英語（識別子・コメント・ログ）',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'coding-rule'],
    category: 'workflow',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'coding-rule',
        'ドキュメントは日本語、コードは英語（識別子・コメント・ログ）',
      ],
      severity: 'required',
      fileGlobs: ['docs/**'],
      changeTypes: ['docs'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/ドキュメントは日本語、コードは英語（識別子・コメント・ログ）',
    },
  },
  {
    title:
      "バックエンド DI（tsyringe）必須 - @injectable()デコレーター必須 / import { injectable, inject } from 'tsyringe';",
    content:
      "### バックエンド DI（tsyringe）必須\n\n**全Service/Repository/Controllerクラス:**\n\n```typescript\nimport { injectable, inject } from 'tsyringe';\n\n@injectable()\nexport class TicketService {\n  constructor(\n    @inject(TicketRepository) private repo: TicketRepository,\n    @inject('Logger') private logger: any\n  ) {}\n}\n\n// routes.ts\nconst controller = container.resolve(TicketController);\n```\n\n**ルール:**\n- ✅ `@injectable()`デコレーター必須\n- ✅ コンストラクタ注入のみ（`@inject()`）\n- ✅ `container.resolve()`でインスタンス取得\n- ❌ `new Class()`禁止（Date/Error/Map/Set/RegExp/URL除く）\n- ❌ プロパティ注入禁止\n\n**テスト:**\n```typescript\nbeforeEach(() => container.registerInstance(Repo, mock));\nafterEach(() => container.clearInstances()); // 必須\n```\n\n**詳細**: `di_plan.md`",
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'technology', 'language', 'typescript'],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'language',
        'typescript',
        "バックエンド di（tsyringe）必須 - @injectable()デコレーター必須 / import { injectable, inject } from 'tsyringe';",
      ],
      severity: 'required',
      fileGlobs: ['src/services/**', 'src/**/routes/**', 'docs/**', 'test/**'],
      changeTypes: ['backend', 'api', 'docs', 'test'],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        "rule/バックエンド-di（tsyringe）必須---@injectable()デコレーター必須-/-import-{-injectable,-inject-}-from-'tsyringe';",
    },
  },
  {
    title: 'バックエンドテスト - Vitest使用 / 実DB直接書込禁止、モックまたはテストDB使用',
    content:
      '#### バックエンドテスト\n\n- Vitest使用\n- 実DB直接書込禁止、モックまたはテストDB使用\n- 認証・バリデーション・ビジネスロジック優先',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'technology', 'testing', 'vitest', 'typescript', 'javascript'],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'testing',
        'vitest',
        'typescript',
        'javascript',
        'バックエンドテスト - vitest使用 / 実db直接書込禁止、モックまたはテストdb使用',
      ],
      severity: 'required',
      fileGlobs: ['drizzle/**', 'test/**'],
      changeTypes: ['auth', 'db', 'test'],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/バックエンドテスト---vitest使用-/-実db直接書込禁止、モックまたはテストdb使用',
    },
  },
  {
    title:
      'バックエンド固有 - MSAL認証のみ、認証バイパス絶対禁止 / ローカル・Azure環境の動作切り替え実装必須',
    content:
      '### バックエンド固有\n\n- MSAL認証のみ、認証バイパス絶対禁止\n- ローカル・Azure環境の動作切り替え実装必須',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'technology', 'cloud', 'azure', 'auth', 'msal'],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'cloud',
        'azure',
        'auth',
        'msal',
        'バックエンド固有 - msal認証のみ、認証バイパス絶対禁止 / ローカル・azure環境の動作切り替え実装必須',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: ['auth'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/バックエンド固有---msal認証のみ、認証バイパス絶対禁止-/-ローカル・azure環境の動作切り替え実装必須',
    },
  },
  {
    title:
      'フロントエンドテスト - Vitest + @testing-library/react / テスト品質: 通すだけのテスト禁止、過度なMock禁止、実用性重視',
    content:
      '#### フロントエンドテスト\n\n- Vitest + @testing-library/react\n- テスト品質: 通すだけのテスト禁止、過度なMock禁止、実用性重視\n- UI全コンポーネントにid付与、data-testid禁止\n- ARIA属性・アクセシビリティ遵守',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: [
      'nipro-template',
      'technology',
      'frontend',
      'react',
      'testing',
      'vitest',
      'typescript',
      'javascript',
      'testing-library',
    ],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'frontend',
        'react',
        'testing',
        'vitest',
        'typescript',
        'javascript',
        'testing-library',
        'フロントエンドテスト - vitest + @testing-library/react / テスト品質: 通すだけのテスト禁止、過度なmock禁止、実用性重視',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'test/**'],
      changeTypes: ['frontend', 'test'],
      technologies: ['typescript', 'react'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/フロントエンドテスト---vitest-+-@testing-library/react-/-テスト品質:-通すだけのテスト禁止、過度なmock禁止、実用性重視',
    },
  },
  {
    title:
      'フロントエンド固有 - React Contextのみ使用（外部状態管理ライブラリ禁止） / react-hook-formでフォーム実装',
    content:
      '### フロントエンド固有\n\n- React Contextのみ使用（外部状態管理ライブラリ禁止）\n- react-hook-formでフォーム実装\n- i18nextで多言語化、ハードコード文字列禁止\n- fetch/axios/Socket.IO直接利用禁止\n- useRef・useEffect無限ループリスク完全防止',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'technology', 'frontend', 'react', 'i18next', 'i18n'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'technology',
        'frontend',
        'react',
        'i18next',
        'i18n',
        'フロントエンド固有 - react contextのみ使用（外部状態管理ライブラリ禁止） / react-hook-formでフォーム実装',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'api'],
      technologies: ['react', 'i18next'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/フロントエンド固有---react-contextのみ使用（外部状態管理ライブラリ禁止）-/-react-hook-formでフォーム実装',
    },
  },
  {
    title: '共通テスト設定 - Test/配置、pnpm test実行、pnpm test:coverage',
    content: '#### 共通テスト設定\n\n- Test/配置、pnpm test実行、pnpm test:coverage',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['nipro-template', '共通テスト設定 - test/配置、pnpm test実行、pnpm test:coverage'],
      severity: 'required',
      fileGlobs: ['test/**', '*.json', '*.toml'],
      changeTypes: ['test', 'config', 'build'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/共通テスト設定---test/配置、pnpm-test実行、pnpm-test:coverage',
    },
  },
  {
    title: '共通部品 - LIBINFO.md確認後、既存部品再利用 / 新規部品はLIBINFO.md登録必須',
    content: '### 共通部品\n\n- LIBINFO.md確認後、既存部品再利用\n- 新規部品はLIBINFO.md登録必須',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'workflow',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        '共通部品 - libinfo.md確認後、既存部品再利用 / 新規部品はlibinfo.md登録必須',
      ],
      severity: 'required',
      fileGlobs: ['docs/**'],
      changeTypes: ['docs'],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/共通部品---libinfo.md確認後、既存部品再利用-/-新規部品はlibinfo.md登録必須',
    },
  },
  {
    title:
      '直接ファイル編集: Read/Write/Edit tools使用可能 / MCP併用: mcp__kanban__* toolsとの併用推奨',
    content:
      '#### 編集ルール\n\n- **直接ファイル編集**: Read/Write/Edit tools使用可能\n- **MCP併用**: mcp__kanban__* toolsとの併用推奨  \n- **同期**: ファイル更新後、必要に応じてMCP経由でKanbanにも反映',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'mcp',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        '直接ファイル編集: read/write/edit tools使用可能 / mcp併用: mcp__kanban__* toolsとの併用推奨',
      ],
      severity: 'required',
      fileGlobs: ['src/mcp/**'],
      changeTypes: ['mcp'],
      technologies: ['mcp'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/直接ファイル編集:-read/write/edit-tools使用可能-/-mcp併用:-mcp__kanban__*-toolsとの併用推奨',
    },
  },
  {
    title: '自動チケット管理 - エラー報告時: mcp__kanban__add_commentで記録、IN_PROGRESSに変更',
    content:
      '### 自動チケット管理\n\n- エラー報告時: mcp__kanban__add_commentで記録、IN_PROGRESSに変更\n- 完了報告時: 完了コメント＋DONE\n- 新タスク: 新チケット作成または既存更新\n- 作業チケット指定: 「P-0001を作業中です」',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template'],
    category: 'mcp',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        '自動チケット管理 - エラー報告時: mcp__kanban__add_commentで記録、in_progressに変更',
      ],
      severity: 'required',
      fileGlobs: ['src/mcp/**'],
      changeTypes: ['mcp'],
      technologies: ['mcp'],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId:
        'rule/自動チケット管理---エラー報告時:-mcp__kanban__add_commentで記録、in_progressに変更',
    },
  },
  {
    title: '複合コマンド（&&）の乱用禁止、個別コマンドで実行',
    content: '複合コマンド（&&）の乱用禁止、個別コマンドで実行',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 90,
    tags: ['nipro-template', 'coding-rule'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'nipro-template',
        'coding-rule',
        '複合コマンド（&&）の乱用禁止、個別コマンドで実行',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    archiveKey: 'archive:content:c4dfbc77c76ec48a6b90a9070c4834681f1feb0cfc0d2d8578ca4853e5cf0636',
    sourceIds: {
      entityId: 'rule/複合コマンド（&&）の乱用禁止、個別コマンドで実行',
    },
  },
  {
    title: 'any禁止とunknown利用',
    content:
      'any禁止とunknown利用: TypeScript strict を前提に any を避け、適切な型定義または unknown を使う。\n- TypeScript strict有効、any禁止、適切な型またはunknownを使用: TypeScript strict有効、any禁止、適切な型またはunknownを使用\n- any禁止: 適切な型定義かunknown使用: any禁止: 適切な型定義かunknown使用',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['typescript', 'typing', 'coding-rule', 'technology', 'language'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'typescript',
        'typing',
        'coding-rule',
        'technology',
        'language',
        'any禁止とunknown利用',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: ['typescript'],
    },
    sourceIds: {
      entityId: 'rule/any禁止とunknown利用',
    },
  },
  {
    title: 'API mount のドメインprefix固定ルール',
    content:
      '新規ドメインのAPIは原則 /api/<domain> 配下で公開する。/api/* 直下への汎用的なマウントは、既存のルートとの干渉を避けるために禁止する。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['routing', 'api_design'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['routing', 'api_design', 'api mount のドメインprefix固定ルール'],
      severity: 'required',
      fileGlobs: ['src/**/routes/**'],
      changeTypes: ['api'],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/api-mount-のドメインprefix固定ルール-1777368444618',
    },
  },
  {
    title: 'Apply系APIの副作用完了保証ルール',
    content:
      "状態を 'applied' に遷移させる前に、必ず反映先（外部リソース等）の更新が完了していることを保証する。非対応の target の場合は ValidationError を返す。",
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['consistency', 'transactional_integrity'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['consistency', 'transactional_integrity', 'apply系apiの副作用完了保証ルール'],
      severity: 'required',
      fileGlobs: ['src/**/routes/**'],
      changeTypes: ['api'],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/apply系apiの副作用完了保証ルール-1777368444614',
    },
  },
  {
    title: 'ARIA属性: インタラクティブ要素には適切な aria-label, aria-describedby を付与する',
    content:
      '### 基本アクセシビリティ\n- **ARIA属性**: インタラクティブ要素には適切な `aria-label`, `aria-describedby` を付与する\n- **キーボード操作**: 主要操作はキーボードでも実行できること（Tab, Enter, Escape）\n- **フォーカス表示**: フォーカス状態を視覚的に明確にする（`focus-visible` 活用）\n- **色のコントラスト**: WCAG 2.1 AA を基本目標とする\n- **代替テキスト**: 画像には必ず `alt` 属性を付与する（装飾的な画像は `alt=""`）',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'aria属性: インタラクティブ要素には適切な aria-label, aria-describedby を付与する',
      ],
      severity: 'required',
      fileGlobs: ['drizzle/**'],
      changeTypes: ['db'],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/aria属性:-インタラクティブ要素には適切な-aria-label,-aria-describedby-を付与する',
    },
  },
  {
    title:
      'Biome: 2スペース、100文字、シングルクォート、セミコロン必須。フォーマットはBiomeで統一する',
    content:
      'Biome: 2スペース、100文字、シングルクォート、セミコロン必須。フォーマットはBiomeで統一する',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'tooling', 'biome', 'typescript', 'javascript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'tooling',
        'biome',
        'typescript',
        'javascript',
        'biome: 2スペース、100文字、シングルクォート、セミコロン必須。フォーマットはbiomeで統一する',
      ],
      severity: 'required',
      fileGlobs: ['*.json', '*.toml'],
      changeTypes: ['config'],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/biome:-2スペース、100文字、シングルクォート、セミコロン必須。フォーマットはbiomeで統一する',
    },
  },
  {
    title: 'console.log禁止とlogger使用必須',
    content:
      'console.log禁止とlogger使用必須: console.log は原則禁止し、logger 系 API を使って文脈付きで記録する。\n- console.log禁止とlogger使用必須: console.log禁止とlogger使用必須: console.log は原則禁止し、logger 系 API を使って文脈付きで記録する。\n- console.log禁止: @logger使用(Biomeエラー)\n- console.log完全禁止: ESLint警告回避のため、ログはlogger使用必須\n- log.debug/info/warn/error など意味に沿ったレベルで記録し、文脈情報を含める',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [
      'logging',
      'coding-rule',
      'technology',
      'language',
      'typescript',
      'tooling',
      'biome',
      'javascript',
      'eslint',
    ],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'logging',
        'coding-rule',
        'technology',
        'language',
        'typescript',
        'tooling',
        'biome',
        'javascript',
        'eslint',
        'console.log禁止とlogger使用必須',
      ],
      severity: 'required',
      fileGlobs: ['src/**/routes/**', '*.json', '*.toml'],
      changeTypes: ['api', 'config', 'build'],
      technologies: ['typescript'],
    },
    sourceIds: {
      entityId: 'rule/console.log禁止とlogger使用必須',
    },
  },
  {
    title: 'content-safety targetType の事前合意ルール',
    content:
      '新規ドメイン導入時に targetType マップを先に更新し、合意を得る。未定義な targetType の ad-hoc な追加による型や運用の不整合を防ぐため。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['governance', 'content_safety'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['governance', 'content_safety', 'content-safety targettype の事前合意ルール'],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/content-safety-targettype-の事前合意ルール-1777368444617',
    },
  },
  {
    title: 'Conventional Commitsのtypeと日本語subject規約',
    content:
      '### コミット規約 (Conventional Commits)\n- **形式**: `<type>(<scope>): <subject>`\n- **type**:\n  | type | 説明 |\n  | :--- | :--- |\n  | `feat` | 新機能 |\n  | `fix` | バグ修正 |\n  | `docs` | ドキュメントのみの変更 |\n  | `style` | コードの意味に影響しない変更（フォーマット等） |\n  | `refactor` | バグ修正でも機能追加でもないコード変更 |\n  | `test` | テストの追加・修正 |\n  | `chore` | ビルドプロセスやツールの変更 |\n- **例**: `feat(patient): 患者一覧にフィルター機能を追加`, `fix(auth): ログイン時のトークン保存エラーを修正`\n- **subject**: 日本語可、命令形で記述、50文字以内',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['conventional commitsのtypeと日本語subject規約'],
      severity: 'required',
      fileGlobs: ['docs/**', 'test/**'],
      changeTypes: ['auth', 'docs', 'test', 'refactor'],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/conventional-commitsのtypeと日本語subject規約',
    },
  },
  {
    title: 'Custom HookとRepositoryの責務分離',
    content:
      '#### ロジック分離\n| 分類 | Custom Hook (`src/modules/{domain}/hooks.ts`) | Repository (`src/modules/{domain}/repositories.ts`) |\n| :--- | :--- | :--- |\n| **役割** | **React接着剤** | **純粋ロジック・通信** |\n| **依存** | React API | React非依存 (useApiClient, Zod等) |\n| **内容** | TanStack Query呼び出し<br>Loading/Error公開 | API通信<br>**Mock生成・遅延**<br>計算・変換 |\n| **テスト** | `renderHook`必要 | 単体テスト可(高速) |\n\n**禁止**: Hook内でのデータ生成・加工、Repository内での `useState`/`useEffect` 使用',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [
      'technology',
      'language',
      'typescript',
      'frontend',
      'react',
      'validation',
      'zod',
      'tanstack-query',
    ],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'frontend',
        'react',
        'validation',
        'zod',
        'tanstack-query',
        'custom hookとrepositoryの責務分離',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/services/**', 'src/**/routes/**', 'test/**'],
      changeTypes: ['frontend', 'backend', 'api', 'test'],
      technologies: ['typescript', 'react', 'tanstack-query', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/custom-hookとrepositoryの責務分離',
    },
  },
  {
    title:
      'Design System優先: 新規UI実装時は @gxp/design-system のコンポーネントを組み合わせて構築する（汎用部品の独自実装は避ける）',
    content:
      '### コンポーネント実装\n- **Design System優先**: 新規UI実装時は `@gxp/design-system` のコンポーネントを組み合わせて構築する（汎用部品の独自実装は避ける）\n- **スタイリング**: Tailwind CSSクラスのみ。Design Systemの制約に従う\n- **Schema-First**:\n  - **ドメイン/APIデータ**: `interface` / `type` を手書きせず、`[DomainName].schema.ts` で Zod スキーマを定義する\n    - `export type User = z.infer<typeof UserSchema>;`\n  - **UI Props**: コンポーネントの表示制御に関わるProps (`isOpen`, `variant`等) は `interface` 定義を許容する\n  - **禁止事項**: 今後 `types.ts` を使用することを **禁止** とする。既存の `types.ts` は規約違反状態とみなし、修正のタイミングで必ず `[DomainName].schema.ts` へ移行すること。\n  - **テスト配置**: **Co-location** を原則とする。`Test/` フォルダ（ルートまたはモジュール内サブディレクトリ）は作成せず、テスト対象ファイルと同じディレクトリに `*.test.ts` (または `*.test.tsx`) を配置する。\n    - ✅ `src/modules/auth/Auth.schema.test.ts`\n    - ✅ `src/modules/auth/hooks/useLogin.test.ts`\n    - ❌ `src/modules/auth/Test/Auth.schema.test.ts` (サブディレクトリ禁止)\n    - ❌ `src/Test/Auth.test.tsx`, `root/Test/Auth.test.tsx` (ルート配置禁止)',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'language', 'typescript', 'frontend', 'react', 'validation', 'zod'],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'frontend',
        'react',
        'validation',
        'zod',
        'design system優先: 新規ui実装時は @gxp/design-system のコンポーネントを組み合わせて構築する（汎用部品の独自実装は避ける）',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**', 'test/**'],
      changeTypes: ['frontend', 'api', 'auth', 'test'],
      technologies: ['typescript', 'react', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/design-system優先:-新規ui実装時は-@gxp/design-system-のコンポーネントを組み合わせて構築する（汎用部品の独自実装は避ける）',
    },
  },
  {
    title: 'i18next必須: UI文字列ハードコード厳禁',
    content: 'i18next必須: UI文字列ハードコード厳禁',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'i18next', 'i18n'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'i18next',
        'i18n',
        'i18next必須: ui文字列ハードコード厳禁',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['i18next'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/i18next必須:-ui文字列ハードコード厳禁',
    },
  },
  {
    title: 'localStorage使用制限: UI設定・一時記録のみ保存可。患者データ等のビジネスデータ保存禁止',
    content:
      'localStorage使用制限: UI設定・一時記録のみ保存可。患者データ等のビジネスデータ保存禁止',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'localstorage使用制限: ui設定・一時記録のみ保存可。患者データ等のビジネスデータ保存禁止',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', '*.json', '*.toml'],
      changeTypes: ['frontend', 'config'],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/localstorage使用制限:-ui設定・一時記録のみ保存可。患者データ等のビジネスデータ保存禁止',
    },
  },
  {
    title: 'Migration 生成時の差分境界確認ルール',
    content:
      'Migration 生成前に、対象ドメイン以外の無関係なテーブルの差分が混じっていないか確認する。必要に応じて migration を分割し、差分境界を明確にする。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['database', 'migration'],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['database', 'migration', 'migration 生成時の差分境界確認ルール'],
      severity: 'required',
      fileGlobs: ['drizzle/**'],
      changeTypes: ['db'],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/migration-生成時の差分境界確認ルール-1777368444619',
    },
  },
  {
    title: 'React 19 + Tauriのタッチパネル医療画像管理アプリ構成',
    content:
      '## 🎯 プロジェクト概要\n**タッチパネル医療画像管理アプリ**\n- **Stack**: React 19.x + TypeScript + Vite + Tauri 2.x\n- **CSS**: Tailwind CSS (clsx, tailwind-merge)\n- **State**: React Context + TanStack Query\n- **i18n**: i18next',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [
      'technology',
      'language',
      'typescript',
      'frontend',
      'react',
      'desktop',
      'tauri',
      'rust',
      'tanstack-query',
      'i18next',
      'i18n',
    ],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'frontend',
        'react',
        'desktop',
        'tauri',
        'rust',
        'tanstack-query',
        'i18next',
        'i18n',
        'react 19 + tauriのタッチパネル医療画像管理アプリ構成',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['typescript', 'react', 'tanstack-query', 'i18next', 'rust'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/react-19-+-tauriのタッチパネル医療画像管理アプリ構成',
    },
  },
  {
    title: 'Repository Factory: createRepository を使用して環境に応じた実装を切り替える',
    content:
      '#### Repository実装ルール\n1. **Repository Factory**: `createRepository` を使用して環境に応じた実装を切り替える\n2. **Interface**: 必ずインターフェース (`I{Domain}Repository`) を定義する\n3. **Mock実装**: `STANDALONE` モード用の `MockRepository` クラスを必ず実装する\n4. **Real実装**: `PRD/UAT/DEV` モード用の `RealRepository` クラスを実装する\n\n```typescript\n// 実装例\nexport const userRepository = createRepository(\n  UserRepository,      // Real implementation\n  MockUserRepository   // Mock implementation\n);\n```',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'language', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'repository factory: createrepository を使用して環境に応じた実装を切り替える',
      ],
      severity: 'required',
      fileGlobs: ['src/services/**'],
      changeTypes: ['backend'],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/repository-factory:-createrepository-を使用して環境に応じた実装を切り替える',
    },
  },
  {
    title: 'Responsive: useIsMobileフック、Tailwind md:/lg:/xl:活用',
    content: 'Responsive: useIsMobileフック、Tailwind md:/lg:/xl:活用',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'frontend', 'react'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'frontend',
        'react',
        'responsive: useismobileフック、tailwind md:/lg:/xl:活用',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['react'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/responsive:-useismobileフック、tailwind-md:/lg:/xl:活用',
    },
  },
  {
    title:
      'Schema-First必須: ドメインデータ型は必ずZodスキーマ定義。UIコンポーネントのProps制御用のみinterface許容',
    content:
      'Schema-First必須: ドメインデータ型は必ずZodスキーマ定義。UIコンポーネントのProps制御用のみinterface許容',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'language', 'typescript', 'validation', 'zod'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'language',
        'typescript',
        'validation',
        'zod',
        'schema-first必須: ドメインデータ型は必ずzodスキーマ定義。uiコンポーネントのprops制御用のみinterface許容',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['typescript', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/schema-first必須:-ドメインデータ型は必ずzodスキーマ定義。uiコンポーネントのprops制御用のみinterface許容',
    },
  },
  {
    title: 'Server Components禁止',
    content: 'Server Components禁止: React Server Componentsは使用しない',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'frontend', 'react', 'nextjs'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'frontend',
        'react',
        'nextjs',
        'server components禁止',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['react'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/server-components禁止',
    },
  },
  {
    title:
      'TanStack Query必須: Component/Hook層での fetch 直接使用禁止。データ取得・更新はTanStack Query経由（Repository層の…',
    content:
      'TanStack Query必須: Component/Hook層での fetch 直接使用禁止。データ取得・更新はTanStack Query経由（Repository層の apiClient 実装内のみ通信処理を許可）',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'frontend', 'tanstack-query', 'react', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'frontend',
        'tanstack-query',
        'react',
        'typescript',
        'tanstack query必須: component/hook層での fetch 直接使用禁止。データ取得・更新はtanstack query経由（repository層の…',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/services/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'backend', 'api'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/tanstack-query必須:-component/hook層での-fetch-直接使用禁止。データ取得・更新はtanstack-query経由（repository層の…',
    },
  },
  {
    title: 'targetType 解決の標準化ルール',
    content:
      'targetType ごとに parent resource を解決してから権限判定を行う。targetId の意味がドメインごとに異なる（post/comment/track等）ため、標準的な解決フローを設ける。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['authorization', 'standardization'],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['authorization', 'standardization', 'targettype 解決の標準化ルール'],
      severity: 'required',
      fileGlobs: [],
      changeTypes: ['auth'],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/targettype-解決の標準化ルール-1777368444615',
    },
  },
  {
    title:
      'try-catch: I/O境界（Repository、Mutation、イベントハンドラ）では必ず try-catch を使用し、エラーを適切にログ出力・通知する',
    content:
      '### エラーハンドリング\n- **try-catch**: I/O境界（Repository、Mutation、イベントハンドラ）では必ず try-catch を使用し、エラーを適切にログ出力・通知する\n- **Error Boundary**: ページ単位で `ErrorBoundary` コンポーネントを設置し、予期しないエラーからの復旧を可能にする\n- **ユーザー通知**: エラー発生時は Notification コンテキストを使用してユーザーに通知する\n- **再スロー禁止**: catch ブロックで何も処理せず再スローするだけのコードは禁止',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'try-catch: i/o境界（repository、mutation、イベントハンドラ）では必ず try-catch を使用し、エラーを適切にログ出力・通知する',
      ],
      severity: 'required',
      fileGlobs: ['src/services/**'],
      changeTypes: ['backend'],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/try-catch:-i/o境界（repository、mutation、イベントハンドラ）では必ず-try-catch-を使用し、エラーを適切にログ出力・通知する',
    },
  },
  {
    title: 'TypeScript/Reactファイル・型・Query Keyの命名規則',
    content:
      "### 命名規則\n| 対象 | 規則 | 例 |\n| :--- | :--- | :--- |\n| **ファイル（コンポーネント）** | PascalCase | `PatientCard.tsx`, `BedSchedule.schema.ts` |\n| **ファイル（ユーティリティ）** | camelCase または kebab-case | `hooks.ts`, `utils.ts`, `repositories.ts` |\n| **コンポーネント名** | PascalCase | `const PatientCard = () => {...}` |\n| **関数・変数** | camelCase | `fetchPatientData`, `isLoading` |\n| **定数** | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `API_BASE_URL` |\n| **型・インターフェース** | PascalCase | `type Patient`, `interface IRepository` |\n| **Zodスキーマ** | PascalCase + Schema | `PatientSchema`, `UserSchema` |\n| **TanStack Query キー** | camelCase配列 | `['patients', 'list', params]` |\n| **CSSクラス（カスタム）** | kebab-case | `.patient-card`, `.bed-schedule` |",
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [
      'technology',
      'language',
      'typescript',
      'frontend',
      'react',
      'validation',
      'zod',
      'tanstack-query',
    ],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'frontend',
        'react',
        'validation',
        'zod',
        'tanstack-query',
        'typescript/reactファイル・型・query keyの命名規則',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/services/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'backend', 'api'],
      technologies: ['typescript', 'react', 'tanstack-query', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/typescript/reactファイル・型・query-keyの命名規則',
    },
  },
  {
    title: 'useListQueryParams フックと Zod スキーマを使用して型安全に実装する',
    content:
      "### 状態管理 & キャッシュ戦略\n- **URL as Single Source of Truth**:\n  - 一覧画面の状態（ページネーション、ソート、フィルタ）は **URL クエリパラメータ** で管理する\n  - `useListQueryParams` フックと Zod スキーマを使用して型安全に実装する\n  - `useState` での永続的な UI 状態管理は避ける\n- **TanStack Query Integration**:\n  - Query Key には必ず URL パラメータを含める\n  - **Query Key Factory** (`queries.ts`) を使用してキー生成を一元化する\n  - ページネーション時のちらつき防止に `placeholderData: keepPreviousData` を使用する\n- **Invalidation**:\n  - 更新系処理（作成・更新・削除）後は、Factory キーを使用して関連する一覧クエリを Invalidate する\n- **Query Key Definition (`queries.ts`)**:\n  - TanStack Query の Query Key 定義は、必ず `src/modules/{domain}/queries.ts` に集約する\n  - 複数のキーがある場合も、このファイルに追記する形で管理する（分散させない）\n\n```typescript\n// src/modules/patient/queries.ts - 実装例\nimport type { PatientListParams } from './Patient.schema';\n\nexport const patientKeys = {\n  // ベースキー\n  all: ['patients'] as const,\n  // 一覧系\n  lists: () => [...patientKeys.all, 'list'] as const,\n  list: (params: PatientListParams) => [...patientKeys.lists(), params] as const,\n  // 詳細系\n  details: () => [...patientKeys.all, 'detail'] as const,\n  detail: (id: string) => [...patientKeys.details(), id] as const,\n};\n\n// 使用例: hooks.ts\n// useQuery({ queryKey: patientKeys.list({ wardId, page }), queryFn: ... })\n// queryClient.invalidateQueries({ queryKey: patientKeys.lists() })\n```",
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [
      'technology',
      'language',
      'typescript',
      'frontend',
      'react',
      'validation',
      'zod',
      'tanstack-query',
    ],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'frontend',
        'react',
        'validation',
        'zod',
        'tanstack-query',
        'uselistqueryparams フックと zod スキーマを使用して型安全に実装する',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['typescript', 'react', 'tanstack-query', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/uselistqueryparams-フックと-zod-スキーマを使用して型安全に実装する',
    },
  },
  {
    title:
      'アプリケーション固有の src/components/ui は原則作成せず、Design Systemからインポートして使用する',
    content:
      "### ディレクトリ構成\n- **`@gxp/design-system` (外部パッケージ)**\n  - ボタン・入力・モーダル・カードなどの **汎用UIコンポーネントライブラリ**\n  - アプリケーション固有の `src/components/ui` は原則作成せず、Design Systemからインポートして使用する\n  - `import { Button, Card } from '@gxp/design-system';`\n\n- **`src/modules/{domain}/`**\n  - **RAG-friendly Architecture** (詳細は `RAG_DOC_RULES.md` 参照)\n  - **Flat-First**: 可能な限りフラットな構造を保つ\n  - 構成要素:\n    - `[DomainName].tsx`: **エントリーポイント**。JSDocで機能とユーザーストーリー記述 (`Main.tsx`の役割)\n    - `[DomainName].schema.ts`: **Schema-First**。Zodスキーマと型定義を集約 (`types.ts` の代替)\n    - `hooks.ts`: カスタムフックを集約\n    - `repositories.ts`: **データアクセス層**。API呼び出し（apiClient使用）とZodによるバリデーションを集約\n    - `README.md`: RAG用ドキュメント（構成、仕様、ストーリー）\n    - `[DomainName].test.tsx`: **User Storyテスト** (統合テスト)。UIの振る舞いを検証（優先度低）\n    - `[DomainName].schema.test.ts`: **Schemaテスト** (Co-location)。バリデーションを検証（優先度1）\n    - `index.ts`: **禁止**。RAG最適化と循環参照回避のため、バレルファイル(Barrel File)は作成せず、具体的なファイルから直接インポートする (`import ... from './Personnel.schema'`)\n  - **サブディレクトリ分割基準**: 1ファイルが300行を超える、または同種のファイルが5つ以上になった場合のみ `components/`, `hooks/`, `repositories/`, `mocks/` 等のサブディレクトリ分割を検討する。各サブディレクトリ内でも `index.ts` は作成しない。\n\n- **`src/pages/`**\n  - **Thin Wrapper**: ルーティングのエンドポイントとしての役割のみ\n  - ロジックを持たず、`src/modules` からコンポーネントをインポートして描画するだけにする\n  - `export { default } from '@src/modules/[domain]/[DomainName]';` のように具体ファイルを直接参照する形が理想",
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'language', 'typescript', 'validation', 'zod'],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'validation',
        'zod',
        'アプリケーション固有の src/components/ui は原則作成せず、design systemからインポートして使用する',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**', 'docs/**', 'test/**'],
      changeTypes: ['frontend', 'api', 'docs', 'test'],
      technologies: ['typescript', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/アプリケーション固有の-src/components/ui-は原則作成せず、design-systemからインポートして使用する',
    },
  },
  {
    title: 'コメント: JSDocを含むすべてのコードコメントは 日本語 で記述する',
    content: 'コメント: JSDocを含むすべてのコードコメントは 日本語 で記述する',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'language', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'language',
        'typescript',
        'コメント: jsdocを含むすべてのコードコメントは 日本語 で記述する',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/コメント:-jsdocを含むすべてのコードコメントは-日本語-で記述する',
    },
  },
  {
    title:
      'サーバー起動禁止: ユーザー起動サーバーのみ使用 / 循環参照禁止: import循環・コンポーネント相互参照回避',
    content:
      '### AI動作制約\n- **サーバー起動禁止**: ユーザー起動サーバーのみ使用\n- **循環参照禁止**: import循環・コンポーネント相互参照回避\n- **バイパス禁止**: 認証バイパス等、如何なる理由があっても実装しない\n- **汎用性必須**: 特定要件専用コード禁止、再利用可能な設計\n- **無限ループ回避**: `useEffect`/`useRef`依存配列厳守\n- **日本語利用**: 質問が英語で無い限り、回答、説明、コード内のコメントも日本語記述\n- **ビルドチェック**: ユーザーに作業完了報告前に、ビルドエラーが起きないか確認。(質問の回答時は行わない)\n- **Design System原則**: ボタン等の汎用UIは、必ず `@gxp/design-system` を使用する（独自実装禁止）。\n- **コンポーネント配置**: ドメイン固有コンポーネントは `src/modules/{domain}/` 直下、または `components/` に配置する（Flat-First）。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'frontend', 'react'],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'react',
        'サーバー起動禁止: ユーザー起動サーバーのみ使用 / 循環参照禁止: import循環・コンポーネント相互参照回避',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend', 'auth'],
      technologies: ['react'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/サーバー起動禁止:-ユーザー起動サーバーのみ使用-/-循環参照禁止:-import循環・コンポーネント相互参照回避',
    },
  },
  {
    title: 'ツール: Vitest + @testing-library/react / 戦略: docs/Testing-strategy.md を参照のこと',
    content:
      '### テスト\n- **ツール**: Vitest + @testing-library/react\n- **戦略**: `docs/Testing-strategy.md` を参照のこと\n- **方針**: **ROI最大化戦略**（Schema > Repository > Hooks > Mocks の順）\n  - **Schema**: Zodバリデーションの網羅的テスト（境界値・変換）\n  - **Repository**: API通信とデータマッピングの検証\n  - **Hooks**: `renderHook` による状態遷移の検証\n- **優先事項**:\n  - 見た目（TSX）のテストやSnapshotは原則不要。ロジックとデータ整合性を重視する\n  - カバレッジ目標: 80% (Statements/Functions/Lines)\n- **配置**: 実装ファイルと同じ階層に配置する (**Co-location**)。いかなる階層の `Test` フォルダも使用禁止\n- **禁止**: カバレッジのためだけに、テストを通すだけの不自然な実装をしない',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [
      'technology',
      'language',
      'typescript',
      'frontend',
      'react',
      'validation',
      'zod',
      'testing',
      'vitest',
      'javascript',
      'testing-library',
    ],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'frontend',
        'react',
        'validation',
        'zod',
        'testing',
        'vitest',
        'javascript',
        'testing-library',
        'ツール: vitest + @testing-library/react / 戦略: docs/testing-strategy.md を参照のこと',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/services/**', 'src/**/routes/**', 'docs/**', 'test/**'],
      changeTypes: ['frontend', 'backend', 'api', 'docs', 'test'],
      technologies: ['typescript', 'react', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/ツール:-vitest-+-@testing-library/react-/-戦略:-docs/testing-strategy.md-を参照のこと',
    },
  },
  {
    title: 'ドメイン間イベントの契約先行ルール',
    content:
      'ドメイン間イベントの実装前に、sourceDomain, eventType, payload schema を確定させる。実装後にこれらを変更する際の手戻りを最小限にするため。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['event_driven_architecture', 'contract_first'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'event_driven_architecture',
        'contract_first',
        'ドメイン間イベントの契約先行ルール',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/ドメイン間イベントの契約先行ルール-1777368444620',
    },
  },
  {
    title: 'パスエイリアス: @src/*, @components/*, @lib/*, @logger',
    content: 'パスエイリアス: @src/*, @components/*, @lib/*, @logger',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'language', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'language',
        'typescript',
        'パスエイリアス: @src/*, @components/*, @lib/*, @logger',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['typescript'],
    },
    sourceIds: {
      entityId: 'rule/パスエイリアス:-@src/*,-@components/*,-@lib/*,-@logger',
    },
  },
  {
    title:
      'ボーイスカウトルール (Boy Scout Rule): 変更時は周辺コードも改善する / MUST: 必須。例外は事前合意がない限り不可',
    content:
      '## 🤝 運用ルール\n- **ボーイスカウトルール (Boy Scout Rule)**: 変更時は周辺コードも改善する\n- **ルール優先度**:\n  - **MUST**: 必須。例外は事前合意がない限り不可\n  - **SHOULD**: 推奨。合理的理由があれば逸脱可（PR説明必須）\n  - **MAY**: 任意。文脈に応じて採用\n- **自動検証マッピング**:\n  - **Biome/ESLint**: `console.log禁止`、フォーマット、基本静的解析\n  - **TypeScript**: `any禁止`、型整合性\n  - **Vitest**: Schema/Repository/Hookの回帰防止\n  - **Build**: import解決、型・バンドル整合性の最終確認\n- **チェック**:\n  - 変更時: `pnpm format && pnpm type-check && pnpm lint:fix && pnpm build`\n  - デプロイ前: `pnpm test && pnpm build`',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [
      'technology',
      'language',
      'typescript',
      'tooling',
      'biome',
      'javascript',
      'eslint',
      'testing',
      'vitest',
    ],
    category: 'testing',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'typescript',
        'tooling',
        'biome',
        'javascript',
        'eslint',
        'testing',
        'vitest',
        'ボーイスカウトルール (boy scout rule): 変更時は周辺コードも改善する / must: 必須。例外は事前合意がない限り不可',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/services/**', 'test/**', '*.json', '*.toml'],
      changeTypes: ['frontend', 'backend', 'test', 'config', 'build'],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/ボーイスカウトルール-(boy-scout-rule):-変更時は周辺コードも改善する-/-must:-必須。例外は事前合意がない限り不可',
    },
  },
  {
    title:
      'ホバー依存禁止: タップのみで完結すること / ターゲット: PC/タブレット(Tauri)、スマホ(Web)',
    content:
      '### タッチファーストデザイン (Touch First Design)\n- **ターゲット**: PC/タブレット(Tauri)、スマホ(Web)\n- **ホバー依存禁止**: タップのみで完結すること\n- **スクロール運用**: ページネーションを基本としつつ、情報量に応じてスクロールを許容する。スクロールバーの非表示は原則避ける\n- **余白最適化**: Design System のスペーシングトークン（`--spacing-*`）を使用する。個別の margin/padding 値のハードコードは避ける',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'desktop', 'tauri', 'rust'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'desktop',
        'tauri',
        'rust',
        'ホバー依存禁止: タップのみで完結すること / ターゲット: pc/タブレット(tauri)、スマホ(web)',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: ['rust'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/ホバー依存禁止:-タップのみで完結すること-/-ターゲット:-pc/タブレット(tauri)、スマホ(web)',
    },
  },
  {
    title:
      'マジックナンバー禁止: 定数化必須（ただし -1, 0, 1, 2, 100 など慣用的で意味が明確な値は許容）',
    content:
      'マジックナンバー禁止: 定数化必須（ただし -1, 0, 1, 2, 100 など慣用的で意味が明確な値は許容）',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'マジックナンバー禁止: 定数化必須（ただし -1, 0, 1, 2, 100 など慣用的で意味が明確な値は許容）',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/マジックナンバー禁止:-定数化必須（ただし--1,-0,-1,-2,-100-など慣用的で意味が明確な値は許容）',
    },
  },
  {
    title:
      '保存可能: UI設定・表示設定・ユーザー操作の一時記録のみ / 例: テーマ、言語、サイドバー開閉状態、最終訪問ページ',
    content:
      '### LocalStorage使用ポリシー\n- **保存可能**: UI設定・表示設定・ユーザー操作の一時記録のみ\n  - ✅ 例: テーマ、言語、サイドバー開閉状態、最終訪問ページ\n- **保存禁止**: ビジネスデータ・機密情報・大量データ\n  - ❌ 禁止例: イベントデータ、患者情報、予約データ、トークン\n- **原則**: ビジネスデータはAPI経由で管理し、LocalStorageはキャッシュに使用しない\n- **優先ルール**: `sessionStorage` を含むすべてのブラウザストレージに本ポリシーを適用する\n- **推奨**: データキャッシュが必要な場合は TanStack Query を使用する',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'frontend', 'tanstack-query', 'react', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'tanstack-query',
        'react',
        'typescript',
        '保存可能: ui設定・表示設定・ユーザー操作の一時記録のみ / 例: テーマ、言語、サイドバー開閉状態、最終訪問ページ',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**', '*.json', '*.toml'],
      changeTypes: ['frontend', 'api', 'config'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/保存可能:-ui設定・表示設定・ユーザー操作の一時記録のみ-/-例:-テーマ、言語、サイドバー開閉状態、最終訪問ページ',
    },
  },
  {
    title:
      '安全設計: 破壊的操作（削除など）は確認ダイアログを必須とする / ユーザビリティ: ヒューマンエラーを防止する設計にする',
    content:
      '### 医療機器認定 (SaMD)\n- **ユーザビリティ**: ヒューマンエラーを防止する設計にする\n- **安全設計**: 破壊的操作（削除など）は確認ダイアログを必須とする\n- **一貫性**: 操作の一貫性を維持する',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        '安全設計: 破壊的操作（削除など）は確認ダイアログを必須とする / ユーザビリティ: ヒューマンエラーを防止する設計にする',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/安全設計:-破壊的操作（削除など）は確認ダイアログを必須とする-/-ユーザビリティ:-ヒューマンエラーを防止する設計にする',
    },
  },
  {
    title:
      '必須: TanStack Queryが設定されたすべての再試行を行っても初期データ取得に失敗した場合は、Notificationコンテキストのエラー通知機能でユーザーに知らせる',
    content:
      '### 初期化エラー通知\n- **必須**: TanStack Queryが設定されたすべての再試行を行っても初期データ取得に失敗した場合は、Notificationコンテキストのエラー通知機能でユーザーに知らせる\n- **内容**: 通知タイトルは「読み込み失敗」など状況が分かる文言にし、本文にはHTTPステータスやネットワークエラーなど失敗理由を含める\n- **タイミング**: 自動リトライが続いている間は通知せず、TanStack Queryが最終的に失敗状態を返した瞬間に1回だけ通知する\n- **目的**: 初期表示不能時にも即座にフィードバックと復旧策（再試行等）を提示する',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'frontend', 'tanstack-query', 'react', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'tanstack-query',
        'react',
        'typescript',
        '必須: tanstack queryが設定されたすべての再試行を行っても初期データ取得に失敗した場合は、notificationコンテキストのエラー通知機能でユーザーに知らせる',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', '*.json', '*.toml'],
      changeTypes: ['frontend', 'config'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/必須:-tanstack-queryが設定されたすべての再試行を行っても初期データ取得に失敗した場合は、notificationコンテキストのエラー通知機能でユーザーに知らせる',
    },
  },
  {
    title:
      '必須: ページ初期化でデータがまだ届いていない場合は、想定レイアウトと同じサイズ感のSkeletonを縦に並べ、中央付近のSkeletonに大きめのスピナーを重ねて表示する',
    content:
      '### ローディング表示\n**TanStack Query使用時の初期ローディング**:\n- **必須**: ページ初期化でデータがまだ届いていない場合は、想定レイアウトと同じサイズ感のSkeletonを縦に並べ、中央付近のSkeletonに大きめのスピナーを重ねて表示する\n- **目的**: ユーザーにデータ取得中であることを明確に伝える\n\n**使い分け**:\n- **初期ローディング**: `Skeleton + Spinner` (ページ全体のデータ取得)\n- **再取得**: Spinnerのみ or 既存データ表示 (リフレッシュ時)\n- **部分更新**: Mutation後は楽観的更新推奨',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'frontend', 'tanstack-query', 'react', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'tanstack-query',
        'react',
        'typescript',
        '必須: ページ初期化でデータがまだ届いていない場合は、想定レイアウトと同じサイズ感のskeletonを縦に並べ、中央付近のskeletonに大きめのスピナーを重ねて表示する',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/必須:-ページ初期化でデータがまだ届いていない場合は、想定レイアウトと同じサイズ感のskeletonを縦に並べ、中央付近のskeletonに大きめのスピナーを重ねて表示する',
    },
  },
  {
    title: '必須: 登録/更新ボタンはAPI送信時に loading と success の2つの状態を管理する',
    content:
      '### ボタンの非同期状態管理\n**登録・更新ボタンの実装**:\n- **必須**: 登録/更新ボタンはAPI送信時に `loading` と `success` の2つの状態を管理する\n- **状態管理**:\n  - `isSubmitting` (boolean): API送信中かどうか\n  - `isSuccess` (boolean): API送信が成功したかどうか\n- **動作フロー**:\n  1. **送信開始**: ユーザーがボタンをクリックしたら `isSubmitting` を `true` に設定。ボタンのテキストが消えて回転するSpinnerを表示\n  2. **送信完了**: API呼び出しが成功したら `isSubmitting` を `false`、`isSuccess` を `true` に設定。Spinnerがチェックマーク(✓)に変わる\n  3. **フィードバック待機**: チェックマークを1秒間表示してユーザーに成功を視覚的に伝える\n  4. **クリーンアップ**: 待機後にモーダルを閉じる、またはフォームをリセットする\n- **Buttonコンポーネントのプロップス**:\n  - `loading={isSubmitting}`: Spinner表示の制御\n  - `success={isSuccess}`: チェックマーク表示の制御\n  - `variant="positive"`: 肯定的なアクションを示す\n- **エラー処理**: API呼び出しが失敗した場合は `isSubmitting` を `false` に戻し、エラー通知を表示する\n\n**使い分け**:\n- **登録/更新ボタン**: `loading` + `success` の両方の状態を使用（モーダル内のフォーム送信など）\n- **検索/フィルタボタン**: `loading`のみ使用（successフィードバックは不要）\n- **削除ボタン**: 確認ダイアログ後に `loading` のみ使用（削除後は即座にUIを更新）',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['必須: 登録/更新ボタンはapi送信時に loading と success の2つの状態を管理する'],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/**/routes/**', '*.json', '*.toml'],
      changeTypes: ['frontend', 'api', 'config'],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/必須:-登録/更新ボタンはapi送信時に-loading-と-success-の2つの状態を管理する',
    },
  },
  {
    title:
      '状態管理: React Context + TanStack Query基本。React 19機能(useOptimistic等)はTanStack Queryと役割分担して…',
    content:
      '状態管理: React Context + TanStack Query基本。React 19機能(useOptimistic等)はTanStack Queryと役割分担して使用',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'frontend', 'react', 'tanstack-query', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'frontend',
        'react',
        'tanstack-query',
        'typescript',
        '状態管理: react context + tanstack query基本。react 19機能(useoptimistic等)はtanstack queryと役割分担して…',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/状態管理:-react-context-+-tanstack-query基本。react-19機能(useoptimistic等)はtanstack-queryと役割分担して…',
    },
  },
  {
    title: '環境変数: import.meta.env の直接参照は避け、可能な限り Zod で検証を行う',
    content: '環境変数: import.meta.env の直接参照は避け、可能な限り Zod で検証を行う',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'language', 'typescript', 'validation', 'zod'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'language',
        'typescript',
        'validation',
        'zod',
        '環境変数: import.meta.env の直接参照は避け、可能な限り zod で検証を行う',
      ],
      severity: 'required',
      fileGlobs: ['*.json', '*.toml'],
      changeTypes: ['config'],
      technologies: ['typescript', 'zod'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/環境変数:-import.meta.env-の直接参照は避け、可能な限り-zod-で検証を行う',
    },
  },
  {
    title:
      '監査証跡: データの変更・閲覧ログを考慮する / Privacy by Design: デフォルトでプライバシー保護を考慮する',
    content:
      '### GDPR & プライバシー\n- **Privacy by Design**: デフォルトでプライバシー保護を考慮する\n- **データ最小化**: 不要な個人情報は扱わない\n- **監査証跡**: データの変更・閲覧ログを考慮する\n- **セキュリティ**: `DOMPurify` を使用する。ブラウザストレージは用途限定で扱い、機微情報は `localStorage` / `sessionStorage` とも保存しない',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: [],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        '監査証跡: データの変更・閲覧ログを考慮する / privacy by design: デフォルトでプライバシー保護を考慮する',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/監査証跡:-データの変更・閲覧ログを考慮する-/-privacy-by-design:-デフォルトでプライバシー保護を考慮する',
    },
  },
  {
    title:
      '禁止: ページコンポーネント・Hookでの fetch の直接使用、ページコンポーネントでの useQuery の直接使用',
    content:
      '### API実装 (3層アーキテクチャ)\n**禁止**: ページコンポーネント・Hookでの `fetch` の直接使用、ページコンポーネントでの `useQuery` の直接使用\n**必須**:\n1. **Repository**: データアクセス (API/Mock)\n2. **Custom Hook**: TanStack Queryによるデータ管理\n3. **Component**: UI表示',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'frontend', 'react', 'tanstack-query', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'react',
        'tanstack-query',
        'typescript',
        '禁止: ページコンポーネント・hookでの fetch の直接使用、ページコンポーネントでの usequery の直接使用',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'src/services/**', 'src/**/routes/**'],
      changeTypes: ['frontend', 'backend', 'api'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/禁止:-ページコンポーネント・hookでの-fetch-の直接使用、ページコンポーネントでの-usequery-の直接使用',
    },
  },
  {
    title: '言語: TypeScriptを使用する',
    content: '言語: TypeScriptを使用する',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['coding-rule', 'technology', 'language', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'coding-rule',
        'technology',
        'language',
        'typescript',
        '言語: typescriptを使用する',
      ],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: ['typescript'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId: 'rule/言語:-typescriptを使用する',
    },
  },
  {
    title:
      '計測: 推測で最適化せず、計測後に最適化する (React.memo 等) / TanStack Query: staleTime を適切に設定し、不要なリクエストを防ぐ',
    content:
      '### パフォーマンス\n- **計測**: 推測で最適化せず、計測後に最適化する (`React.memo` 等)\n- **TanStack Query**: `staleTime` を適切に設定し、不要なリクエストを防ぐ\n- **楽観的更新**: `onMutate` を活用して体感速度を向上させる',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'frontend', 'react', 'tanstack-query', 'typescript'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'react',
        'tanstack-query',
        'typescript',
        '計測: 推測で最適化せず、計測後に最適化する (react.memo 等) / tanstack query: staletime を適切に設定し、不要なリクエストを防ぐ',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', '*.json', '*.toml'],
      changeTypes: ['frontend', 'config'],
      technologies: ['typescript', 'react', 'tanstack-query'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/計測:-推測で最適化せず、計測後に最適化する-(react.memo-等)-/-tanstack-query:-staletime-を適切に設定し、不要なリクエストを防ぐ',
    },
  },
  {
    title: '詳細APIでの権限再検証ルール',
    content:
      '詳細API（getById, export, listChildren）でも必ず一覧APIと同一の権限再検証を行う。一覧で絞り込んでもID直接指定でのアクセスを防止するため。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['security', 'authorization'],
    category: 'security',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['security', 'authorization', '詳細apiでの権限再検証ルール'],
      severity: 'required',
      fileGlobs: ['src/**/routes/**'],
      changeTypes: ['api', 'auth'],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/詳細apiでの権限再検証ルール-1777368444609',
    },
  },
  {
    title:
      '重複禁止: 同じ意味・同じ表示結果になる文言を別キーで増やさない（DRY違反） / ファイル: src/locales/{en,ja}.json',
    content:
      "### 国際化 (i18n)\n- **ファイル**: `src/locales/{en,ja}.json`\n- **実装**:\n  - 基本: `const { t } = useTranslation(); <button>{t('save')}</button>`\n  - 名前空間: `const { t } = useTranslation('settings'); <span>{t('theme')}</span>`\n- **キー設計 (DRY最優先 / A: 画面非依存の再利用)**:\n  - **概念キー**: キーは「どの画面か」ではなく「何を意味するか」で命名する\n    - ✅ `language`, `timezone`, `number_format`, `current_value`\n    - ❌ `basic_settings_language`, `settings_timezone`, `config_number_format`\n  - **重複禁止**: 同じ意味・同じ表示結果になる文言を別キーで増やさない（DRY違反）\n    - ✅ 既存キーがあれば必ず流用する\n    - ✅ 文言が同じでも意味が違う場合のみ別キーを許可（例: \"Close\" = 閉じる/閉院 など）\n  - **ネスト最小**: 原則トップレベル。衝突回避や構造が必須な場合のみ浅いネストを許可\n    - ✅ `table.delete`, `markdown_editor.bold`\n    - ❌ `settings.basic.display.number.format.label` のような深いネスト\n  - **キー命名の目安**:\n    - **名詞/状態**: `language`, `timezone`, `none`, `left_to_right`\n    - **ラベル**: `{concept}_label`（例: `system_name_label`）\n    - **説明**: `{concept}_description`（例: `system_name_description`）\n    - **プレースホルダ**: `{concept}_placeholder`（例: `maintenance_message_placeholder`）",
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'frontend', 'react', 'i18next', 'i18n'],
    category: 'workflow',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'frontend',
        'react',
        'i18next',
        'i18n',
        '重複禁止: 同じ意味・同じ表示結果になる文言を別キーで増やさない（dry違反） / ファイル: src/locales/{en,ja}.json',
      ],
      severity: 'required',
      fileGlobs: ['apps/**', 'docs/**', '*.json', '*.toml'],
      changeTypes: ['frontend', 'docs', 'refactor', 'config'],
      technologies: ['react', 'i18next'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/重複禁止:-同じ意味・同じ表示結果になる文言を別キーで増やさない（dry違反）-/-ファイル:-src/locales/{en,ja}.json',
    },
  },
  {
    title: '非同期ジョブの終端状態管理ルール',
    content:
      '非同期ジョブは queued -> processing -> completed|failed の遷移を必須とし、completedAt と error を保持する。queued 状態で放置されることを防ぎ、運用監視を可能にするため。',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['async_job', 'observability'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: ['async_job', 'observability', '非同期ジョブの終端状態管理ルール'],
      severity: 'required',
      fileGlobs: [],
      changeTypes: [],
      technologies: [],
    },
    sourceIds: {
      entityId: 'rule/非同期ジョブの終端状態管理ルール-1777368444611',
    },
  },
  {
    title:
      '非同期処理: デバイス通信はRustバックエンドで行い、フロントエンドは非同期で受け取る。UIブロックは厳禁',
    content:
      '### Tauri & デバイス通信\n- **非同期処理**: デバイス通信はRustバックエンドで行い、フロントエンドは非同期で受け取る。UIブロックは厳禁',
    guidanceType: 'rule',
    scope: 'on_demand',
    priority: 80,
    tags: ['technology', 'language', 'rust', 'desktop', 'tauri'],
    category: 'coding_convention',
    appliesWhen: {
      intents: ['plan', 'edit', 'debug', 'review'],
      keywords: [
        'technology',
        'language',
        'rust',
        'desktop',
        'tauri',
        '非同期処理: デバイス通信はrustバックエンドで行い、フロントエンドは非同期で受け取る。uiブロックは厳禁',
      ],
      severity: 'required',
      fileGlobs: ['apps/**'],
      changeTypes: ['frontend'],
      technologies: ['rust'],
    },
    archiveKey: 'archive:content:83b75838a3dbbce6bc8270a7e20778eaeeee8ea1296ab25aafd71678377518f1',
    sourceIds: {
      entityId:
        'rule/非同期処理:-デバイス通信はrustバックエンドで行い、フロントエンドは非同期で受け取る。uiブロックは厳禁',
    },
  },
] as const satisfies readonly GuidanceRuleSeed[];
