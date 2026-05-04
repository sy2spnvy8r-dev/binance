import fs from "node:fs/promises";
import path from "node:path";

function serializeEnvValue(value) {
  const rawValue = String(value ?? "");
  if (!rawValue) {
    return "";
  }

  if (/^[A-Za-z0-9_./:-]+$/.test(rawValue)) {
    return rawValue;
  }

  return `'${rawValue.replaceAll("'", "\\'")}'`;
}

export async function upsertEnvFile(envFile, updates) {
  let content = "";
  try {
    content = await fs.readFile(envFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content ? content.split(/\r?\n/) : [];
  const seenKeys = new Set();
  const nextLines = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!(key in updates)) {
      return line;
    }

    seenKeys.add(key);
    return `${key}=${serializeEnvValue(updates[key])}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (seenKeys.has(key)) {
      continue;
    }

    nextLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  let output = nextLines.join(newline).replace(/\s+$/, "");
  if (output) {
    output = `${output}${newline}`;
  }

  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, output, "utf8");
}
