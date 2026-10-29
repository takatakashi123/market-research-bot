# market-research-bot

指定した複数メディアのRSSからAI関連ニュースを集め、Claudeで日本語3行に要約して、LINE / Gmail / Webhook（Slack・Discord）のいずれかに通知します。AWS Lambda上で、EventBridge Scheduler により1日1回実行します。

```
EventBridge Scheduler (毎日 9:00 JST)
  └─▶ Lambda (Node.js 22)
        ├─ RSS取得 → 過去24時間 & AI関連キーワードで絞り込み（候補）
        ├─ Claude が候補全体を読者の関心に沿って0〜5点で採点 → 3点以上を上位10件まで選定
        ├─ 選ばれた記事を1件ずつ3行要約（3並列）
        ├─ 選ばれた記事全体から「今日の見立て」を2〜3行で作成
        └─ NOTIFY_CHANNEL に応じて送信
             line    : LINE Messaging API（プッシュメッセージ）
             gmail   : Gmail SMTP（アプリパスワード）
             webhook : Slack / Discord（URLから自動判別）
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `template.yaml` | SAMテンプレート（Lambda、スケジュール、ロググループ、IAM） |
| `src/config.json` | **フィード一覧・キーワード・対象期間・最大件数** |
| `src/handler.mjs` | Lambdaのエントリポイント |
| `src/feeds.mjs` | RSSの取得とフィルタリング |
| `src/curate.mjs` | 記事の採点・選定と「今日の見立て」 |
| `src/summarize.mjs` | 記事ごとの3行要約 |
| `src/llm.mjs` | Claude API の呼び出し（JSONスキーマで出力形式を固定） |
| `src/notify.mjs` | LINE / Gmail / Webhook 向けの整形と送信 |
| `src/local.mjs` | ローカル実行用 |

## 設定（`src/config.json`）

- `feeds[].filter`: `false` はAI専門フィード（全記事を対象にする）、`true` は総合フィード（`keywords` に一致した記事だけを対象にする）
- `lookbackHours`: 何時間前までの記事を対象にするか（1日1回実行なら `24`）
- `maxCandidates`: 採点に回す候補の最大件数（新しい順）
- `selection`: **記事の選び方。ここを書き換えると、届くニュースが変わります**
  - `interest`: あなたが何を知りたいか（文章で）
  - `prefer` / `avoid`: 価値が高い記事・低い記事の例
  - `minScore`: この点数以上の記事だけを通知（0〜5。下げると件数が増え、上げると厳選されます）
  - `maxArticles`: 1日に通知する最大件数

### 選び方の調整のしかた

通知の各記事には「★★★★☆ 選定理由」が付きます。しばらく運用して、次のように調整してください。

- 不要な記事が多い → その種類を `avoid` に書き足す、または `minScore` を上げる
- 見たい記事が来ない → その種類を `prefer` に書き足す、または `minScore` を下げる
- 関心そのものが変わった → `interest` を書き換える

Lambda で動かしている場合は、変更後に `sam build && sam deploy` が必要です。

## ローカルで試す

```bash
cd market-research-bot/src
npm install

# 1) ドライラン: RSSの取得と絞り込みだけを確認（APIキー不要、送信もしない）
npm run dry-run

# 2) 本番と同じ動作: .env を作成してから実行（実際に通知が送信されます）
cp .env.example .env   # ANTHROPIC_API_KEY・NOTIFY_CHANNEL・通知先の認証情報を設定
npm start
```

## AWSへのデプロイ

前提: AWS CLI と SAM CLI がインストール済みで、認証の設定が済んでいること。

### 1. シークレットを作成（初回のみ）

APIキーとWebhook URLは、テンプレートや環境変数には書かず、Secrets Manager に保存します。

シークレットには、使う通知先の項目だけを入れます（項目の一覧は「通知先ごとの設定」を参照）。

```bash
# LINE の場合
aws secretsmanager create-secret --name market-research-bot \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-...","LINE_CHANNEL_ACCESS_TOKEN":"...","LINE_TO":"U..."}'

