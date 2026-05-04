import { BinanceCopyTradeLeadPositionsSource } from "./binanceCopyTradeLeadPositionsSource.mjs";
import { BinanceSpotUserStreamSource } from "./binanceSpotUserStreamSource.mjs";

export function createSource(config) {
  switch (config.sourceType) {
    case "binance_spot_user_stream":
      return new BinanceSpotUserStreamSource(config.binance);
    case "binance_copy_trade_lead_positions":
      return new BinanceCopyTradeLeadPositionsSource({
        ...config.copyTrade,
        symbolAllowlist: config.symbolAllowlist,
      });
    case "public_user_placeholder":
      throw new Error(
        "SOURCE_TYPE=public_user_placeholder is reserved for public data adapters. Binance does not offer an official private activity stream for arbitrary third-party users.",
      );
    default:
      throw new Error(`Unsupported source type: ${config.sourceType}`);
  }
}
