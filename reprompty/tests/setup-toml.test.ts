import { describe, expect, it } from "vitest";

import { readTomlTable, removeTomlTable, tomlString, upsertTomlTable } from "../src/setup/toml-block.ts";
import { fixtureText } from "./fixtures/setup/temp-home.ts";

const TABLE = "mcp_servers.reprompty";
const BODY = ['command = "/usr/bin/node"', 'args = ["/srv/reprompty/dist/mcp/server.js"]'];

describe("upsertTomlTable", () => {
  it("starts an empty file with the table", () => {
    expect(upsertTomlTable("", TABLE, BODY)).toBe(`[${TABLE}]\n${BODY.join("\n")}\n`);
  });

  it("appends after the existing text, separated by one blank line", () => {
    const text = "# settings\nmodel = \"x\"\n\n\n";
    expect(upsertTomlTable(text, TABLE, BODY)).toBe(`# settings\nmodel = "x"\n\n[${TABLE}]\n${BODY.join("\n")}\n`);
  });

  it("replaces the table in place, also with spaces and quotes in its header", () => {
    const text = [
      "[a]",
      "x = 1",
      "",
      '[ mcp_servers . "reprompty" ]  # ours',
      'command = "old"',
      "",
      "[b]",
      "y = 2",
      "",
    ].join("\n");
    expect(upsertTomlTable(text, TABLE, BODY)).toBe(
      ["[a]", "x = 1", "", `[${TABLE}]`, ...BODY, "", "[b]", "y = 2", ""].join("\n")
    );
  });

  it("removes the table's sub-tables wherever they are", () => {
    const text = [
      `[${TABLE}]`,
      'command = "old"',
      "[mcp_servers.other]",
      'command = "other"',
      `[${TABLE}.env]`,
      'A = "1"',
      "",
      `[${TABLE}.tools.send_prompt]`,
      "enabled = true",
    ].join("\n");
    expect(upsertTomlTable(text, TABLE, BODY)).toBe(
      [`[${TABLE}]`, ...BODY, "[mcp_servers.other]", 'command = "other"'].join("\n")
    );
  });

  it("isn't fooled by look-alike text in strings and comments", () => {
    const text = [
      'notes = """',
      `[${TABLE}]`,
      'command = "inside a string"',
      '"""',
      `# [${TABLE}] in a comment`,
      "list = [",
      `  "[${TABLE}]",`,
      "]",
      "[mcp_servers.reprompty_old]",
      'command = "different name"',
      "",
    ].join("\n");
    const out = upsertTomlTable(text, TABLE, BODY);
    expect(out.startsWith(text)).toBe(true);
    expect(out.slice(text.length)).toBe(`\n[${TABLE}]\n${BODY.join("\n")}\n`);
  });

  it("keeps CRLF line endings", () => {
    const text = "[a]\r\nx = 1\r\n";
    expect(upsertTomlTable(text, TABLE, BODY)).toBe(`[a]\r\nx = 1\r\n\r\n[${TABLE}]\r\n${BODY.join("\r\n")}\r\n`);
  });

  it.each([
    ["an inline table", 'mcp_servers = { other = { command = "x" } }\n'],
    ["dotted keys", 'mcp_servers.other.command = "x"\n'],
    ["an inline entry", '[mcp_servers]\nreprompty = { command = "x" }\n'],
    ["dotted keys inside [mcp_servers]", '[mcp_servers]\nreprompty.command = "x"\n'],
    ["an array of tables", '[[mcp_servers]]\nname = "x"\n'],
  ])("refuses a file that defines mcp_servers with %s", (_, text) => {
    expect(() => upsertTomlTable(text, TABLE, BODY)).toThrow(/by hand/);
    expect(() => removeTomlTable(text, TABLE)).toThrow(/by hand/);
  });

  it("allows other servers defined inline under [mcp_servers]", () => {
    const text = '[mcp_servers]\nother = { command = "x" }\n';
    expect(upsertTomlTable(text, TABLE, BODY)).toBe(`${text}\n[${TABLE}]\n${BODY.join("\n")}\n`);
  });

  it("names the line it can't read, without its content", () => {
    expect(() => upsertTomlTable('ok = 1\nsecret = "abc\n', TABLE, BODY)).toThrow("Can't read line 2 (unterminated string)");
  });
});

describe("removeTomlTable", () => {
  it("removes the table and its sub-tables and nothing else", () => {
    const original = fixtureText("config.toml");
    const added = upsertTomlTable(original, TABLE, [...BODY, `[${TABLE}.env]`, 'A = "1"']);
    expect(removeTomlTable(added, TABLE)).toBe(original);
  });

  it("returns the text unchanged when the table isn't there", () => {
    const text = fixtureText("config.toml");
    expect(removeTomlTable(text, TABLE)).toBe(text);
  });
});

describe("readTomlTable", () => {
  it("reads values, sub-tables included", () => {
    const table = readTomlTable(fixtureText("config-env-subtable.toml"), TABLE);
    expect(table?.values).toEqual({
      command: "/usr/bin/node",
      args: ["/home/example/old-checkout/reprompty/dist/mcp/server.js"],
      env: { ELECTRON_RUN_AS_NODE: "1", OLD_SETTING: "x" },
    });
    expect(table?.entries.map((entry) => entry.key.join("."))).toEqual(["command", "args"]);
  });

  it("reads the quoted header form and inline tables", () => {
    const text = '[mcp_servers."reprompty"]\nargs = [\n  "a", # first\n  "b",\n]\nenv = { X = "1", Y = \'two\' }\ntool_timeout_sec = 1_20\n';
    expect(readTomlTable(text, TABLE)?.values).toEqual({ args: ["a", "b"], env: { X: "1", Y: "two" }, tool_timeout_sec: 120 });
  });

  it("returns null without the table", () => {
    expect(readTomlTable(fixtureText("config.toml"), TABLE)).toBeNull();
  });
});

describe("tomlString", () => {
  it("writes Windows paths and quotes as valid basic strings", () => {
    expect(tomlString('C:\\Users\\example\\Reprompty "beta"')).toBe('"C:\\\\Users\\\\example\\\\Reprompty \\"beta\\""');
    const parsed = readTomlTable(`[${TABLE}]\ncommand = ${tomlString("C:\\Program Files\\x\u007f")}\n`, TABLE);
    expect(parsed?.values.command).toBe("C:\\Program Files\\x\u007f");
  });
});
