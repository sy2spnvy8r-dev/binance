export class SlackNotifier {
  constructor({ webhookUrl }) {
    if (!webhookUrl) {
      throw new Error("SLACK_WEBHOOK_URL is required when using slack notifier");
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
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed with status ${response.status}`);
    }
  }
}
