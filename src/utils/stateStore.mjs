import fs from "node:fs/promises";
import path from "node:path";

export class StateStore {
  constructor(filePath, maxEntries = 1000) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.seenEventIds = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.seenEventIds = Array.isArray(parsed.seenEventIds)
        ? parsed.seenEventIds.slice(-this.maxEntries)
        : [];
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.save();
    }

    this.loaded = true;
  }

  has(eventId) {
    return this.seenEventIds.includes(eventId);
  }

  async add(eventId) {
    this.seenEventIds.push(eventId);
    if (this.seenEventIds.length > this.maxEntries) {
      this.seenEventIds = this.seenEventIds.slice(-this.maxEntries);
    }
    await this.save();
  }

  async save() {
    const body = JSON.stringify(
      {
        seenEventIds: this.seenEventIds,
      },
      null,
      2,
    );

    await fs.writeFile(this.filePath, `${body}\n`, "utf8");
  }
}
