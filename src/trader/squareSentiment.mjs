import { analyzeSquareText } from "./analysisHelpers.mjs";

const SENTIMENT_SCORE = new Map([
  ["偏多", 1],
  ["偏空", -1],
  ["中性", 0],
  ["风险偏高", 0],
]);

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().replace(/^[$#]+/, "").toUpperCase();
  if (!symbol) {
    return null;
  }

  if (!/^[A-Z0-9]{2,30}(?:USDT)?$/.test(symbol)) {
    return null;
  }

  return symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
}

function symbolAliases(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return [];
  }

  const base = normalized.replace(/USDT$/, "");
  return unique([normalized, base, `$${base}`, `#${base}`, `#${normalized}`]);
}

export function normalizeSquareSymbols(symbols = []) {
  return unique(symbols.map(normalizeSymbol));
}

export function postMatchesSymbols(post, symbols = []) {
  const text = `${post?.title ?? ""} ${post?.text ?? ""}`.toUpperCase();
  if (!symbols.length) {
    return true;
  }

  return symbols.some((symbol) => symbolAliases(symbol).some((alias) => text.includes(alias)));
}

export function buildSquareNotes({ posts = [], symbols = [], sourceErrors = {} } = {}) {
  const normalizedSymbols = normalizeSquareSymbols(symbols);
  const analyzedPosts = posts
    .filter((post) => postMatchesSymbols(post, normalizedSymbols))
    .map((post) => {
      const text = [post.title, post.text].filter(Boolean).join("\n");
      return {
        ...post,
        ...analyzeSquareText(text),
      };
    });
  const riskPosts = analyzedPosts.filter((post) => post.sentiment === "风险偏高");
  const score = analyzedPosts.reduce(
    (sum, post) => sum + (SENTIMENT_SCORE.get(post.sentiment) ?? 0),
    0,
  );
  const sentiment =
    riskPosts.length > 0
      ? "风险偏高"
      : score > 0
        ? "偏多"
        : score < 0
          ? "偏空"
          : "中性";
  const keywords = unique(analyzedPosts.flatMap((post) => post.keywords ?? [])).slice(0, 16);
  const riskWords = unique(analyzedPosts.flatMap((post) => post.riskWords ?? [])).slice(0, 12);
  const matchedSymbols = unique(
    normalizedSymbols.filter((symbol) => analyzedPosts.some((post) => postMatchesSymbols(post, [symbol]))),
  );
  const sourceErrorCount = Object.keys(sourceErrors).length;

  return {
    sentiment,
    keywords,
    riskWords,
    postCount: analyzedPosts.length,
    matchedSymbols,
    posts: analyzedPosts.slice(0, 8).map((post) => ({
      id: post.id,
      title: post.title,
      text: post.text,
      link: post.link,
      publishedAt: post.publishedAt,
      sentiment: post.sentiment,
      keywords: post.keywords,
      riskWords: post.riskWords,
    })),
    sourceErrors,
    status:
      analyzedPosts.length > 0
        ? "ok"
        : sourceErrorCount > 0
          ? "degraded"
          : "empty",
    summary:
      analyzedPosts.length > 0
        ? `今日广场匹配 ${analyzedPosts.length} 条内容`
        : sourceErrorCount > 0
          ? "广场数据暂不可用"
          : "今日暂未匹配到广场内容",
    updatedAt: new Date().toISOString(),
  };
}
