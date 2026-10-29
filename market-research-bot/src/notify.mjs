import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';

// 通知先: NOTIFY_CHANNEL=line | gmail | webhook（Slack/Discord）
export const CHANNELS = ['line', 'gmail', 'webhook'];

// LINEのテキストメッセージは1件5000字まで、1リクエスト5件まで
const LINE_TEXT_LIMIT = 5000;
const LINE_MESSAGES_PER_PUSH = 5;
// Webhookの1メッセージあたりの文字数上限（Discordは2000字、Slackは長文が折りたたまれるため余裕を持たせる）
const WEBHOOK_LIMITS = { slack: 3500, discord: 1900, generic: 3500 };

const NO_SUMMARY = '（要約に失敗しました。リンク先をご確認ください）';

function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`通知に必要な設定がありません: ${missing.join(', ')}`);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function headline({ dateLabel, articles, candidateCount = articles.length }) {
  if (articles.length) return `AI関連ニュース ${dateLabel}（候補${candidateCount}件から${articles.length}件）`;
  return candidateCount
    ? `AI関連ニュース ${dateLabel}：候補${candidateCount}件のうち、基準を満たす記事はありませんでした`
    : `AI関連ニュース ${dateLabel}：新着記事はありませんでした`;
}

function stars(score) {
  return '★'.repeat(score) + '☆'.repeat(5 - score);
}

// 「★★★★☆ 選定理由」の1行。採点していない場合は空文字
function selectionLine(article) {
  if (article.score == null) return '';
  return article.reason ? `${stars(article.score)} ${article.reason}` : stars(article.score);
}

// 本文の前に置く「今日の見立て」と注記
function preface(report, { bullet = '・', bold = (s) => s } = {}) {
  const parts = [];
  if (report.overview?.length) {
    parts.push(`🔭 ${bold('今日の見立て')}\n${report.overview.map((line) => `${bullet}${line}`).join('\n')}`);
  }
  if (report.note) parts.push(report.note);
  return parts;
}

// 記事の途中で切れないよう、記事単位でメッセージを分割する
function chunkMessages(header, blocks, limit) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + block.length + 2 > limit) {
      messages.push(current);
      current = block.slice(0, limit);
    } else {
      current += `\n\n${block}`;
    }
  }
  messages.push(current);
  return messages;
}

async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      const waitSec = Number(res.headers.get('retry-after')) || 2;
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      continue;
    }
    throw new Error(`送信に失敗しました: ${res.status} ${await res.text()}`);
  }
}

// ---- LINE（Messaging API のプッシュメッセージ） ----

export function buildLineMessages(report) {
  const blocks = [
    ...preface(report),
    ...report.articles.map((article) =>
      [
        `■ ${article.title}`,
        selectionLine(article),
        ...(article.lines ?? [NO_SUMMARY]).map((line) => `・${line}`),
        `${article.source}｜${article.link}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ];
  if (report.feedErrors.length) {
    blocks.push(`⚠ 取得に失敗したフィード\n${report.feedErrors.map((e) => `・${e}`).join('\n')}`);
  }
  return chunkMessages(`📰 ${headline(report)}`, blocks, LINE_TEXT_LIMIT);
}

async function sendLine(env, report) {
  requireEnv(env, ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_TO']);
  const texts = buildLineMessages(report);
  // 1リクエストで最大5吹き出し。料金上の通数は「リクエスト数×送信先人数」で数えられる
  for (let i = 0; i < texts.length; i += LINE_MESSAGES_PER_PUSH) {
    await fetchWithRetry('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        // リトライ時に同じメッセージが二重送信されないようにする
        'X-Line-Retry-Key': randomUUID(),
      },
      body: JSON.stringify({
        to: env.LINE_TO,
        messages: texts.slice(i, i + LINE_MESSAGES_PER_PUSH).map((text) => ({ type: 'text', text })),
      }),
    });
  }
}

// ---- Gmail（SMTP + アプリパスワード） ----

export function buildEmail(report) {
  const subject = headline(report);

  const text = [
    subject,
    ...preface(report),
    ...report.articles.map((article) =>
      [
        `■ ${article.title}`,
        selectionLine(article),
        ...(article.lines ?? [NO_SUMMARY]).map((line) => `・${line}`),
        `${article.source} ${article.link}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    ...(report.feedErrors.length ? [`取得に失敗したフィード:\n${report.feedErrors.join('\n')}`] : []),
  ].join('\n\n');

  const articleHtml = report.articles
    .map(
      (article) => `
      <div style="margin:0 0 20px;padding:0 0 16px;border-bottom:1px solid #e5e5e5">
        <a href="${escapeHtml(article.link)}" style="font-size:16px;font-weight:bold;color:#1a0dab;text-decoration:none">${escapeHtml(article.title)}</a>
        ${selectionLine(article) ? `<div style="margin-top:4px;font-size:13px;color:#b8860b">${escapeHtml(selectionLine(article))}</div>` : ''}
        <ul style="margin:8px 0;padding-left:20px;color:#333;line-height:1.6">
          ${(article.lines ?? [NO_SUMMARY]).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
        </ul>
        <div style="font-size:12px;color:#777">${escapeHtml(article.source)}</div>
      </div>`,
    )
    .join('');
  const errorHtml = report.feedErrors.length
    ? `<p style="font-size:12px;color:#b00">取得に失敗したフィード:<br>${report.feedErrors.map(escapeHtml).join('<br>')}</p>`
    : '';
  const overviewHtml = report.overview?.length
    ? `<div style="margin:0 0 24px;padding:12px 16px;background:#f4f7fb;border-left:4px solid #4a78c2">
        <div style="font-weight:bold;margin-bottom:6px">🔭 今日の見立て</div>
        ${report.overview.map((line) => `<div style="line-height:1.7">・${escapeHtml(line)}</div>`).join('')}
      </div>`
    : '';
  const noteHtml = report.note ? `<p style="font-size:12px;color:#b00">${escapeHtml(report.note)}</p>` : '';
  const html = `
    <div style="max-width:640px;font-family:sans-serif">
      <h2 style="font-size:18px">📰 ${escapeHtml(subject)}</h2>
      ${overviewHtml}
      ${noteHtml}
      ${articleHtml}
      ${errorHtml}
    </div>`;

  return { subject, text, html };
}

async function sendGmail(env, report) {
  requireEnv(env, ['GMAIL_USER', 'GMAIL_APP_PASSWORD']);
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: env.GMAIL_USER,
      // Googleの画面ではスペース区切りで表示されるため、スペースを除去する
      pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
    },
  });
  await transporter.sendMail({
    from: `"AIニュースBot" <${env.GMAIL_USER}>`,
    to: env.MAIL_TO || env.GMAIL_USER, // 未指定なら自分宛て。カンマ区切りで複数指定可
    ...buildEmail(report),
  });
}

