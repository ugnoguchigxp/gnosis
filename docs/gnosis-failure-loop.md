# Gnosis: 失敗学習ループ (Failure Learning Loop) 運用ガイド

「失敗学習ループ」は、AIエージェントの試行錯誤を「資産」に変え、将来の生成精度を向上させるための仕組みです。

## 概要

エージェントがコード生成やタスク実行に失敗した際、その「症状（エラー内容）」と「原因（失敗タイプ）」を記録します。その後、タスクが成功した際に「成功したパッチや戦略」を同じシナリオIDで記録することで、Gnosis 内部で失敗と解決策が紐付けられます。

次回、同様のエラーが発生した際、Gnosis は類似した「過去の失敗」を見つけ出し、セットになっている「成功パッチ」を RAG コンテキストとして提供します。

## 記録スキーマ

`record_experience` ツール（または `record-experience.ts`）は以下の構造を受け取ります。

```json
{
  "sessionId": "llmharness-session-001",
  "scenarioId": "auth-fix-01",
  "attempt": 2,
  "type": "failure",
  "failureType": "RISK_BLOCKING",
  "content": "ERROR: type mismatch at line 45...",
  "metadata": {
    "riskFindings": [{ "id": "DG001", "message": "API change detected" }]
  }
}
```

## 教訓の検索と活用

`recall_lessons` ツールは現在の状況（エラー内容など）から類似の教訓を探します。

1.  **入力**: `ERROR: can't find symbol "User"`
2.  **処理**: 過去に `symbol not found` 系で失敗し、その後成功した事例をベクトル検索。
3.  **出力**: 同様の失敗を解決した「成功時のパッチ内容」や「修正方針」。

### CLI での確認方法

```bash
bun run src/scripts/recall-lessons.ts --session-id "llmharness" --query "符号エラーが発生"
```

## 保存・運用ポリシー

1.  **セッション分離**: `sessionId` を分けることで。特定プロジェクトの特殊な失敗事例が他プロジェクトへ汚染することを防ぎます。
2.  **データの精査**: 
    - `success` エントリは慎重に記録してください（`llmharness` では検証をパスしたパッチのみが対象となります）。
    - 役に立たなくなった古い教訓は、`experience_logs` テーブルから手動または定期クリーンアップスクリプト（未実装）で削除可能です。

## 再現手順の検証

1. 失敗を記録:
   `bun run src/scripts/record-experience.ts --session-id test --scenario-id s1 --type failure --content "Symbol A not found" --failure-type SYMBOL_MISSING`
2. 成功を記録:
   `bun run src/scripts/record-experience.ts --session-id test --scenario-id s1 --type success --content "Added import A to fix missing symbol"`
3. 類似ケースで検索:
   `bun run src/scripts/recall-lessons.ts --session-id test --query "Missing some symbols"`
4. 結果として "Added import A..." が返ってくることを確認。
