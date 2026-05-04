export class GenericWebhookNotifier {
  constructor({ webhookUrl }) {
    if (!webhookUrl) {
      throw new Error("GENERIC_WEBHOOK_URL is required when using generic_webhook notifier");
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
        text: message,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Generic webhook failed with status ${response.status}`);
    }
  }
}
