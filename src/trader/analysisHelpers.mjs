export const ANALYSIS_PERIODS = ["5m", "1h"];

const PERIOD_LABELS = new Map([
  ["5m", "5分钟"],
  ["1h", "1小时"],
]);

const BULLISH_TERMS = [
  "看多",
  "多头",
  "突破",
  "拉升",
  "反弹",
  "买入",
  "做多",
  "bullish",
  "long",
  "breakout",
  "pump",
];

const BEARISH_TERMS = [
  "看空",
  "空头",
  "跌破",
  "回落",
  "下跌",
  "卖出",
  "做空",
  "bearish",
  "short",
  "breakdown",
  "dump",
];

const RISK_TERMS = [
  "爆仓",
  "清算",
  "止损",
  "高杠杆",
  "追涨",
  "fomo",
  "liquidation",
  "rug",
];

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lastItem(items) {
  return Array.isArray(items) && items.length ? items[items.length - 1] : null;
}

function periodLabel(period) {
  return PERIOD_LABELS.get(period) ?? period;
}

function normalizeRatioItem(item) {
  if (!item) {
    return null;
  }

  return {
    longShortRatio: item.longShortRatio ?? null,
    longAccount: item.longAccount ?? null,
    shortAccount: item.shortAccount ?? null,
    timestamp: item.timestamp ?? null,
  };
}

function normalizeTakerItem(item) {
  if (!item) {
    return null;
  }

  return {
    buySellRatio: item.buySellRatio ?? null,
    buyVol: item.buyVol ?? null,
    sellVol: item.sellVol ?? null,
    timestamp: item.timestamp ?? null,
  };
}

function normalizeOpenInterestChange(history) {
  const items = Array.isArray(history) ? history.filter(Boolean) : [];
  const latest = lastItem(items);
  const previous = items.length >= 2 ? items[items.length - 2] : null;
  const latestValue = toNumber(latest?.sumOpenInterestValue ?? latest?.sumOpenInterest);
  const previousValue = toNumber(previous?.sumOpenInterestValue ?? previous?.sumOpenInterest);

  if (!latest) {
    return null;
  }

  if (latestValue === null || previousValue === null || previousValue === 0) {
    return {
      latest,
      previous,
      absoluteChange: null,
      percentChange: null,
    };
  }

  const absoluteChange = latestValue - previousValue;
  return {
    latest,
    previous,
    absoluteChange,
    percentChange: (absoluteChange / previousValue) * 100,
  };
}

function addRatioSignal({ reasons, period, label, ratio, bullishAt, bearishAt, riskHigh, riskLow }) {
  const value = toNumber(ratio);
  if (value === null) {
    return 0;
  }

  const periodText = periodLabel(period);
  if (value >= riskHigh) {
    reasons.push(`${periodText}${label}过度偏多，拥挤风险升高`);
    return 2;
  }

  if (value <= riskLow) {
    reasons.push(`${periodText}${label}过度偏空，波动风险升高`);
    return -2;
  }

  if (value >= bullishAt) {
    reasons.push(`${periodText}${label}偏多`);
    return 1;
  }

  if (value <= bearishAt) {
    reasons.push(`${periodText}${label}偏空`);
    return -1;
  }

  return 0;
}

function deriveSignal({ fundingRate, openInterestChange, longShortRatio, topTraderRatio, takerBuySell, sourceErrors }) {
  const reasons = [];
  const riskReasons = [];
  let score = 0;
  let available = 0;

  const funding = toNumber(fundingRate?.rate);
  if (funding !== null) {
    available += 1;
    if (Math.abs(funding) >= 0.001) {
      riskReasons.push(`资金费率达到 ${(funding * 100).toFixed(3)}%，成本偏极端`);
    } else if (funding >= 0.0002) {
      score += 1;
      reasons.push("资金费率偏正，多头愿意支付持仓成本");
    } else if (funding <= -0.0002) {
      score -= 1;
      reasons.push("资金费率偏负，空头愿意支付持仓成本");
    }
  }

  for (const period of ANALYSIS_PERIODS) {
    const globalRatio = longShortRatio?.[period]?.longShortRatio;
    const topRatio = topTraderRatio?.[period]?.longShortRatio;
    const takerRatio = takerBuySell?.[period]?.buySellRatio;
    const oiChange = openInterestChange?.[period]?.percentChange;
    const takerValue = toNumber(takerRatio);
    const oiValue = toNumber(oiChange);

    if (globalRatio !== null && globalRatio !== undefined) {
      available += 1;
      score += addRatioSignal({
        reasons,
        period,
        label: "全市场多空比",
        ratio: globalRatio,
        bullishAt: 1.15,
        bearishAt: 0.87,
        riskHigh: 2.5,
        riskLow: 0.4,
      });
    }

    if (topRatio !== null && topRatio !== undefined) {
      available += 1;
      score += addRatioSignal({
        reasons,
        period,
        label: "顶级交易员持仓",
        ratio: topRatio,
        bullishAt: 1.2,
        bearishAt: 0.83,
        riskHigh: 2.8,
        riskLow: 0.35,
      });
    }

    if (takerValue !== null) {
      available += 1;
      if (takerValue >= 2 || takerValue <= 0.5) {
        riskReasons.push(`${periodLabel(period)}主动买卖量失衡，短线波动风险升高`);
      } else if (takerValue >= 1.15) {
        score += 1;
        reasons.push(`${periodLabel(period)}主动买入更强`);
      } else if (takerValue <= 0.87) {
        score -= 1;
        reasons.push(`${periodLabel(period)}主动卖出更强`);
      }
    }

    if (oiValue !== null) {
      available += 1;
      if (Math.abs(oiValue) >= 8) {
        riskReasons.push(`${periodLabel(period)}持仓量变化 ${oiValue.toFixed(2)}%，波动风险偏高`);
      } else if (oiValue >= 2 && takerValue !== null && takerValue >= 1.05) {
        score += 1;
        reasons.push(`${periodLabel(period)}持仓量上升且主动买入占优`);
      } else if (oiValue >= 2 && takerValue !== null && takerValue <= 0.95) {
        score -= 1;
        reasons.push(`${periodLabel(period)}持仓量上升且主动卖出占优`);
      } else if (oiValue <= -2) {
        reasons.push(`${periodLabel(period)}持仓量下降，趋势延续性偏弱`);
      }
    }
  }

  if (riskReasons.length) {
    return {
      signal: "风险偏高",
      reasons: unique([...riskReasons, ...reasons]).slice(0, 8),
    };
  }

  if (available === 0) {
    return {
      signal: "震荡",
      reasons: ["分析数据暂不可用"],
    };
  }

  if (score >= 2) {
    return {
      signal: "偏多",
      reasons: unique(reasons).slice(0, 8),
    };
  }

  if (score <= -2) {
    return {
      signal: "偏空",
      reasons: unique(reasons).slice(0, 8),
    };
  }

  const partialDataNote = Object.keys(sourceErrors ?? {}).length ? "部分行情数据暂不可用" : null;
  return {
    signal: "震荡",
    reasons: unique([partialDataNote, ...reasons, "多空数据接近均衡"]).slice(0, 8),
  };
}

