export class WeComNotifier {
  constructor({ webhookUrl }) {
    if (!webhookUrl) {
      throw new Error("WECOM_WEBHOOK_URL is required when using wecom notifier");
    }

    this.webhookUrl = webhookUrl;
  }

  async send(message) {
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msgtype: "text",
        text: {
          content: message,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`WeCom webhook failed with status ${response.status}`);
    }
  }
}