# Gmail の場合
aws secretsmanager create-secret --name market-research-bot \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-...","GMAIL_USER":"you@gmail.com","GMAIL_APP_PASSWORD":"abcdefghijklmnop","MAIL_TO":"you@example.com"}'
```

通知先の切り替えは、`sam deploy --guided` で聞かれる `NotifyChannel` パラメータ（`line` / `gmail` / `webhook`）で行います。

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

## 通知先ごとの設定

| NOTIFY_CHANNEL | 必要な項目 | 備考 |
|---|---|---|
| `line` | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_TO` | LINE Notify は2025年3月で終了したため、Messaging API を使います |
| `gmail` | `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `MAIL_TO`（省略すると自分宛て） | 2段階認証を有効にしたアカウントのアプリパスワードが必要です |
| `webhook` | `WEBHOOK_URL` | Slack / Discord は URL から自動で判別します |

### LINE：チャネルアクセストークンとユーザーIDの取得

1. [LINE Official Account Manager](https://manager.line.biz/) で公式アカウントを作成します（無料の「コミュニケーションプラン」で可）。
2. 公式アカウントの「設定」→「Messaging API」で **Messaging APIを利用する** を選び、プロバイダーを選択（または作成）します。
3. [LINE Developers コンソール](https://developers.line.biz/console/) を開き、作成されたチャネルを選びます。
   - **「チャネル基本設定」タブ** → 「あなたのユーザーID」（`U` から始まる33文字）→ `LINE_TO`
   - **「Messaging API設定」タブ** → 「チャネルアクセストークン（長期）」の **発行** → `LINE_CHANNEL_ACCESS_TOKEN`
4. 同じ「Messaging API設定」タブの QR コードから、公式アカウントを自分の LINE で友だち追加します（**友だち追加しないとメッセージは届きません**）。
5. 必要に応じて Official Account Manager の「応答設定」で、自動応答メッセージをオフにします。

無料プランで送れるのは月200通までです。通数は「プッシュのリクエスト数 × 送信先の人数」で数えます。このボットは1日1リクエストで最大5吹き出しをまとめて送るので、自分1人宛てなら月30通程度です。グループに送る場合は、ボットをグループに招待してください。送信先の人数ぶん通数が増えます。グループIDは Webhook のイベントから取得する必要があります。

### Gmail：アプリパスワードの取得

1. Googleアカウントの [セキュリティ](https://myaccount.google.com/security) で **2段階認証プロセス** を有効にします（アプリパスワードの作成に必須です）。
2. [アプリパスワード](https://myaccount.google.com/apppasswords) を開き、アプリ名（例：`market-research-bot`）を入力して **作成** します。
3. 表示された16文字のパスワードを `GMAIL_APP_PASSWORD` に設定します。表示はこの1回だけで、スペースは入れても入れなくても構いません。
4. `GMAIL_USER` には、そのアカウントの Gmail アドレスを設定します。

アプリパスワードはアカウントの全権限を持つので、必ず Secrets Manager か `.env` にだけ保存してください。不要になったら同じ画面から削除できます。なお Google Workspace のアカウントでは、管理者の設定によってアプリパスワードが使えない場合があります。

## 運用メモ

- **実行時刻**: `ScheduleExpression` / `ScheduleTimezone` パラメータで変更できます（既定は毎日9:00 JST）。
- **重複通知の防止**: Lambdaの非同期リトライと、Schedulerのリトライはどちらも0回にしています。失敗した日は通知されないので、CloudWatch Logs で確認してください。
- **要約の元データ**: RSSに含まれる概要（または本文）だけを要約します。概要しか配信しないフィードでは、要約もその範囲になります。
- **モデル**: 既定は `claude-opus-5-5`。採点と見立ては `effort: medium`、要約は `effort: low` です。費用を下げたい場合は `ModelId` パラメータで変更できます。
- **採点に失敗した日**: 新しい順の記事で代用して通知し、その旨を通知内に表示します。
- **拒否時のフォールバック**: 安全分類器がリクエストを拒否した場合に、サーバー側で推奨モデルへ自動的に切り替える `fallbacks: "default"` を有効にしています。
- **費用の目安**: 1日あたり、採点1回 + 要約最大 `selection.maxArticles` 回 + 見立て1回のAPI呼び出しです。Lambdaの実行時間は1〜2分程度です。
