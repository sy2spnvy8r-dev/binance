export class TelegramNotifier {
  constructor({ botToken, chatId }) {
    if (!botToken || !chatId) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when using telegram notifier",
      );
    }

    this.url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    this.chatId = chatId;
  }

  async send(message) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: message,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with status ${response.status}`);
    }
  }
}
