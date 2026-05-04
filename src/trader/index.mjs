import process from "node:process";
import { BinanceApiError, BinanceFuturesClient } from "../binance/futuresRestClient.mjs";
import { compareDecimalStrings, absDecimalString } from "./decimal.mjs";
import { upsertEnvFile } from "./envFile.mjs";
import {
  assertCloseQuantityAllowed,
  buildOrderInstruction,
  buildSymbolIndex,
  describePositionMode,
  describeTradeIntent,
  formatPositionDirection,
  getActivePositions,
  getCloseableQuantity,
  getSymbolInfo,
  getSymbolRules,
  validateLimitPrice,
  validateLimitQuantity,
  validateMinNotional,
} from "./futuresTradeHelpers.mjs";
import { createPrompter } from "./prompt.mjs";
import { loadTraderConfig } from "./traderConfig.mjs";

function isNonZero(value) {
  return compareDecimalStrings(value ?? "0", "0") !== 0;
}

function validateLeverage(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 125) {
    return "杠杆必须是 1 到 125 的整数。";
  }

  return null;
}

function formatPositionLine(position, dualSidePosition) {
  const direction = formatPositionDirection(position, dualSidePosition);
  const quantity = absDecimalString(position.positionAmt ?? "0");
  return `- ${position.symbol} ${direction}: 数量 ${quantity} | 未实现盈亏 ${
    position.unrealizedProfit ?? "0"
  } | 名义价值 ${position.notional ?? "0"} | 初始保证金 ${position.initialMargin ?? "0"}`;
}

function printDryRunRequest(title, payload) {
  console.log(`${title}（dry-run）`);
  console.log(`- ${payload.method} ${payload.url}`);
  if (payload.body) {
    console.log(`- body: ${payload.body}`);
  }
}

function printError(error) {
  if (error instanceof BinanceApiError) {
    const codeText = error.code !== undefined ? ` / ${error.code}` : "";
    console.error(`Binance 错误 [HTTP ${error.status}${codeText}]: ${error.details?.msg || error.message}`);
    return;
  }

  console.error(error?.message || String(error));
}

async function ensureCredentials(config, prompter) {
  if (config.apiKey && config.apiSecret) {
    return config;
  }

  console.log("未检测到币安合约 API Key / Secret。");
  console.log("请确认你的 API 已开启 USD-M Futures 和 Trade 权限。");

  const apiKey =
    config.apiKey ||
    (await prompter.question("请输入 BINANCE API Key", {
      validate: (value) => (!value ? "API Key 不能为空。" : null),
    }));
  const apiSecret =
    config.apiSecret ||
    (await prompter.secret("请输入 BINANCE API Secret", {
      allowEmpty: false,
    }));

  const nextConfig = {
    ...config,
    apiKey,
    apiSecret,
  };

  const shouldSave = await prompter.confirm(`是否写入 ${config.envFile} 供下次直接使用`, {
    defaultValue: true,
  });
  if (shouldSave) {
    await upsertEnvFile(config.envFile, {
      BINANCE_FUTURES_API_KEY: apiKey,
      BINANCE_FUTURES_API_SECRET: apiSecret,
      BINANCE_FUTURES_BASE_URL: config.baseUrl,
      BINANCE_FUTURES_RECV_WINDOW: String(config.recvWindow),
      BINANCE_FUTURES_DRY_RUN: String(config.dryRun),
      TRADER_ENV_FILE: pathRelativeToCwd(config.envFile),
    });
    console.log(`已写入 ${config.envFile}`);
  }

  return nextConfig;
}

function pathRelativeToCwd(filePath) {
  const relativePath = process.cwd() === filePath ? "." : filePath.replace(`${process.cwd()}\\`, "");
  return relativePath || ".env";
}

async function fetchTradingSnapshot(client) {
  const [accountInfo, positionMode] = await Promise.all([
    client.getAccountInfo(),
    client.getPositionMode(),
  ]);

  return {
    accountInfo,
    dualSidePosition: positionMode.dualSidePosition === true || positionMode.dualSidePosition === "true",
  };
}

