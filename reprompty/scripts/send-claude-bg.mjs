#!/usr/bin/env node
/**
 * send-claude-bg.mjs - Send message to Claude Code via CDP (background, no focus)
 *
 * Usage:
 *   node send-claude-bg.mjs <message>
 *   node send-claude-bg.mjs "Fix the auth bug"
 *   node send-claude-bg.mjs --port 9222 "Fix the auth bug"
 *
 * Or pipe message from stdin:
 *   echo "Fix the bug" | node send-claude-bg.mjs
 *
 * The CDP port is auto-detected from %APPDATA%/Code/DevToolsActivePort
 * Exit codes: 0 = success, 1 = error
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Parse args
let port = null;
const args = process.argv.slice(2);
let message = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else {
    message += (message ? " " : "") + args[i];
  }
}

// Read from stdin if no message argument
if (!message) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  message = Buffer.concat(chunks).toString("utf-8").trim();
}

if (!message) {
  console.error("Usage: node send-claude-bg.mjs [--port PORT] <message>");
  process.exit(1);
}

// Auto-detect CDP port
if (!port) {
  const appData = process.env.APPDATA;
  if (!appData) {
    console.error("Error: APPDATA not set, use --port to specify CDP port");
    process.exit(1);
  }
  const portFile = path.join(appData, "Code", "DevToolsActivePort");
  try {
    const content = fs.readFileSync(portFile, "utf-8").trim();
    port = parseInt(content.split("\n")[0], 10);
  } catch {
    console.error(`Error: Cannot read ${portFile}. Is VS Code running?`);
    process.exit(1);
  }
}

if (!port || isNaN(port)) {
  console.error("Error: Invalid CDP port");
  process.exit(1);
}

// Fetch CDP targets
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Failed to parse CDP targets")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// Send via CDP WebSocket
async function sendViaCdp() {
  // 1. Get targets
  const targets = await httpGet(`http://127.0.0.1:${port}/json`);

  // 2. Find Claude Code webview
  const claudePatterns = [
    "extensionId=Anthropic.claude-code",
    "extensionId=anthropic.claude-code",
    "claude-code",
  ];
  let target = null;
  for (const pattern of claudePatterns) {
    target = targets.find((t) => t.type === "iframe" && t.url?.includes(pattern));
    if (target) break;
  }
  if (!target) {
    for (const pattern of claudePatterns) {
      target = targets.find((t) => t.url?.includes(pattern));
      if (target) break;
    }
  }
  if (!target) {
    console.error("Error: Claude Code webview not found among CDP targets");
    console.error("Available targets:", targets.map((t) => `${t.type}: ${t.title}`).join(", "));
    process.exit(1);
  }

  // 3. Connect via WebSocket
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WS connect timeout")), 3000);
    ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WS error")); });
  });

  // 4. Inject text into chat input and submit
  const escapedMessage = JSON.stringify(message);
  const expression = `
    (function() {
      var input = document.querySelector('textarea');
      if (!input) input = document.querySelector('[contenteditable="true"]');
      if (!input) input = document.querySelector('input[type="text"]');
      if (!input) return 'input_not_found';

      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        var proto = input.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        var nativeSet = Object.getOwnPropertyDescriptor(proto, 'value');
        if (nativeSet && nativeSet.set) {
          nativeSet.set.call(input, ${escapedMessage});
        } else {
          input.value = ${escapedMessage};
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
        input.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
        return 'sent';
      } else {
        input.textContent = ${escapedMessage};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
        return 'sent';
      }
    })()
  `;

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Evaluate timeout")), 5000);
    const handler = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(msg);
        }
      } catch { /* not our message */ }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true },
    }));
  });

  ws.close();

  const value = result?.result?.result?.value;
  if (value === "sent") {
    console.log(`Sent to Claude Code via CDP (port ${port})`);
    process.exit(0);
  } else {
    console.error(`Error: CDP inject returned: ${value}`);
    if (result?.result?.exceptionDetails) {
      console.error("Exception:", JSON.stringify(result.result.exceptionDetails, null, 2));
    }
    process.exit(1);
  }
}

sendViaCdp().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
