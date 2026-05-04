import readline from "node:readline/promises";
import { Writable } from "node:stream";

class MutableOutput extends Writable {
  constructor(target) {
    super();
    this.target = target;
    this.muted = false;
  }

  _write(chunk, encoding, callback) {
    if (!this.muted) {
      this.target.write(chunk, encoding);
    }

    callback();
  }
}

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const mutableOutput = new MutableOutput(output);
  const rl = readline.createInterface({
    input,
    output: mutableOutput,
    terminal: true,
  });

  async function question(message, { defaultValue = "", allowEmpty = false, validate } = {}) {
    while (true) {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = (await rl.question(`${message}${suffix}: `)).trim();
      const finalValue = answer || defaultValue;

      if (!finalValue && !allowEmpty) {
        output.write("请输入内容。\n");
        continue;
      }

      const errorMessage = validate ? validate(finalValue) : null;
      if (errorMessage) {
        output.write(`${errorMessage}\n`);
        continue;
      }

      return finalValue;
    }
  }

  async function secret(message, { allowEmpty = false } = {}) {
    while (true) {
      output.write(`${message}: `);
      mutableOutput.muted = true;
      const answer = (await rl.question("")).trim();
      mutableOutput.muted = false;
      output.write("\n");

      if (!answer && !allowEmpty) {
        output.write("请输入内容。\n");
        continue;
      }

      return answer;
    }
  }

  async function confirm(message, { defaultValue = false } = {}) {
    while (true) {
      const suffix = defaultValue ? "Y/n" : "y/N";
      const answer = (await rl.question(`${message} [${suffix}]: `)).trim().toLowerCase();
      if (!answer) {
        return defaultValue;
      }

      if (answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no") {
        return false;
      }

      output.write("请输入 y 或 n。\n");
    }
  }

  async function choose(message, choices) {
    output.write(`${message}\n`);
    for (const [index, choice] of choices.entries()) {
      output.write(`${index + 1}. ${choice.label}\n`);
    }

    while (true) {
      const answer = (await rl.question("请选择编号: ")).trim();
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return choices[index - 1].value;
      }

      output.write("请输入有效编号。\n");
    }
  }

  return {
    question,
    secret,
    confirm,
    choose,
    close() {
      rl.close();
    },
  };
}
