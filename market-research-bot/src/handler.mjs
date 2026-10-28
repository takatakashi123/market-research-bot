import { readFileSync } from 'node:fs';
import { fetchArticles } from './feeds.mjs';
import { createSummarizer } from './summarize.mjs';
import { notify, buildMessages, detectWebhookType } from './notify.mjs';

const DEFAULT_MODEL = 'claude-opus-5-5';
const SUMMARY_CONCURRENCY = 3;

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

let cachedSecrets;

// Lambda上では Secrets Manager から、ローカルでは環境変数から読み込む
async function loadSecrets() {
  if (cachedSecrets) return cachedSecrets;
  if (!process.env.SECRET_ID) {
    cachedSecrets = {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      webhookUrl: process.env.WEBHOOK_URL,
    };
  } else {
    // Lambdaのランタイムに同梱されているSDKを使う
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const res = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }),
    );
    const secret = JSON.parse(res.SecretString);
    cachedSecrets = { anthropicApiKey: secret.ANTHROPIC_API_KEY, webhookUrl: secret.WEBHOOK_URL };
  }
  if (!cachedSecrets.webhookUrl) throw new Error('WEBHOOK_URL が設定されていません');
  return cachedSecrets;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function handler(event = {}) {
  const dryRun = event.dryRun === true || process.env.DRY_RUN === '1';
  const since = new Date(Date.now() - config.lookbackHours * 60 * 60 * 1000);
  const dateLabel = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date());

  const { articles, errors: feedErrors } = await fetchArticles({
    feeds: config.feeds,
    keywords: config.keywords,
    since,
  });
  const targets = articles.slice(0, config.maxArticles);
  console.log(`取得: ${articles.length}件 / 要約対象: ${targets.length}件 / フィードエラー: ${feedErrors.length}件`);
  feedErrors.forEach((e) => console.warn(`[feed error] ${e}`));

  // ドライラン: LLMもWebhookも呼ばず、送信予定のメッセージを表示する
  if (dryRun) {
    const preview = targets.map((a) => ({ ...a, lines: [`（ドライラン）${a.body.slice(0, 60) || a.title}`, '-', '-'] }));
    for (const message of buildMessages({ type: 'slack', dateLabel, articles: preview, feedErrors })) {
      console.log(`----\n${message}`);
    }
    return { fetched: articles.length, summarized: 0, dryRun: true };
  }

  const { anthropicApiKey, webhookUrl } = await loadSecrets();
  const summarize = createSummarizer({ apiKey: anthropicApiKey, model: process.env.MODEL || DEFAULT_MODEL });

  const summarized = await mapWithConcurrency(targets, SUMMARY_CONCURRENCY, async (article) => {
    try {
      return { ...article, lines: await summarize(article) };
    } catch (err) {
      console.error(`[summarize error] ${article.link}: ${err.message}`);
      return { ...article, lines: null };
    }
  });

  await notify(webhookUrl, { dateLabel, articles: summarized, feedErrors });
  const ok = summarized.filter((a) => a.lines).length;
  console.log(`通知完了 (${detectWebhookType(webhookUrl)}): 要約成功 ${ok}/${summarized.length}件`);
  return { fetched: articles.length, summarized: ok };
}
