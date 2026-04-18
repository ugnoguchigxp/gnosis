# データレイヤー (Data Layers)

Gnosis フロントエンドにおけるデータアクセスの核となるアーキテクチャについて説明します。

## 概要

Gnosis では、データの永続化や取得を抽象化するために**アダプターパターン**を採用しています。これにより、フロントエンドのロジックを特定のデータストレージ（メモリ、ローカルストレージ、あるいはスマートコントラクトなど）から分離し、柔軟な切り替えを可能にしています。

その中心となるのが `MainGraphAdapter` インターフェースです。

---

## MainGraphAdapter

`MainGraphAdapter` は、Gnosis のデータ構造（ドメイン、プロジェクト、データポイント、リンク）にアクセスするための標準的なメソッドを定義するインターフェースです。

```typescript
/**
 * Gnosis のデータ操作を抽象化するメインインターフェース
 */
export interface MainGraphAdapter {
  /** ドメイン（スキーマ）の一覧を取得 */
  getDomains(): Promise<Domain[]>;
  /** 特定のドメインを取得 */
  getDomain(name: string): Promise<Domain | undefined>;
  
  /** プロジェクトの一覧を取得 */
  listProjects(): Promise<Project[]>;
  /** 特定のプロジェクトを取得 */
  getProject(id: string): Promise<Project | undefined>;
  /** プロジェクトを新規作成 */
  createProject(project: Project): Promise<Project>;
  
  /** 指定されたプロジェクト内のエントリ（データポイント）を取得 */
  getProjectEntries(projectId: string): Promise<DataViewPoint[]>;
  /** プロジェクト内にエントリを追加 */
  addProjectEntry(projectId: string, entry: DataViewPoint): Promise<DataViewPoint>;
  
  /** 指定されたプロジェクト内のリンクを取得 */
  getProjectLinks(projectId: string): Promise<ProjectLink[]>;
  /** プロジェクト内にリンクを追加 */
  addProjectLink(projectId: string, link: ProjectLink): Promise<ProjectLink>;
}
```

---

## MemoryGraphAdapter

`MemoryGraphAdapter` は、`MainGraphAdapter` のインメモリ実装です。データの永続化を行わず、ブラウザのメモリ（`Map` や `Array`）上でデータを保持します。

### 特徴
- **高速性**: 通信が発生しないため、開発やテスト、プロトタイプ開発に最適です。
- **リセット可能性**: ページのリロードにより初期状態に戻ります。
- **デモ用途**: サーバー設定なしでフロントエンドの機能をフルに体験できます。

### 実装の詳細

以下は `MemoryGraphAdapter` の主要なロジック構成です。

#### 1. データ保持
`Map<string, Project>` を使用して、プロジェクトIDをキーにデータを管理します。

#### 2. メソッドの実装例

```typescript
/**
 * メモリ上でデータを管理する MainGraphAdapter の実装クラス
 */
export class MemoryGraphAdapter implements MainGraphAdapter {
  private projects: Map<string, Project> = new Map();
  private schema: Domain[] = [];

  constructor(initialSchema: Domain[] = []) {
    this.schema = initialSchema;
  }

  /**
   * プロジェクトを新規作成し、初期状態をセットアップします
   * @param project 作成するプロジェクトデータ
   * @returns 作成されたプロジェクト
   */
  async createProject(project: Project): Promise<Project> {
    if (this.projects.has(project.id)) {
      throw new Error(`Project ${project.id} already exists`);
    }
    const newProject = {
      ...project,
      entries: project.entries || [],
      links: project.links || [],
    };
    this.projects.set(project.id, newProject);
    return newProject;
  }

  /**
   * 特定のエントリ（データポイント）を削除します。
   * 関連するリンクも自動的に削除（連鎖削除）します。
   * @param projectId 所属プロジェクトID
   * @param entryId 削除対象のエントリID
   */
  async deleteProjectEntry(projectId: string, entryId: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("Project not found");
    
    // エントリの削除
    project.entries = project.entries.filter((e) => e.id !== entryId);
    
    // 関連するリンクの削除
    project.links = project.links.filter(
      (l) => l.source !== entryId && l.target !== entryId
    );
  }
}
```

---

## 使用方法

フロントエンドのアプリケーション、またはプロバイダーコンテキストで以下のように初期化します。

```typescript
// スキーマ（ドメイン定義）を渡してインスタンス化
const adapter = new MemoryGraphAdapter(myInitialSchema);

// アプリケーション全体でこの adapter を使用する
const projects = await adapter.listProjects();
```

## 今後の拡張

現在、この `MemoryGraphAdapter` は開発環境のモックとして機能していますが、同様のインターフェースを持つ `LocalStorageGraphAdapter` や `SmartContractGraphAdapter` を実装することで、コードの大幅な変更なしに永続化レイヤーを変更することが可能です。
