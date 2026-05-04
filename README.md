# Binance Activity Monitor

一个零依赖的 Node.js 监控器，用来监听 Binance 相关操作，并把检测到的变化推送到飞书、Telegram、企业微信、钉钉、Slack 或通用 Webhook。

## 先说边界

Binance 官方接口并 **不提供任意第三方用户的私有操作流**。这份项目当前实现的是官方支持、可稳定维护的方案：

- 监听你自己账户的用户数据流
- 监听公开跟单项目的仓位接口
- 捕获订单、余额、资金变化或跟单仓位变化
- 通过通讯软件机器人提醒你

如果你想"盯住别人"，通常只适合下面两类公开数据源：

- 对方本来就是公开展示的 copy trading / lead trader 页面
- 对方给你的公开链上地址

这两类都需要公开数据适配器，不能直接走 Binance 私有用户流。

## 当前已支持

- 数据源: `binance_spot_user_stream`, `binance_copy_trade_lead_positions`
- 事件: `executionReport`, `balanceUpdate`, `outboundAccountPosition`, `externalLockUpdate`, `eventStreamTerminated`, `copyTradeLeadPositionsSnapshot`
- 通知器: `feishu`, `telegram`, `wecom`, `dingtalk`, `slack`, `generic_webhook`
- 去重: 本地 JSON 状态文件
- 运行时: Node.js 24+

## 快速开始

1. 复制环境变量模板

```powershell
Copy-Item .env.example .env
```

2. 如果你要监控交易员仓位，填好查询参数、请求头和通知渠道

建议至少配置下面这些：

```env
SOURCE_TYPE=binance_copy_trade_lead_positions
COPY_TRADE_QUERY_PARAMS=topTraderId=4988811260243579393&marketType=UM&page=1&rows=9
COPY_TRADE_POLL_INTERVAL_MS=60000
COPY_TRADE_HEADER_COOKIE=你的最新浏览器Cookie
NOTIFIERS=feishu
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
FEISHU_MESSAGE_STYLE=interactive_table
```

3. 启动

```powershell
npm start
```

或者

```powershell
node --env-file=.env src/index.mjs
```

## 常用配置

```env
MONITOR_EVENTS=copyTradeLeadPositionsSnapshot
SYMBOL_ALLOWLIST=BTCUSDT,ETHUSDT
MESSAGE_PREFIX=[Binance Monitor]
STATE_FILE=.state/events.json
STATE_MAX_ENTRIES=1000
COPY_TRADE_ENTITY_LABEL=交易员ID
COPY_TRADE_ENTITY_VALUE=4988811260243579393
COPY_TRADE_ACTIVE_ONLY=true
COPY_TRADE_INCLUDE_INITIAL_SNAPSHOT=true
COPY_TRADE_SEND_STARTUP_SNAPSHOT=true
COPY_TRADE_RESPONSE_ITEMS_PATH=data
COPY_TRADE_EXPECTED_CODE=000000
COPY_TRADE_HEADER_CSRFTOKEN=
COPY_TRADE_HEADER_BNC_UUID=
COPY_TRADE_HEADER_COOKIE=
COPY_TRADE_HEADER_CLIENTTYPE=web
COPY_TRADE_HEADER_ACCEPT=application/json, text/plain, */*
COPY_TRADE_HEADER_USER_AGENT=Mozilla/5.0
COPY_TRADE_HEADER_REFERER=
COPY_TRADE_HEADER_ORIGIN=
COPY_TRADE_EXTRA_HEADERS_JSON=
COPY_TRADE_STATE_FILE=.state/copy-trade-positions.json
NOTIFIERS=feishu,telegram
```

## 公开跟单项目监控

当前这套监控会轮询你配置的接口，并在仓位变化时推送最新持仓表。默认配置已经切到：

```text
https://www.binance.com/bapi/asset/v1/private/future/smart-money/profile/query-positions
```

默认行为：

- 只推送 **有持仓** 的行
- 第一次启动会发送一条基线快照
- 之后每次程序重启会再主动发一条当前仓位表，方便确认监控正常
- 后续只有在仓位新增、减仓、加仓或平仓时才推送
- 请求头全部从 `.env` 读取，方便你随时更新 `csrftoken`、`bnc-uuid` 和 `cookie`

推送内容会整理成 Markdown 表格，包含：

- 合约
- 方向
- 持仓量
- 开仓价
- 标记价
- 杠杆
- 模式
- 保证金
- 名义价值
- 未实现盈亏

## 事件说明

### `executionReport`

订单相关事件，比如：

- 新挂单
- 成交
- 取消
- 过期
- 下单被拒绝

### `balanceUpdate`

资金余额增减。

### `outboundAccountPosition`

账户余额变化快照。

### `externalLockUpdate`

外部锁仓变化。

### `copyTradeLeadPositionsSnapshot`

监控对象仓位快照变化。

## 私有接口说明

你现在用的是 Binance 的 `private` 接口，这类接口依赖浏览器当前登录态。

- 如果 cookie / csrf 过期，接口会返回 `401`
- 常见报错是 `100001005`，含义是 `Please log in first.`
- 这种情况下不需要改代码，只需要把 `.env` 里的请求头更新成浏览器里最新那组

## 自己账户监控

如果你要监听的是你自己的 Binance 账户事件，改成下面这样：

```env
SOURCE_TYPE=binance_spot_user_stream
MONITOR_EVENTS=executionReport,balanceUpdate,outboundAccountPosition,externalLockUpdate,eventStreamTerminated
BINANCE_API_KEY=your_api_key
BINANCE_API_SECRET=your_api_secret
```

## 通知渠道配置

### 飞书

```env
NOTIFIERS=feishu
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
FEISHU_MESSAGE_STYLE=interactive_table
```

说明：

- `interactive_table`: 用飞书卡片发送，仓位区会渲染成更易读的等宽表格
- `text`: 保持原来的纯文本消息

### Telegram

```env
NOTIFIERS=telegram
TELEGRAM_BOT_TOKEN=123456:ABCDEF
TELEGRAM_CHAT_ID=123456789
```

### 企业微信

```env
NOTIFIERS=wecom
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
```

### 钉钉

```env
NOTIFIERS=dingtalk
DINGTALK_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxxx
```

### Slack

```env
NOTIFIERS=slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
```

## 本地测试

```powershell
npm test
```

## 后续怎么扩展成"盯公开用户"

如果你给的是：

- 一个公开的 Binance lead trader 页面
- 一个公开链上地址
- 一个已经确认合法可访问的公开活动页

那我们可以在 `src/sources/` 下继续新增适配器，把公开页面变化转换成同样的提醒消息格式。
