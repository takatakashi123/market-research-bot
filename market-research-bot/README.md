# market-research-bot

指定した複数メディアのRSSからAI関連ニュースを集め、Claudeで日本語3行に要約して、Slack / Discord のWebhookに通知します。AWS Lambda上で、EventBridge Scheduler により1日1回実行します。

```
EventBridge Scheduler (毎日 9:00 JST)
  └─▶ Lambda (Node.js 22)
        ├─ RSS取得 → 過去24時間 & AI関連キーワードで絞り込み
        ├─ Claude API で1記事ずつ3行要約（3並列）
        └─ Webhook へ送信（Slack / Discord はURLから自動判別）
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `template.yaml` | SAMテンプレート（Lambda、スケジュール、ロググループ、IAM） |
| `src/config.json` | **フィード一覧・キーワード・対象期間・最大件数** |
| `src/handler.mjs` | Lambdaのエントリポイント |
| `src/feeds.mjs` | RSSの取得とフィルタリング |
| `src/summarize.mjs` | Claudeによる要約（JSONスキーマで3行に固定した出力） |
| `src/notify.mjs` | Slack / Discord 向けの整形と送信 |
| `src/local.mjs` | ローカル実行用 |

## 設定（`src/config.json`）

- `feeds[].filter`: `false` はAI専門フィード（全記事を対象にする）、`true` は総合フィード（`keywords` に一致した記事だけを対象にする）
- `lookbackHours`: 何時間前までの記事を対象にするか（1日1回実行なら `24`）
- `maxArticles`: 1回に要約する最大件数（API費用の上限になります）

## ローカルで試す

```bash
cd market-research-bot/src
npm install

# 1) ドライラン: RSSの取得と絞り込みだけを確認（APIキー不要、送信もしない）
npm run dry-run

# 2) 本番と同じ動作: .env を作成してから実行（実際にWebhookへ送信されます）
cp .env.example .env   # ANTHROPIC_API_KEY と WEBHOOK_URL を設定
npm start
```

## AWSへのデプロイ

前提: AWS CLI と SAM CLI がインストール済みで、認証の設定が済んでいること。

### 1. シークレットを作成（初回のみ）

APIキーとWebhook URLは、テンプレートや環境変数には書かず、Secrets Manager に保存します。

```bash
aws secretsmanager create-secret \
  --name market-research-bot \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-...","WEBHOOK_URL":"https://hooks.slack.com/services/..."}'
```

あとで値を変えるときは `aws secretsmanager put-secret-value --secret-id market-research-bot --secret-string '...'` を使います。

### 2. ビルドとデプロイ

```bash
cd market-research-bot
sam build
sam deploy --guided   # 初回のみ対話形式。2回目以降は sam deploy だけでOK
```

### 3. 動作確認（スケジュールを待たずに実行）

```bash
aws lambda invoke --function-name <Outputs の FunctionName> out.json && cat out.json
sam logs --stack-name <スタック名> --tail
```

## 運用メモ

- **実行時刻**: `ScheduleExpression` / `ScheduleTimezone` パラメータで変更できます（既定は毎日9:00 JST）。
- **重複通知の防止**: Lambdaの非同期リトライと、Schedulerのリトライはどちらも0回にしています。失敗した日は通知されないので、CloudWatch Logs で確認してください。
- **要約の元データ**: RSSに含まれる概要（または本文）だけを要約します。概要しか配信しないフィードでは、要約もその範囲になります。
- **モデル**: 既定は `claude-opus-5-5`（`effort: low`）。費用を下げたい場合は `ModelId` パラメータで変更できます。
- **拒否時のフォールバック**: 安全分類器がリクエストを拒否した場合に、サーバー側で推奨モデルへ自動的に切り替える `fallbacks: "default"` を有効にしています。
- **費用の目安**: 1日最大 `maxArticles` 回のAPI呼び出しです。Lambdaの実行時間は数十秒程度です。
