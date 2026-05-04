import { postMatchesSymbols, normalizeSquareSymbols } from "./squareSentiment.mjs";

const DEFAULT_SOURCES = [
  {
    name: "square-feed-recommend",
    method: "POST",
    url: "https://www.binance.com/bapi/composite/v9/friendly/pgc/feed/feed-recommend/list",
    body: ({ pageSize }) => ({
      pageIndex: 1,
      pageSize,
      scene: "web-homepage",
    }),
  },
  {
    name: "square-page",
    method: "GET",
    url: "https://www.binance.com/en/square",
  },
];

const TEXT_KEYS = [
  "title",
  "content",
  "text",
  "summary",
  "description",
  "body",
  "shortContent",
  "articleTitle",
  "articleContent",
];
const TIME_KEYS = ["publishedAt", "publishTime", "releaseDate", "createTime", "createdAt", "updateTime", "timestamp"];
const ID_KEYS = ["id", "postId", "articleId", "feedId", "resourceId", "slug"];
const LINK_KEYS = ["url", "link", "shareLink", "webLink", "jumpUrl"];

function formatDateKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim().length >= 10) {
    return normalizeTimestamp(numeric);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== "") {
      return object[key];
    }
  }

  return null;
}

function normalizeLink(value) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) {
    return "";
  }

  if (rawValue.startsWith("http://") || rawValue.startsWith("https://")) {
    return rawValue;
  }

  if (rawValue.startsWith("/")) {
    return `https://www.binance.com${rawValue}`;
  }

  return rawValue;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function collectCandidateObjects(value, output = [], depth = 0) {
  if (depth > 8 || !value) {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCandidateObjects(item, output, depth + 1);
    }
    return output;
  }

  if (!isPlainObject(value)) {
    return output;
  }

  if (TEXT_KEYS.some((key) => typeof value[key] === "string" && value[key].trim().length >= 8)) {
    output.push(value);
  }

  for (const item of Object.values(value)) {
    if (Array.isArray(item) || isPlainObject(item)) {
      collectCandidateObjects(item, output, depth + 1);
    }
  }

  return output;
}

function extractJsonBlocksFromHtml(html) {
  const blocks = [];
  const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html))) {
    const text = match[1].trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      blocks.push(text);
    }
  }

  return blocks;
}

function extractPostsFromHtml(html) {
  const posts = [];
  for (const block of extractJsonBlocksFromHtml(html)) {
    try {
      posts.push(...extractPostsFromPayload(JSON.parse(block)));
    } catch {}
  }

  const linkPattern = /href="([^"]*\/square\/post\/[^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html))) {
    const text = stripHtml(match[2]);
    if (text.length >= 8) {
      posts.push({
        id: match[1],
        title: text.slice(0, 120),
        text,
        link: normalizeLink(match[1]),
        publishedAt: null,
      });
    }
  }

  return posts;
}

export function extractPostsFromPayload(payload) {
  return collectCandidateObjects(payload).map((item) => {
    const title = stripHtml(findFirstValue(item, ["title", "articleTitle", "headline"]));
    const text = stripHtml(findFirstValue(item, TEXT_KEYS));
    const timestamp = normalizeTimestamp(findFirstValue(item, TIME_KEYS));
    const id = String(findFirstValue(item, ID_KEYS) ?? `${title}:${text}`.slice(0, 80));
    const link = normalizeLink(findFirstValue(item, LINK_KEYS));

    return {
      id,
      title: title || text.slice(0, 80),
      text,
      link,
      publishedAt: timestamp,
    };
  });
}

function dedupePosts(posts) {
  const seen = new Set();
  const result = [];
  for (const post of posts) {
    const key = post.id || `${post.title}:${post.text}`.slice(0, 120);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(post);
  }

  return result;
}

function normalizeSources(sourceUrls) {
  if (!sourceUrls?.length) {
    return DEFAULT_SOURCES;
  }

  return sourceUrls.map((url, index) => ({
    name: `custom-${index + 1}`,
    method: "GET",
    url,
  }));
}

export class SquareDailySource {
  constructor({
    fetchImpl = globalThis.fetch,
    sourceUrls = [],
    pageSize = 20,
    maxPosts = 50,
    timeZone = "Asia/Shanghai",
    now = () => new Date(),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.sources = normalizeSources(sourceUrls);
    this.pageSize = pageSize;
    this.maxPosts = maxPosts;
    this.timeZone = timeZone;
    this.now = now;
  }

  async fetchSource(source) {
    const init = {
      method: source.method,
      headers: {
        Accept: "application/json, text/html, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        clienttype: "web",
      },
    };

    if (source.method === "POST") {
      init.body = JSON.stringify(source.body({ pageSize: this.pageSize }));
    }

    const response = await this.fetchImpl(source.url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      return extractPostsFromPayload(JSON.parse(text));
    }

    return extractPostsFromHtml(text);
  }

  async fetchToday({ symbols = [] } = {}) {
    const normalizedSymbols = normalizeSquareSymbols(symbols);
    const todayKey = formatDateKey(this.now(), this.timeZone);
    const sourceErrors = {};
    const batches = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return await this.fetchSource(source);
        } catch (error) {
          sourceErrors[source.name] = error?.message || "请求失败";
          return [];
        }
      }),
    );
    const posts = dedupePosts(batches.flat())
      .filter((post) => !post.publishedAt || formatDateKey(post.publishedAt, this.timeZone) === todayKey)
      .filter((post) => postMatchesSymbols(post, normalizedSymbols))
      .slice(0, this.maxPosts);

    return {
      posts,
      sourceErrors,
      fetchedAt: new Date().toISOString(),
      timeZone: this.timeZone,
      date: todayKey,
    };
  }
}
