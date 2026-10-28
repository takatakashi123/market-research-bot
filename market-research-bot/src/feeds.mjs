import Parser from 'rss-parser';

// 1記事あたりLLMに渡す本文の上限（RSSに全文が入っているフィードでのコスト抑制用）
const MAX_BODY_CHARS = 6000;

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'market-research-bot/1.0 (+RSS reader)' },
});

// ASCIIのキーワードは単語境界で判定（"AI" が "MAIL" にマッチしないように）
function buildMatcher(keywords) {
  const patterns = keywords.map((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[\x20-\x7E]+$/.test(keyword) ? `\\b${escaped}\\b` : escaped;
  });
  const regex = new RegExp(patterns.join('|'), 'i');
  return (text) => regex.test(text);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function normalizeText(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 全フィードを並列取得し、期間内かつAI関連の記事を新しい順で返す。
 * 一部のフィードが失敗しても処理は続け、失敗内容は errors に入れる。
 */
export async function fetchArticles({ feeds, keywords, since }) {
  const isAiRelated = buildMatcher(keywords);
  const results = await Promise.allSettled(feeds.map((feed) => parser.parseURL(feed.url)));

  const articles = [];
  const errors = [];
  const seenLinks = new Set();

  results.forEach((result, i) => {
    const feed = feeds[i];
    if (result.status === 'rejected') {
      errors.push(`${feed.name}: ${result.reason?.message ?? result.reason}`);
      return;
    }

    for (const item of result.value.items) {
      const publishedAt = new Date(item.isoDate ?? item.pubDate ?? NaN);
      // 日付なし・不正な日付・期間外は除外
      if (!(publishedAt >= since)) continue;
      if (!item.link || seenLinks.has(item.link)) continue;

      const title = normalizeText(item.title ?? '') || '(無題)';
      const body = normalizeText(item.contentSnippet ?? item.content ?? item.summary ?? '');
      if (feed.filter && !isAiRelated(`${title} ${body}`)) continue;

      seenLinks.add(item.link);
      articles.push({
        source: feed.name,
        title,
        link: item.link,
        publishedAt,
        body: body.slice(0, MAX_BODY_CHARS),
      });
    }
  });

  articles.sort((a, b) => b.publishedAt - a.publishedAt);
  return { articles, errors };
}