function printAccountOverview(snapshot) {
  const { accountInfo, dualSidePosition } = snapshot;
  const assets = (accountInfo.assets ?? [])
    .filter(
      (item) =>
        isNonZero(item.walletBalance ?? "0") ||
        isNonZero(item.availableBalance ?? "0") ||
        isNonZero(item.unrealizedProfit ?? "0"),
    )
    .sort((left, right) => Number(right.walletBalance ?? 0) - Number(left.walletBalance ?? 0));
  const activePositions = getActivePositions(accountInfo).sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  );

  console.log("");
  console.log("=== 账户概览 ===");
  console.log(`持仓模式: ${describePositionMode(dualSidePosition)}`);
  console.log(`总钱包余额: ${accountInfo.totalWalletBalance}`);
  console.log(`可用余额: ${accountInfo.availableBalance}`);
  console.log(`未实现盈亏: ${accountInfo.totalUnrealizedProfit}`);
  console.log(`最大可转出: ${accountInfo.maxWithdrawAmount}`);

  if (assets.length > 0) {
    console.log("资产余额:");
    for (const asset of assets) {
      console.log(
        `- ${asset.asset}: 钱包 ${asset.walletBalance} | 可用 ${asset.availableBalance ?? "0"} | 未实现盈亏 ${
          asset.unrealizedProfit ?? "0"
        }`,
      );
    }
  } else {
    console.log("资产余额: 暂无非零资产");
  }

  if (activePositions.length > 0) {
    console.log("当前持仓:");
    for (const position of activePositions) {
      console.log(formatPositionLine(position, dualSidePosition));
    }
  } else {
    console.log("当前持仓: 无");
  }

  if (!dualSidePosition) {
    console.log("提示: 单向持仓模式下，买卖会按净持仓处理；开多/开空不会与现有仓位并存。");
  }
}

async function showAccountOverview(client) {
  const snapshot = await fetchTradingSnapshot(client);
  printAccountOverview(snapshot);
  return snapshot;
}

function printSymbolContext({ snapshot, symbolInfo, rules, intent }) {
  console.log("");
  console.log(`交易对: ${symbolInfo.symbol}`);
  console.log(
    `规则: 最小价格 ${rules.minPrice} | 价格步进 ${rules.tickSize} | 最小数量 ${rules.minQty} | 数量步进 ${rules.stepSize} | 最小名义价值 ${rules.minNotional}`,
  );

  const symbolPositions = getActivePositions(snapshot.accountInfo).filter(
    (item) => item.symbol === symbolInfo.symbol,
  );
  if (symbolPositions.length > 0) {
    console.log("该合约当前持仓:");
    for (const position of symbolPositions) {
      console.log(formatPositionLine(position, snapshot.dualSidePosition));
    }
  } else {
    console.log("该合约当前持仓: 无");
  }

  if (intent === "close_long" || intent === "close_short") {
    const closeableQuantity = getCloseableQuantity({
      accountInfo: snapshot.accountInfo,
      symbol: symbolInfo.symbol,
      intent,
      dualSidePosition: snapshot.dualSidePosition,
    });
    console.log(`本次最多可平数量: ${closeableQuantity}`);
  }
}

async function promptForOrderInput({ prompter, symbolInfo, rules, snapshot, intent }) {
  const closeableQuantity =
    intent === "close_long" || intent === "close_short"
      ? getCloseableQuantity({
          accountInfo: snapshot.accountInfo,
          symbol: symbolInfo.symbol,
          intent,
          dualSidePosition: snapshot.dualSidePosition,
        })
      : null;

  if (closeableQuantity !== null && compareDecimalStrings(closeableQuantity, "0") <= 0) {
    throw new Error(intent === "close_long" ? "当前没有可平的多头仓位。" : "当前没有可平的空头仓位。");
  }

  const quantity = await prompter.question("请输入数量", {
    defaultValue: closeableQuantity && compareDecimalStrings(closeableQuantity, "0") > 0 ? closeableQuantity : "",
    validate: (value) => {
      try {
        const normalizedQuantity = validateLimitQuantity(value, rules);
        if (closeableQuantity !== null) {
          assertCloseQuantityAllowed({
            accountInfo: snapshot.accountInfo,
            symbol: symbolInfo.symbol,
            intent,
            quantity: normalizedQuantity,
            dualSidePosition: snapshot.dualSidePosition,
          });
        }

        return null;
      } catch (error) {
        return error.message;
      }
    },
  });

  const price = await prompter.question("请输入限价", {
    validate: (value) => {
      try {
        validateLimitPrice(value, rules);
        return null;
      } catch (error) {
        return error.message;
      }
    },
  });

  const leverage =
    intent === "open_long" || intent === "open_short"
      ? await prompter.question("请输入杠杆倍数", {
          defaultValue: "10",
          validate: validateLeverage,
        })
      : null;

  const normalizedQuantity = validateLimitQuantity(quantity, rules);
  const normalizedPrice = validateLimitPrice(price, rules);
  const notional = validateMinNotional(normalizedPrice, normalizedQuantity, rules);

  if (closeableQuantity !== null) {
    assertCloseQuantityAllowed({
      accountInfo: snapshot.accountInfo,
      symbol: symbolInfo.symbol,
      intent,
      quantity: normalizedQuantity,
      dualSidePosition: snapshot.dualSidePosition,
    });
  }

  return {
    quantity: normalizedQuantity,
    price: normalizedPrice,
    leverage: leverage ? String(Number(leverage)) : null,
    notional,
  };
}