export function buildMarketAnalysis({
  symbol,
  fundingRateHistory,
  openInterest,
  openInterestHistories = {},
  longShortRatios = {},
  topTraderRatios = {},
  takerBuySellVolumes = {},
  sourceErrors = {},
}) {
  const fundingItem = lastItem(fundingRateHistory);
  const fundingRate = fundingItem
    ? {
        rate: fundingItem.fundingRate ?? null,
        fundingTime: fundingItem.fundingTime ?? null,
        markPrice: fundingItem.markPrice ?? null,
      }
    : null;
  const openInterestChange = Object.fromEntries(
    ANALYSIS_PERIODS.map((period) => [
      period,
      normalizeOpenInterestChange(openInterestHistories[period]),
    ]),
  );
  const longShortRatio = Object.fromEntries(
    ANALYSIS_PERIODS.map((period) => [period, normalizeRatioItem(lastItem(longShortRatios[period]))]),
  );
  const topTraderRatio = Object.fromEntries(
    ANALYSIS_PERIODS.map((period) => [
      period,
      normalizeRatioItem(lastItem(topTraderRatios[period])),
    ]),
  );
  const takerBuySell = Object.fromEntries(
    ANALYSIS_PERIODS.map((period) => [
      period,
      normalizeTakerItem(lastItem(takerBuySellVolumes[period])),
    ]),
  );
  const signal = deriveSignal({
    fundingRate,
    openInterestChange,
    longShortRatio,
    topTraderRatio,
    takerBuySell,
    sourceErrors,
  });

  return {
    symbol,
    fundingRate,
    openInterest: openInterest
      ? {
          openInterest: openInterest.openInterest ?? null,
          time: openInterest.time ?? null,
        }
      : null,
    openInterestChange,
    longShortRatio,
    topTraderRatio,
    takerBuySell,
    signal: signal.signal,
    reasons: signal.reasons,
    squareNotes: null,
    sourceErrors,
    updatedAt: new Date().toISOString(),
  };
}

function matchTerms(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

export function analyzeSquareText(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return {
      sentiment: "中性",
      keywords: [],
      riskWords: [],
      summary: "暂无币安广场内容",
      sourceType: "empty",
    };
  }

  const bullishWords = matchTerms(text, BULLISH_TERMS);
  const bearishWords = matchTerms(text, BEARISH_TERMS);
  const riskWords = matchTerms(text, RISK_TERMS);
  const hashtags = text.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
  const symbols = (text.match(/\$?[A-Za-z0-9]{2,15}(?:USDT|USD)?\b/g) ?? [])
    .map((item) => item.replace(/^\$/, "").toUpperCase())
    .filter((item) => item.length >= 2 && !["HTTP", "HTTPS", "WWW", "COM"].includes(item));
  const score = bullishWords.length - bearishWords.length;
  const sentiment =
    riskWords.length > 0 ? "风险偏高" : score > 0 ? "偏多" : score < 0 ? "偏空" : "中性";
  const keywords = unique([...hashtags, ...symbols, ...bullishWords, ...bearishWords]).slice(0, 12);
  const sourceType = /https?:\/\/|www\./i.test(text) ? "link_or_text" : "text";

  return {
    sentiment,
    keywords,
    riskWords: unique(riskWords),
    summary:
      sourceType === "link_or_text"
        ? "已识别链接/文本，V1 只分析你粘贴的可见内容"
        : "已从粘贴内容提取情绪词和关键词",
    sourceType,
  };
}
