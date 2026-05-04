# Binance Futures Trader CLI

This project now includes an interactive futures trading CLI for manual order entry.

## Features

- Load API credentials from `.env`
- Prompt for API key and secret if they are missing, with an option to save them back to `.env`
- Show account balances and active futures positions
- Detect one-way mode vs hedge mode
- Place manual limit orders with:
  - symbol
  - quantity
  - price
  - leverage
  - trade intent (`open long`, `open short`, `close long`, `close short`)

## Run

```powershell
npm run trader:cli
```

Dry-run mode:

```powershell
npm run trader:cli -- --dry-run
```

## Environment Variables

```env
BINANCE_FUTURES_API_KEY=
BINANCE_FUTURES_API_SECRET=
BINANCE_FUTURES_BASE_URL=https://fapi.binance.com
BINANCE_FUTURES_RECV_WINDOW=5000
BINANCE_FUTURES_DRY_RUN=false
TRADER_ENV_FILE=.env
```

The CLI also accepts `BINANCE_API_KEY` and `BINANCE_API_SECRET` as fallbacks.

## Notes

- The order flow uses the official USD-M Futures REST endpoints:
- `GET /fapi/v3/account`
- `GET /fapi/v1/positionSide/dual`
- `POST /fapi/v1/leverage`
- `POST /fapi/v1/order`
- In one-way mode, buy/sell orders affect the net position.
- Close orders in one-way mode are sent with `reduceOnly=true`.
- Use `--dry-run` first if you want to verify request payloads before sending live orders.
