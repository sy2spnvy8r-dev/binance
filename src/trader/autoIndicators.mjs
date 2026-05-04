function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function calcSma(values, period) {
  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function calcEma(values, period) {
  if (!values.length) {
    return null;
  }

  const k = 2 / (period + 1);
  let ema = calcSma(values.slice(0, period), Math.min(period, values.length));
  for (let index = 1; index < values.length; index += 1) {
    ema = values[index] * k + ema * (1 - k);
  }

  return ema;
}

function calcRsi(closes, period = 14) {
  if (closes.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;
  for (let index = closes.length - period; index < closes.length; index += 1) {
    const diff = closes[index] - closes[index - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  if (losses === 0) {
    return gains === 0 ? 50 : 100;
  }

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcAtrPercent(highs, lows, closes, period = 14) {
  if (closes.length <= period) {
    return 0;
  }

  const trs = [];
  for (let index = 1; index < closes.length; index += 1) {
    trs.push(
      Math.max(
        highs[index] - lows[index],
        Math.abs(highs[index] - closes[index - 1]),
        Math.abs(lows[index] - closes[index - 1]),
      ),
    );
  }

  const atr = calcSma(trs, Math.min(period, trs.length)) ?? 0;
  const lastClose = closes.at(-1) || 1;
  return (atr / lastClose) * 100;
}

function normalizeKlines(klines) {
  return (klines ?? []).map((item) => ({
    open: numberOrZero(item[1]),
    high: numberOrZero(item[2]),
    low: numberOrZero(item[3]),
    close: numberOrZero(item[4]),
    volume: numberOrZero(item[5]),
  }));
}

export function analyzeMarketCandidate({ symbol, ticker, klines, fundingRate, openInterest }) {
  const candles = normalizeKlines(klines);
  if (candles.length < 30) {
    return null;
  }

  const closes = candles.map((item) => item.close);
  const highs = candles.map((item) => item.high);
  const lows = candles.map((item) => item.low);
  const volumes = candles.map((item) => item.volume);
  const price = numberOrZero(ticker?.lastPrice ?? closes.at(-1));
  const quoteVolume = numberOrZero(ticker?.quoteVolume);
  const change24h = numberOrZero(ticker?.priceChangePercent);
  const ema20 = calcEma(closes, 20) ?? price;
  const ema50 = calcEma(closes, 50) ?? ema20;
  const rsi = calcRsi(closes);
  const atrPercent = calcAtrPercent(highs, lows, closes);
  const volumeSma20 = calcSma(volumes, 20) ?? 0;
  const volumeRatio = volumeSma20 > 0 ? volumes.at(-1) / volumeSma20 : 1;
  const fundingPct = numberOrZero(fundingRate) * 100;
  const oi = numberOrZero(openInterest);

  let bullScore = 0;
  let bearScore = 0;
  const reasons = [];

  if (price > ema20) bullScore += 16;
  else bearScore += 16;

  if (ema20 > ema50) bullScore += 18;
  else bearScore += 18;

  if (change24h > 0) bullScore += Math.min(18, Math.abs(change24h) * 2);
  else bearScore += Math.min(18, Math.abs(change24h) * 2);

  if (rsi >= 52 && rsi <= 72) bullScore += 14;
  if (rsi <= 48 && rsi >= 28) bearScore += 14;
  if (rsi > 76) bearScore += 10;
  if (rsi < 24) bullScore += 10;

  if (volumeRatio > 1.2) {
    bullScore += 8;
    bearScore += 8;
    reasons.push(`成交量放大 ${volumeRatio.toFixed(2)}倍`);
  }

  if (atrPercent > 0.5) {
    bullScore += Math.min(8, atrPercent);
    bearScore += Math.min(8, atrPercent);
  }

  if (fundingPct > 0.05) bearScore += 5;
  if (fundingPct < -0.03) bullScore += 5;

  const intent = bullScore >= bearScore ? "open_long" : "open_short";
  const score = Math.round(Math.max(bullScore, bearScore));
  const confidence = Math.max(1, Math.min(100, score));

  reasons.push(
    `24小时涨跌 ${change24h.toFixed(2)}%`,
    `RSI ${rsi.toFixed(1)}`,
    `波动率ATR ${atrPercent.toFixed(2)}%`,
  );

  return {
    symbol,
    intent,
    price,
    quoteVolume,
    change24h,
    fundingRate: fundingPct,
    openInterest: oi,
    ema20,
    ema50,
    rsi,
    atrPercent,
    volumeRatio,
    localScore: confidence,
    localReason: reasons.join("; "),
  };
}

export function rankMarketCandidates(candidates) {
  return [...candidates]
    .filter(Boolean)
    .filter((item) => Number.isFinite(item.price) && item.price > 0)
    .sort((left, right) => {
      const scoreDiff = right.localScore - left.localScore;
      if (scoreDiff !== 0) return scoreDiff;
      return right.quoteVolume - left.quoteVolume;
    });
}
