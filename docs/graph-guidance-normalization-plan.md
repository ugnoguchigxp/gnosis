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
bun run graph:normalize --apply
bun run graph:communities --deterministic-summary
```

`graph:normalize` は dry-run を既定にしており、`--apply` を付けない限り DB を変更しません。

## 間引きの基準

同じ内容の entity は import 時点で作りません。

十分近いが完全一致ではない entity は、すぐに削除しません。まず `similar_to` または `same_principle_as` として graph 上で近づけます。

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

