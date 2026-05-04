import { DingTalkNotifier } from "../notifiers/dingtalkNotifier.mjs";
import { FeishuNotifier } from "../notifiers/feishuNotifier.mjs";
import { GenericWebhookNotifier } from "../notifiers/genericWebhookNotifier.mjs";
import { SlackNotifier } from "../notifiers/slackNotifier.mjs";
import { TelegramNotifier } from "../notifiers/telegramNotifier.mjs";
import { WeComNotifier } from "../notifiers/wecomNotifier.mjs";

export function createNotifiers(config) {
  return config.notifierTypes.map((type) => {
    switch (type) {
      case "feishu":
        return new FeishuNotifier(config.notifiers.feishu);
      case "telegram":
        return new TelegramNotifier(config.notifiers.telegram);
      case "wecom":
        return new WeComNotifier(config.notifiers.wecom);
      case "dingtalk":
        return new DingTalkNotifier(config.notifiers.dingtalk);
      case "slack":
        return new SlackNotifier(config.notifiers.slack);
      case "generic_webhook":
        return new GenericWebhookNotifier(config.notifiers.genericWebhook);
      default:
        throw new Error(`Unsupported notifier type: ${type}`);
    }
  });
}
