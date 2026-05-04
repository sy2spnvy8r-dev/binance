import { createFeishuPayload } from "./feishuMessageFormatter.mjs";

export class FeishuNotifier {
  constructor({ webhookUrl, messageStyle = "interactive_table" }) {
    if (!webhookUrl) {
      throw new Error("FEISHU_WEBHOOK_URL is required when using feishu notifier");
    }

    this.webhookUrl = webhookUrl;
    this.messageStyle = messageStyle;
  }

  async send(message) {
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createFeishuPayload(message, this.messageStyle)),
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Feishu webhook failed with status ${response.status}`);
    }

    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return;
    }

    if (payload.code !== undefined && payload.code !== 0) {
      throw new Error(`Feishu webhook failed with code ${payload.code}: ${payload.msg ?? "unknown error"}`);
    }
  }
}
