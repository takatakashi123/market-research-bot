import { readFileSync } from 'node:fs';
import { fetchArticles } from './feeds.mjs';
import { createLlm } from './llm.mjs';
import { summarizeArticle } from './summarize.mjs';
import { selectArticles, writeOverview } from './curate.mjs';
import { notify, previewNotification } from './notify.mjs';

const DEFAULT_MODEL = 'claude-opus-5-5';
const SUMMARY_CONCURRENCY = 3;

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

let cachedEnv;

// 環境変数に、Secrets Manager のシークレット（JSON）の値を重ねて返す。
// ローカルでは SECRET_ID を設定せず、.env の値だけを使う
async function loadEnv() {
  if (cachedEnv) return cachedEnv;
  let secret = {};
  if (process.env.SECRET_ID) {
    // Lambdaのランタイムに同梱されているSDKを使う
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const res = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }),
    );
    secret = JSON.parse(res.SecretString);
  }
  cachedEnv = { ...process.env, ...secret };
  return cachedEnv;
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
  const { selection } = config;
  const candidates = articles.slice(0, config.maxCandidates);
  console.log(`取得: ${articles.length}件 / 採点対象: ${candidates.length}件 / フィードエラー: ${feedErrors.length}件`);
  feedErrors.forEach((e) => console.warn(`[feed error] ${e}`));

  // ドライラン: LLMも通知も呼ばず、新しい順の記事で送信予定のメッセージを表示する
  if (dryRun) {
    const preview = candidates.slice(0, selection.maxArticles).map((a) => ({
      ...a,
      score: 3,
      reason: '（ドライラン）',
      lines: [`（ドライラン）${a.body.slice(0, 60) || a.title}`, '-', '-'],
    }));
    const report = {
      dateLabel,
      candidateCount: candidates.length,
      overview: ['（ドライラン）今日の見立てがここに入ります'],
      articles: preview,
      feedErrors,
    };
    for (const message of previewNotification(process.env, report)) {
      console.log(`----\n${message}`);
    }
    return { fetched: articles.length, summarized: 0, dryRun: true };
  }

  const env = await loadEnv();
  const llm = createLlm({ apiKey: env.ANTHROPIC_API_KEY, model: env.MODEL || DEFAULT_MODEL });

  // 1) 読者の関心に沿って採点・選定。失敗した日は新しい順で代用して通知は止めない
  let selected = [];
  let note = '';
  if (candidates.length) {
    try {
      selected = await selectArticles(llm, candidates, selection);
      console.log(`選定: ${selected.length}件 (${selected.map((a) => a.score).join(',')})`);
    } catch (err) {
      console.error(`[select error] ${err.message}`);
      selected = candidates.slice(0, selection.maxArticles);
      note = '※ 記事の採点に失敗したため、新しい順に表示しています';
    }
  }

  // 2) 選ばれた記事を要約
  const summarized = await mapWithConcurrency(selected, SUMMARY_CONCURRENCY, async (article) => {
    try {
      return { ...article, lines: await summarizeArticle(llm, article) };
    } catch (err) {
      console.error(`[summarize error] ${article.link}: ${err.message}`);
      return { ...article, lines: null };
    }
  });

  // 3) 今日の見立て
  let overview = null;
  if (summarized.some((a) => a.lines)) {
    try {
      overview = await writeOverview(llm, summarized, selection);
    } catch (err) {
      console.error(`[overview error] ${err.message}`);
    }
  }

  const channel = await notify(env, {
    dateLabel,
    candidateCount: candidates.length,
    overview,
    note,
    articles: summarized,
    feedErrors,
  });
  const ok = summarized.filter((a) => a.lines).length;
  console.log(`通知完了 (${channel}): 要約成功 ${ok}/${summarized.length}件`);
  return { fetched: articles.length, selected: summarized.length, summarized: ok };
}