// ---- Webhook（Slack / Discord） ----

export function detectWebhookType(url) {
  const host = new URL(url).hostname;
  if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) return 'discord';
  if (host === 'hooks.slack.com') return 'slack';
  return 'generic';
}

function escapeSlack(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatWebhookArticle(article, type) {
  const heading =
    type === 'slack'
      ? `*<${article.link}|${escapeSlack(article.title)}>*`
      : type === 'discord'
        ? `**[${article.title.replace(/[[\]]/g, '')}](<${article.link}>)**` // <> でリンクのプレビュー展開を抑止
        : `${article.title}\n${article.link}`;
  const escape = (text) => (type === 'slack' ? escapeSlack(text) : text);
  const body = (article.lines ?? [NO_SUMMARY]).map((line) => `・${escape(line)}`).join('\n');
  const selection = selectionLine(article);
  return [heading, selection && escape(selection), body, `_${article.source}_`].filter(Boolean).join('\n');
}

export function buildWebhookMessages(type, report) {
  const bold = type === 'discord' ? '**' : '*';
  const escape = (text) => (type === 'slack' ? escapeSlack(text) : text);
  const escapedReport = {
    ...report,
    overview: report.overview?.map(escape),
    note: report.note && escape(report.note),
  };
  const blocks = [
    ...preface(escapedReport, { bold: (s) => `${bold}${s}${bold}` }),
    ...report.articles.map((article) => formatWebhookArticle(article, type)),
  ];
  if (report.feedErrors.length) {
    blocks.push(`⚠️ 取得に失敗したフィード:\n${report.feedErrors.map((e) => `・${e}`).join('\n')}`);
  }
  return chunkMessages(`📰 ${bold}${headline(report)}${bold}`, blocks, WEBHOOK_LIMITS[type]);
}

async function sendWebhook(env, report) {
  requireEnv(env, ['WEBHOOK_URL']);
  const type = detectWebhookType(env.WEBHOOK_URL);
  for (const text of buildWebhookMessages(type, report)) {
    await fetchWithRetry(env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(type === 'discord' ? { content: text } : { text }),
    });
  }
}

// ---- 共通 ----

export function resolveChannel(env) {
  const channel = (env.NOTIFY_CHANNEL || 'webhook').toLowerCase();
  if (!CHANNELS.includes(channel)) {
    throw new Error(`NOTIFY_CHANNEL は ${CHANNELS.join(' / ')} のいずれかを指定してください: ${channel}`);
  }
  return channel;
}

// ドライラン用: 実際には送らず、送信予定の内容を文字列で返す
export function previewNotification(env, report) {
  const channel = resolveChannel(env);
  if (channel === 'line') return buildLineMessages(report);
  if (channel === 'gmail') {
    const { subject, text } = buildEmail(report);
    return [`件名: ${subject}\n\n${text}`];
  }
  return buildWebhookMessages(env.WEBHOOK_URL ? detectWebhookType(env.WEBHOOK_URL) : 'slack', report);
}

/**
 * @param env    NOTIFY_CHANNEL と各チャネルの認証情報を含むオブジェクト
 * @param report {
 *   dateLabel, candidateCount, overview: string[]|null, note?: string,
 *   articles: [{ title, link, source, score?, reason?, lines|null }], feedErrors: string[]
 * }
 */
export async function notify(env, report) {
  const channel = resolveChannel(env);
  if (channel === 'line') await sendLine(env, report);
  else if (channel === 'gmail') await sendGmail(env, report);
  else await sendWebhook(env, report);
  return channel;
}
