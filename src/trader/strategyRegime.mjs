const TREND_LONG = "趋势多";
const TREND_SHORT = "趋势空";
const CHOP = "震荡";
const RISK_OFF = "风险关闭";
const DEFAULT_CONFLICT_OVERRIDE_CONFIDENCE = 75;
const DEFAULT_CONFLICT_MARGIN_SCALE = 0.5;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratioValue(container, period, key = "longShortRatio") {
  return toNumber(container?.[period]?.[key]);
}

function percentValue(container, period) {
  return toNumber(container?.[period]?.percentChange);
}

function actionDirection(action) {
  if (action === "open_long") return TREND_LONG;
  if (action === "open_short") return TREND_SHORT;
  return null;
}

function confidenceValue(candidate) {
  return toNumber(candidate?.confidence ?? candidate?.localScore);
}

function normalizeMarginScale(value) {
  const parsed = toNumber(value);
  if (parsed === null || parsed <= 0 || parsed >= 1) {
    return DEFAULT_CONFLICT_MARGIN_SCALE;
  }

  return parsed;
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

export function buildStrategyRegime({ analysis, candidate, options = {} } = {}) {
  const reasons = [];
  const riskReasons = [];
  let score = 0;
  let riskScore = 0;

  const signal = analysis?.signal;
  if (signal === "风险偏高") {
    riskScore += 45;
    riskReasons.push("合约分析信号为风险偏高");
  } else if (signal === "偏多") {
    score += 2;
    reasons.push("合约分析偏多");
  } else if (signal === "偏空") {
    score -= 2;
    reasons.push("合约分析偏空");
  } else if (signal === "震荡") {
    reasons.push("合约分析偏震荡");
  }

  const funding = toNumber(analysis?.fundingRate?.rate);
  if (funding !== null) {
    if (Math.abs(funding) >= 0.001) {
      riskScore += 25;
      riskReasons.push(`资金费率偏极端 ${(funding * 100).toFixed(3)}%`);
    } else if (funding >= 0.0002) {
      score += 0.5;
    } else if (funding <= -0.0002) {
      score -= 0.5;
    }
  }

  for (const period of ["5m", "1h"]) {
    const globalRatio = ratioValue(analysis?.longShortRatio, period);
    const topRatio = ratioValue(analysis?.topTraderRatio, period);
    const takerRatio = ratioValue(analysis?.takerBuySell, period, "buySellRatio");
    const oiChange = percentValue(analysis?.openInterestChange, period);

    if (globalRatio !== null) {
      if (globalRatio >= 2.5 || globalRatio <= 0.4) {
        riskScore += 10;
        riskReasons.push(`${period} 全市场多空比拥挤`);
      } else if (globalRatio > 1.15) {
        score += 0.5;
      } else if (globalRatio < 0.87) {
        score -= 0.5;
      }
    }

    if (topRatio !== null) {
      if (topRatio >= 2.8 || topRatio <= 0.35) {
        riskScore += 10;
        riskReasons.push(`${period} 顶级交易员仓位拥挤`);
      } else if (topRatio > 1.12) {
        score += 0.75;
      } else if (topRatio < 0.9) {
        score -= 0.75;
      }
    }

    if (takerRatio !== null) {
      if (takerRatio > 1.15) {
        score += 0.75;
      } else if (takerRatio < 0.87) {
        score -= 0.75;
      }
    }

    if (oiChange !== null && Math.abs(oiChange) >= 8) {
      riskScore += 10;
      riskReasons.push(`${period} 持仓量短时变化过大 ${oiChange.toFixed(2)}%`);
    }
  }

  if (Object.keys(analysis?.sourceErrors ?? {}).length >= 3) {
    riskScore += 20;
    riskReasons.push("市场状态数据源缺失较多");
  }

  const squareSignal = analysis?.squareNotes?.sentiment;
  if (squareSignal === "风险偏高") {
    riskScore += 10;
    riskReasons.push("币安广场情绪风险偏高");
  }

  let state = CHOP;
  if (riskScore >= 60) {
    state = RISK_OFF;
  } else if (score >= 2) {
    state = TREND_LONG;
  } else if (score <= -2) {
    state = TREND_SHORT;
  }

  const direction = actionDirection(candidate?.action || candidate?.intent);
  let allowNewTrade = state !== RISK_OFF;
  let marginScale = 1;
  const candidateConfidence = confidenceValue(candidate);
  const conflictOverrideConfidence =
    toNumber(options.conflictOverrideConfidence) ?? DEFAULT_CONFLICT_OVERRIDE_CONFIDENCE;
  const conflictMarginScale = normalizeMarginScale(options.conflictMarginScale);
  const gateReasons = [];

  if (state === RISK_OFF) {
    allowNewTrade = false;
    gateReasons.push("风险关闭，禁止新开仓");
  } else if (direction) {
    if (state === CHOP) {
      allowNewTrade = true;
      gateReasons.push("震荡状态，允许按小保证金试仓");
    } else if (direction !== state) {
      if (candidateConfidence !== null && candidateConfidence >= conflictOverrideConfidence) {
        allowNewTrade = true;
        marginScale = conflictMarginScale;
        gateReasons.push(
          `候选方向 ${direction} 与市场状态 ${state} 冲突，但信心 ${candidateConfidence} >= ${conflictOverrideConfidence}，允许小仓试单`,
        );
      } else {
        allowNewTrade = false;
        gateReasons.push(`候选方向 ${direction} 与市场状态 ${state} 冲突`);
      }
    } else {
      gateReasons.push(`候选方向与市场状态 ${state} 匹配`);
    }
  }

  return {
    symbol: analysis?.symbol ?? candidate?.symbol ?? "BTCUSDT",
    state,
    riskScore: Math.min(100, Math.round(riskScore)),
    trendScore: Number(score.toFixed(2)),
    allowNewTrade,
    marginScale,
    candidateAction: candidate?.action || candidate?.intent || null,
    reasons: unique([...gateReasons, ...riskReasons, ...reasons]).slice(0, 8),
    updatedAt: new Date().toISOString(),
  };
}

export function buildUnavailableRegime({ symbol, error } = {}) {
  return {
    symbol: symbol || "BTCUSDT",
    state: RISK_OFF,
    riskScore: 100,
    trendScore: 0,
    allowNewTrade: false,
    candidateAction: null,
    reasons: [`市场状态数据不可用：${error?.message || error || "unknown error"}`],
    updatedAt: new Date().toISOString(),
  };
}