function printOrderPreview({ config, snapshot, symbol, intent, quantity, price, leverage, notional }) {
  console.log("");
  console.log("=== 下单确认 ===");
  console.log(`环境: ${config.dryRun ? "dry-run（不会真实下单）" : "实盘"}`);
  console.log(`订单意图: ${describeTradeIntent(intent)}`);
  console.log(`持仓模式: ${describePositionMode(snapshot.dualSidePosition)}`);
  console.log(`交易对: ${symbol}`);
  console.log(`价格: ${price}`);
  console.log(`数量: ${quantity}`);
  console.log(`名义价值: ${notional}`);
  if (leverage) {
    console.log(`杠杆: ${leverage}x`);
  }
}

async function handleTrade({ config, prompter, client, symbolIndex }) {
  const snapshot = await fetchTradingSnapshot(client);
  const intent = await prompter.choose("请选择订单意图", [
    { label: "开多", value: "open_long" },
    { label: "开空", value: "open_short" },
    { label: "平多", value: "close_long" },
    { label: "平空", value: "close_short" },
  ]);
  const symbol = await prompter.question("请输入交易对", {
    validate: (value) => {
      try {
        getSymbolInfo(symbolIndex, value);
        return null;
      } catch (error) {
        return error.message;
      }
    },
  });
  const symbolInfo = getSymbolInfo(symbolIndex, symbol);
  const rules = getSymbolRules(symbolInfo);

  printSymbolContext({ snapshot, symbolInfo, rules, intent });

  const orderInput = await promptForOrderInput({
    prompter,
    symbolInfo,
    rules,
    snapshot,
    intent,
  });

  printOrderPreview({
    config,
    snapshot,
    symbol: symbolInfo.symbol,
    intent,
    quantity: orderInput.quantity,
    price: orderInput.price,
    leverage: orderInput.leverage,
    notional: orderInput.notional,
  });

  const shouldSubmit = await prompter.confirm(
    config.dryRun ? "确认生成 dry-run 请求" : "确认提交到 Binance",
    { defaultValue: false },
  );
  if (!shouldSubmit) {
    console.log("已取消下单。");
    return snapshot;
  }

  if (orderInput.leverage) {
    const leverageResponse = await client.changeLeverage({
      symbol: symbolInfo.symbol,
      leverage: orderInput.leverage,
    });

    if (leverageResponse.dryRun) {
      printDryRunRequest("杠杆设置请求", leverageResponse);
    } else {
      console.log(
        `杠杆已更新: ${leverageResponse.symbol} -> ${leverageResponse.leverage}x (最大名义价值 ${leverageResponse.maxNotionalValue})`,
      );
    }
  }

  const orderInstruction = buildOrderInstruction({
    intent,
    symbol: symbolInfo.symbol,
    quantity: orderInput.quantity,
    price: orderInput.price,
    dualSidePosition: snapshot.dualSidePosition,
  });

  try {
    const orderResponse = await client.createLimitOrder(orderInstruction);
    if (orderResponse.dryRun) {
      printDryRunRequest("下单请求", orderResponse);
      return snapshot;
    }

    console.log(
      `订单已提交: orderId=${orderResponse.orderId} | clientOrderId=${orderResponse.clientOrderId} | side=${orderResponse.side} | positionSide=${orderResponse.positionSide}`,
    );
  } catch (error) {
    if (orderInput.leverage && !config.dryRun) {
      console.error(`下单失败，但 ${symbolInfo.symbol} 的杠杆可能已经被修改为 ${orderInput.leverage}x。`);
    }
    throw error;
  }

  return showAccountOverview(client);
}

async function main() {
  const config = loadTraderConfig();
  const prompter = createPrompter();

  try {
    console.log("Binance Futures Trader CLI");
    console.log(`请求地址: ${config.baseUrl}`);
    console.log(`模式: ${config.dryRun ? "dry-run" : "real trading"}`);

    const resolvedConfig = await ensureCredentials(config, prompter);
    const client = new BinanceFuturesClient(resolvedConfig);
    const exchangeInfo = await client.getExchangeInfo();
    const symbolIndex = buildSymbolIndex(exchangeInfo);

    let currentSnapshot = await showAccountOverview(client);

    while (true) {
      const action = await prompter.choose("请选择操作", [
        { label: "刷新账户信息", value: "refresh" },
        { label: "下限价单", value: "trade" },
        { label: "退出", value: "exit" },
      ]);

      if (action === "exit") {
        break;
      }

      if (action === "refresh") {
        try {
          currentSnapshot = await showAccountOverview(client);
        } catch (error) {
          printError(error);
        }
        continue;
      }

      try {
        currentSnapshot = await handleTrade({
          config: resolvedConfig,
          prompter,
          client,
          symbolIndex,
          snapshot: currentSnapshot,
        });
      } catch (error) {
        printError(error);
      }
    }
  } finally {
    prompter.close();
  }
}

process.on("unhandledRejection", (error) => {
  printError(error);
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  printError(error);
  process.exitCode = 1;
});

void main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
