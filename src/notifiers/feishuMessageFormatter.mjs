function splitMessageLines(message) {
  return String(message)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
}

function parseMarkdownTable(tableLines) {
  if (tableLines.length < 3) {
    return null;
  }

  const header = tableLines[0]
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  const rows = tableLines
    .slice(2)
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((row) => row.length > 0);

  if (header.length === 0 || rows.length === 0) {
    return null;
  }

  return { header, rows };
}

function buildSummaryMarkdown(lines) {
  return lines
    .map((line) => line.replace(/^([^:：]+)[:：]\s*/, "**$1**: "))
    .join("\n");
}

function inferTableColumn(cellName, index) {
  return {
    name: `col_${index}`,
    display_name: cellName,
    data_type: "text",
  };
}

function buildTableRows(rows, columns) {
  return rows.map((row) =>
    Object.fromEntries(
      columns.map((column, index) => [column.name, row[index] ?? ""]),
    ),
  );
}

function buildTableCard(message) {
  const lines = splitMessageLines(message);
  const title = lines[0] || "监控通知";
  const bodyLines = lines.slice(1);
  const tableStart = bodyLines.findIndex((line) => line.startsWith("|"));
  const infoLines =
    tableStart === -1
      ? bodyLines.filter(Boolean)
      : bodyLines.slice(0, tableStart).filter(Boolean);
  const tableLines = tableStart === -1 ? [] : bodyLines.slice(tableStart).filter(Boolean);
  const table = parseMarkdownTable(tableLines);

  const elements = [];

  if (infoLines.length > 0) {
    elements.push({
      tag: "markdown",
      content: buildSummaryMarkdown(infoLines),
    });
  }

  if (table) {
    const columns = table.header.map((cellName, index) => inferTableColumn(cellName, index));
    const rows = buildTableRows(table.rows, columns);

    elements.push({
      tag: "table",
      columns,
      rows,
    });
  } else if (bodyLines.length > 0) {
    elements.push({
      tag: "markdown",
      content: bodyLines.join("\n"),
    });
  }

  return {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      config: {
        wide_screen_mode: true,
        enable_forward: true,
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      body: {
        elements,
      },
    },
  };
}

export function createFeishuPayload(message, messageStyle = "interactive_table") {
  if (messageStyle === "text") {
    return {
      msg_type: "text",
      content: {
        text: message,
      },
    };
  }

  return buildTableCard(message);
}
