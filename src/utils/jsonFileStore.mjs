import fs from "node:fs/promises";
import path from "node:path";

export class JsonFileStore {
  constructor(filePath, fallbackValue = {}) {
    this.filePath = filePath;
    this.fallbackValue = fallbackValue;
    this.value = fallbackValue;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) {
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.value = JSON.parse(raw);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.value = this.fallbackValue;
      await this.save();
    }

    this.loaded = true;
  }

  get() {
    return this.value;
  }

  async set(nextValue) {
    this.value = nextValue;
    await this.save();
  }

  async save() {
    const body = JSON.stringify(this.value, null, 2);
    await fs.writeFile(this.filePath, `${body}\n`, "utf8");
  }
}
