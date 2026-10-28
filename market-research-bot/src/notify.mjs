// 1メッセージあたりの文字数上限（Discordは2000字、Slackは長文が折りたたまれるため余裕を持たせる）
const MESSAGE_LIMITS = { slack: 3500, discord: 1900, generic: 3500 };

export function detectWebhookType(url) {
  const host = new URL(url).hostname;
  if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) return 'discord';
  if (host === 'hooks.slack.com') return 'slack';
  return 'generic';
}

function escapeSlack(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatArticle(article, type) {
  const heading =
    type === 'slack'
      ? `*<${article.link}|${escapeSlack(article.title)}>*`
      : type === 'discord'
        ? `**[${article.title.replace(/[[\]]/g, '')}](<${article.link}>)**` // <> でリンクのプレビュー展開を抑止
        : `${article.title}\n${article.link}`;
  const body = article.lines
    ? article.lines.map((line) => `・${type === 'slack' ? escapeSlack(line) : line}`).join('\n')
    : '・（要約に失敗しました。リンク先をご確認ください）';
  return `${heading}\n${body}\n_${article.source}_`;
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

async function post(url, type, text) {
  const payload = type === 'discord' ? { content: text } : { text };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const waitSec = Number(res.headers.get('retry-after')) || 2;
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      continue;
    }
    throw new Error(`Webhook送信に失敗しました: ${res.status} ${await res.text()}`);
  }
}

export function buildMessages({ type, dateLabel, articles, feedErrors }) {
  const header = articles.length
    ? `📰 *AI関連ニュース ${dateLabel}*（${articles.length}件）`
    : `📰 *AI関連ニュース ${dateLabel}*\n該当する新着記事はありませんでした。`;
  const blocks = articles.map((article) => formatArticle(article, type));
  if (feedErrors.length) {
    blocks.push(`⚠️ 取得に失敗したフィード:\n${feedErrors.map((e) => `・${e}`).join('\n')}`);
  }
  return chunkMessages(type === 'discord' ? header.replace(/\*/g, '**') : header, blocks, MESSAGE_LIMITS[type]);
}

export async function notify(webhookUrl, report) {
  const type = detectWebhookType(webhookUrl);
  for (const message of buildMessages({ type, ...report })) {
    await post(webhookUrl, type, message);
  }
}
