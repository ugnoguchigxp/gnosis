# Guidance Graph Normalization Plan

Gnosis の guidance import は、ルールファイルの構造によって「1つの entity に複数のルールが詰め込まれる」ことがあります。Graph 上では、この状態のまま similarity や community を作ると、logging、型、i18n、storage など別々の概念が同じノードに引きずられます。

この計画では、似すぎている guidance を単純に増やすのではなく、同じ概念は統合し、別概念は独立した entity に分けます。

## 基本方針

同じ意味の entity は canonical entity に統合します。たとえば `console.log` 禁止、`logger` 使用必須、`log.info/log.warn/log.error` の使い分けは、最終的に `console.log禁止とlogger使用必須` へ集約します。

一方で、複合 entity に含まれている別概念は canonical に混ぜません。`any禁止`、`i18next必須`、`Schema-First必須`、`localStorage使用制限` のような要素は、それぞれ独立 entity として登録します。

元の複合 entity は、分割と統合が完了したら削除します。新しい entity の metadata には `splitFromEntityIds` や `mergedEntityIds` を残し、どの entity から生まれたかを追跡できるようにします。

## 実行タイミング

登録時は exact dedupe を行います。本文を正規化した hash が一致する場合は新規 entity を作らず、既存 entity の `sources`、`projects`、`guidanceDedupeKeys` を更新します。

semantic な統合や複合 entity の分割は、登録時にすべて行いません。embedding 比較やルール構造の解釈は重いため、バッチとして実行します。

現在のバッチは次の順序で使います。

```bash
bun run graph:dedupe --apply
bun run graph:seed-concepts --apply
bun run graph:normalize --apply
bun run graph:communities --deterministic-summary
```

`graph:normalize` は dry-run を既定にしており、`--apply` を付けない限り DB を変更しません。

## 技術コンセプト辞書

Graph の距離感を rule 同士の embedding だけに任せると、TypeScript の規約、React の規約、Terraform の規約、CI/CD の規約が同じ「開発ルール」として近づきすぎることがあります。そこで、Gnosis は大きめの技術トピックを `concept` entity として seed します。

初期辞書は `src/knowledge/technologyConcepts.ts` に置きます。これはユーザーが全候補を手作業で管理するための一覧ではなく、Graph の軸になる最小限の地図です。現在は Java、Rust、Python、Go、TypeScript、React、Zod、Biome、Terraform、GitHub Actions、CI/CD、Docker、Kubernetes、AWS、Azure、PostgreSQL、Vitest、Playwright などを含みます。`terraforma` のような表記ゆれも Terraform に寄せます。

`graph:seed-concepts --apply` は、この辞書から `concept` entity を登録します。`graph:normalize --apply` は guidance の本文と title から技術を推定し、metadata の `applicability.technologies` / `applicability.languages` を更新し、`applies_to_technology` relation を張ります。

seed concept 同士にも、最初から関係を張ります。たとえば TypeScript は JavaScript に `builds_on_technology`、Node.js と Bun は JavaScript/TypeScript に `runtime_for_technology`、Bun は Node.js に `alternative_runtime_to`、React は TypeScript/JavaScript に `framework_for_technology`、Next.js は React に `builds_on_technology` で接続します。

Python と Rust も、よく使う ecosystem を初期 concept として持ちます。Python は NumPy、pandas、SciPy、Pydantic、FastAPI、Django、Flask、SQLAlchemy、pytest、Ruff、Black、mypy、Poetry を Python concept に接続します。Rust は Cargo、Clippy、rustfmt、Tokio、Axum、Actix Web、Serde、SQLx を Rust concept に接続します。Terraform、GitHub Actions、CI/CD、Docker、Kubernetes、AWS/Azure/GCP なども、IaC、CI/CD、container、cloud の大きな軸で最初から近くなるように relation を持たせます。

この relation は検索抑制にも使う前提です。たとえば Zod や `import.meta.env` は TypeScript/Zod の concept に接続されるため、Python プロジェクトの文脈では優先度を下げられます。一方、言語に依存しないルールは特定言語へ無理に接続しません。

重要なのは、技術辞書で rule を作らないことです。辞書は「TypeScript」「Rust」「Terraform」のような大きな概念だけを seed し、実際の開発規約は従来通り rule / lesson / procedure として別 entity にします。

## 1トピック1ルール

Project settings のような複合 rule は、Graph 上では扱いにくい単位です。たとえば「TypeScriptを使う」「JSDocコメントは日本語」「Biomeのフォーマット」「パスエイリアス」「環境変数はZodで検証」は、同じプロジェクト設定に見えても質問時の適用条件が違います。

`graph:normalize` は、このような安全に分割できる複合 rule を個別 entity に分けます。分割後の rule には `splitFromEntityIds` を残すため、元の登録元は追跡できます。逆に、手順書や長い運用ルールは誤分割のリスクが高いため、明示的な target pattern に入るまでは自動分割しません。

## 間引きの基準

同じ内容の entity は import 時点で作りません。

十分近いが完全一致ではない entity は、すぐに削除しません。まず `similar_to` または `same_principle_as` として graph 上で近づけます。

しきい値は次の段階で扱います。

- `normalizedContentHash` が一致: import 時点で重複として統合する
- cosine similarity `0.96` 以上: 重複候補。ただし自動削除はせず、title anchor と本文差分を確認して canonical 統合対象にする
- cosine similarity `0.94` 以上: `same_principle_as`。同じ実践を別表現で述べている可能性が高い層。共通 anchor が2つ以上ある場合に張る
- cosine similarity `0.86` 以上: `similar_to`。同じ概念圏にあるが、別 rule として残す層。共通 anchor が2つ以上ある場合に張る
- 共通 anchor が1つだけの場合: cosine similarity `0.92` 以上の場合だけ `similar_to` を張る。単語が1つ一致しただけのノイズを避けるため
- 技術適用関係: similarity ではなく `applies_to_technology` で張る。TypeScript の rule は TypeScript concept に接続し、React/Zod/Biome なども別 concept として接続する

`archive` や import 元 document は意味的な近さではありません。Graph 可視化では `contains_guidance` を主 graph から除外し、rule、lesson、procedure、concept など実体同士の relation を中心に表示します。

ただし、次の条件を満たす場合は canonical への統合対象にします。

- title と本文が同じ実践を指している
- 別 entity として残しても検索結果の選択肢が増えるだけで、判断材料が増えない
- 複合 entity の一部であり、他の要素を巻き込んで similarity を歪めている

この判断は anchor ごとに明示的に実装します。現時点では `logging` と `any/unknown` を canonical cluster として扱います。新しい cluster を増やす場合は、誤統合を避けるために対象 title pattern と除外 pattern を先に追加します。

## 今回の正規化

`console.log禁止 / any禁止` の複合 entity は削除し、内容を次に分けました。

- `console.log禁止とlogger使用必須` へ logging ルールを統合
- `any禁止とunknown利用` へ any/unknown ルールを統合
- i18n、Schema-First、TanStack Query、magic number、responsive、state、localStorage、Server Components は個別 entity 化

`必須コーディング規約 / TypeScript strict any禁止` の複合 entity も削除し、any/unknown は canonical に統合し、それ以外の運用ルールは個別 entity 化しました。
