import { analyzeMarketCandidate, rankMarketCandidates } from "./autoIndicators.mjs";
import { buildLlmMessages, parseLlmDecisions } from "./autoLlm.mjs";

const DETAIL_SCAN_MIN = 30;
const DETAIL_SCAN_MULTIPLIER = 3;
const DETAIL_SCAN_MAX = 80;
const DETAIL_CONCURRENCY = 2;
const DETAIL_DELAY_MS = 250;
const OI_CONCURRENCY = 1;
const OI_DELAY_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapConcurrent(items, limit, mapper, delayMs = 10) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch {
        results[index] = null;
      }
      await sleep(delayMs);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function toMapBySymbol(items, key = "symbol") {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : [items]) {
    if (item?.[key]) {
      map.set(String(item[key]).toUpperCase(), item);
    }
  }
  return map;
}

function isUsdtPerpetual(symbolInfo) {
  return (
    symbolInfo?.status === "TRADING" &&
    symbolInfo?.quoteAsset === "USDT" &&
    (!symbolInfo.contractType || symbolInfo.contractType === "PERPETUAL")
  );
}

function priceString(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  if (value >= 1000) return value.toFixed(1);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function tickerPrefilterScore(ticker) {
  const quoteVolume = Number(ticker?.quoteVolume ?? 0);
  const change = Math.abs(Number(ticker?.priceChangePercent ?? 0));
  const trades = Number(ticker?.count ?? 0);
  if (!Number.isFinite(quoteVolume) || quoteVolume <= 0) {
    return 0;
  }

  return Math.log10(quoteVolume + 1) * 8 + Math.min(change, 30) * 3 + Math.log10(trades + 1);
}

function buildPrefilteredSymbols({ symbols, tickerMap, limit }) {
  return symbols
    .map((symbol) => ({
      symbol,
      ticker: tickerMap.get(symbol),
      score: tickerPrefilterScore(tickerMap.get(symbol)),
    }))
    .filter((item) => item.ticker && item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.symbol);
}

function buildLocalDecision(candidate, defaultLeverage) {
  const atr = candidate.price * Math.max(candidate.atrPercent, 0.2) / 100;
  const stopDistance = Math.max(atr * 2, candidate.price * 0.004);
  const takeDistance = Math.max(atr * 3, candidate.price * 0.008);
  const isLong = candidate.intent === "open_long";

  return {
    symbol: candidate.symbol,
    action: candidate.intent,
    confidence: candidate.localScore,
    entryPrice: priceString(candidate.price),
    stopLoss: priceString(isLong ? candidate.price - stopDistance : candidate.price + stopDistance),
    takeProfit: priceString(isLong ? candidate.price + takeDistance : candidate.price - takeDistance),
    leverage: defaultLeverage,
    reason: candidate.localReason,
    source: "local",
  };
}

function mergeDecisionWithLocal(decision, localBySymbol) {
  const local = localBySymbol.get(decision.symbol);
  return {
    ...decision,
    intent: decision.action,
    source: decision.source ?? "llm",
    localScore: local?.localScore ?? null,
    localReason: local?.localReason ?? "",
    price: local?.price ?? Number(decision.entryPrice),
    quoteVolume: local?.quoteVolume ?? 0,
    change24h: local?.change24h ?? 0,
    fundingRate: local?.fundingRate ?? 0,
    rsi: local?.rsi ?? null,
    atrPercent: local?.atrPercent ?? null,
  };
}

export class AutoAnalyzer {
  constructor({ runtime, llmClient }) {
    this.runtime = runtime;
    this.llmClient = llmClient;
  }

  async scan() {
    const config = this.runtime.getAutoConfig();
    const client = this.runtime.createClient();
    const exchangeInfo = await this.runtime.getExchangeInfo();
    const symbolInfos = (exchangeInfo.symbols ?? []).filter(isUsdtPerpetual);
    const tradableSymbols = new Set(symbolInfos.map((item) => item.symbol));

    const [tickers, fundingRates] = await Promise.all([
      client.get24hTickers(),
      client.getFundingRates().catch(() => []),
    ]);
    const tickerMap = toMapBySymbol(tickers);
    const fundingMap = toMapBySymbol(fundingRates);
    const symbols = symbolInfos
      .map((item) => item.symbol)
      .filter((symbol) => tickerMap.has(symbol));
    const detailLimit = Math.min(
      DETAIL_SCAN_MAX,
      Math.max(DETAIL_SCAN_MIN, config.llmMaxCandidates * DETAIL_SCAN_MULTIPLIER),
    );
    const detailedSymbols = buildPrefilteredSymbols({
      symbols,
      tickerMap,
      limit: detailLimit,
    });

    const detailed = await mapConcurrent(detailedSymbols, DETAIL_CONCURRENCY, async (symbol) => {
      const klines = await client.getKlines({ symbol, interval: "1h", limit: 120 });
      return analyzeMarketCandidate({
        symbol,
        ticker: tickerMap.get(symbol),
        klines,
        fundingRate: fundingMap.get(symbol)?.lastFundingRate,
        openInterest: null,
      });
    }, DETAIL_DELAY_MS);

    const localCandidates = rankMarketCandidates(detailed);
    const localTop = localCandidates.slice(0, config.llmMaxCandidates);
    const oiItems = await mapConcurrent(localTop, OI_CONCURRENCY, async (candidate) => {
      const oi = await client.getOpenInterest({ symbol: candidate.symbol });
      return {
        symbol: candidate.symbol,
        openInterest: Number(oi?.openInterest ?? 0),
      };
    }, OI_DELAY_MS);
    const oiMap = new Map(oiItems.filter(Boolean).map((item) => [item.symbol, item.openInterest]));
    for (const candidate of localTop) {
      candidate.openInterest = oiMap.get(candidate.symbol) ?? candidate.openInterest ?? 0;
    }
    const allowedSymbols = new Set(localTop.map((item) => item.symbol));
    const localBySymbol = new Map(localTop.map((item) => [item.symbol, item]));

    let llmStatus = "skipped";
    let llmError = null;
    let decisions = [];

    if (this.llmClient.isConfigured() && localTop.length) {
      try {
        const content = await this.llmClient.createChatCompletion({
          messages: buildLlmMessages({
            maxLeverage: config.maxLeverage,
            candidates: localTop.map((item) => ({
              symbol: item.symbol,
              localIntent: item.intent,
              localScore: item.localScore,
              price: priceString(item.price),
              change24h: Number(item.change24h.toFixed(2)),
              quoteVolume: Number(item.quoteVolume.toFixed(2)),
              fundingRate: Number(item.fundingRate.toFixed(4)),
              rsi: Number(item.rsi.toFixed(1)),
              atrPercent: Number(item.atrPercent.toFixed(2)),
              volumeRatio: Number(item.volumeRatio.toFixed(2)),
              reason: item.localReason,
            })),
          }),
        });
        decisions = parseLlmDecisions(content, {
          allowedSymbols,
          maxLeverage: config.maxLeverage,
        }).filter((item) => item.action !== "hold");
        llmStatus = "ok";
      } catch (error) {
        llmStatus = "error";
        llmError = error?.message || String(error);
      }
    }

    const finalDecisions = decisions.length
      ? decisions
      : localTop.map((item) => buildLocalDecision(item, config.defaultLeverage));

    return {
      scannedAt: new Date().toISOString(),
      universeSize: tradableSymbols.size,
      scannedSymbols: detailedSymbols.length,
      prefilteredFrom: symbols.length,
      analyzedCandidates: localTop.length,
      llmStatus,
      llmError,
      candidates: finalDecisions
        .map((item) => mergeDecisionWithLocal(item, localBySymbol))
        .sort((left, right) => right.confidence - left.confidence),
    };
  }
}
