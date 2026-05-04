# Binance Futures Trader Web

本项目默认提供本地网页面板版合约交易工具，也适合直接部署到服务器后从你本地浏览器访问。

## 功能

- 在浏览器里配置 Binance Futures API Key / Secret
- 支持一键切换正式盘 / 测试网，并可测试接口连通性
- 选择是否把配置写回 `.env`
- 查看合约账户概览、资产余额和当前持仓
- 自动识别单向持仓模式或双向持仓模式
- 手动输入交易方向、交易对、数量、价格、杠杆
- 查看持仓合约分析：资金费率、持仓量、多空比、主动买卖量和简单信号
- 自动拉取合约候选分析，并展示方向、入场价、止损止盈和信心分
- 测试网自动交易模式：按自动分析的入场价、杠杆、止损、止盈挂单
- 自动拉取当天币安广场内容作为辅助情绪；也支持手动粘贴文本或链接补充分析
- 先预览订单，再决定是否提交
- 支持 `dry-run`，先检查请求再决定是否实盘

## 启动

```powershell
npm run trader
```

本机打开：

```text
http://127.0.0.1:4580
```

如果要以 dry-run 启动：

```powershell
npm run trader -- --dry-run
```

## 环境变量

```env
BINANCE_FUTURES_API_KEY=
BINANCE_FUTURES_API_SECRET=
BINANCE_FUTURES_BASE_URL=https://fapi.binance.com
BINANCE_FUTURES_RECV_WINDOW=5000
BINANCE_FUTURES_DRY_RUN=false
TRADER_ENV_FILE=.env
TRADER_WEB_HOST=0.0.0.0
TRADER_WEB_PORT=4581
```

测试网 / Demo：

```env
BINANCE_FUTURES_BASE_URL=https://demo-fapi.binance.com
```

测试网必须使用 Futures Testnet / Demo 单独生成的 API Key，正式盘 Key 不能通用。

## 测试网自动交易

默认关闭，只允许测试网运行：

```env
BINANCE_FUTURES_BASE_URL=https://demo-fapi.binance.com
BINANCE_FUTURES_DRY_RUN=false
AUTO_TRADE_ENABLED=true
AUTO_TRADE_TESTNET_ONLY=false
AUTO_TRADE_INITIAL_CAPITAL_USDT=0
AUTO_TRADE_MAX_OPEN_POSITIONS=0
AUTO_TRADE_ORDER_MARGIN_USDT=20
AUTO_TRADE_MIN_ORDER_MARGIN_USDT=10
AUTO_TRADE_MAX_ORDERS_PER_RUN=3
AUTO_TRADE_MIN_CONFIDENCE=70
AUTO_TRADE_MAX_TOTAL_RISK_USDT=30
AUTO_TRADE_INTERVAL_MS=900000
AUTO_TRADE_ENTRY_ORDER_TTL_MS=600000
AUTO_TRADE_PROTECTION_RETRY_MS=15000
AUTO_TRADE_SPLIT_TP_ENABLED=true
AUTO_TRADE_TRAILING_CALLBACK_RATE=0.8
AUTO_TRADE_REGIME_GATE_ENABLED=true
AUTO_TRADE_REGIME_SYMBOL=BTCUSDT
AUTO_TRADE_SHADOW_MODE_ENABLED=true
AUTO_TRADE_AUDIT_ENABLED=true
AUTO_TRADE_SHADOW_STATE_FILE=.state/strategy-shadow.json
AUTO_TRADE_AUDIT_LOG_FILE=.state/strategy-audit.jsonl
AUTO_TRADE_SHADOW_FEE_RATE=0.0005
AUTO_TRADE_STATE_FILE=.state/auto-trade-real-default.json
AUTO_TRADE_FEISHU_ENABLED=true
AUTO_TRADE_FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/c6012a11-73e4-49a4-9e1b-e7a2b509d93a
TRADER_ACCOUNTS_JSON=[{"id":"main","label":"主账户","apiKey":"你的真实盘KEY","apiSecret":"你的真实盘SECRET"},{"id":"sub1","label":"子账户1","apiKey":"子账户KEY","apiSecret":"子账户SECRET"}]
```

也可以在网页的“多账户 API”区域直接添加/删除账户并保存。API Secret 不会回显；已有账户留空表示不修改旧 Secret。保存后会写入 `.env`，需要重启服务后自动交易才会按新账户运行。

自动交易预算优先读取每个 Binance 合约账户的真实余额和可用余额；`AUTO_TRADE_INITIAL_CAPITAL_USDT` 只作为读不到账户余额时的兜底值。`AUTO_TRADE_MAX_OPEN_POSITIONS=0` 表示不按仓位数限制，只要可用余额达到最低下单保证金就继续操作。自动交易会按候选里的 `entryPrice / leverage / stopLoss / takeProfit` 下限价开仓，并挂保护单。

## 服务器部署

1. 把整个项目目录上传到服务器。
2. 在服务器项目目录里确认 `.env` 至少包含：

```env
TRADER_WEB_HOST=0.0.0.0
TRADER_WEB_PORT=4581
```

3. 在服务器里启动：

```powershell
npm run trader
```

4. 在你本地浏览器打开：

```text
http://服务器IP:4580
```

5. 如果你本地打不开，请检查：

- 服务器防火墙是否放行 `4580`
- 云厂商安全组或入站规则是否放行 `4580`
- 服务器上是否真的启动了该服务

## 说明

- 当前下单流程使用的是 Binance 官方 USD-M Futures REST 接口。
- 分析面板使用公开合约行情接口，默认每 30 秒刷新一次。
- 自动分析使用公开合约行情接口，默认 15 分钟刷新一次。
- 如果开启 `AUTO_FEISHU_ENABLED=true`，Web 服务会按 `AUTO_FEISHU_INTERVAL_MS` 自动扫描并推送飞书。
- 币安广场读取使用 Binance 网页公开接口/页面抓取，默认 10 分钟刷新一次；接口变动时会降级为“广场数据暂不可用”，不影响下单。
- 旧的命令行版本仍然保留，可以用 `npm run trader:cli` 启动。
