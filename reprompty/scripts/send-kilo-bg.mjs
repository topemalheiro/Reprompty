#!/usr/bin/env node
/**
 * send-kilo-bg.mjs - Send message to Kilo Code via IPC pipe (background, no focus)
 *
 * Usage:
 *   node send-kilo-bg.mjs <socket-path> <message>
 *   node send-kilo-bg.mjs \\.\pipe\kilo-ipc-12345 "Fix the auth bug"
 *
 * Or pipe message from stdin:
 *   echo "Fix the bug" | node send-kilo-bg.mjs \\.\pipe\kilo-ipc-12345
 *
 * Exit codes: 0 = success, 1 = error
 */

import ipc from "node-ipc";
import crypto from "node:crypto";

const socketPath = process.argv[2];
let message = process.argv.slice(3).join(" ");

if (!socketPath) {
  console.error("Usage: node send-kilo-bg.mjs <socket-path> [message]");
  console.error("  socket-path: e.g. \\\\.\\pipe\\kilo-ipc-12345");
  process.exit(1);
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
  console.error("Error: No message provided");
  process.exit(1);
}

const id = `reprompty-send-${crypto.randomBytes(4).toString("hex")}`;
let clientId = null;

ipc.config.silent = true;

ipc.connectTo(id, socketPath, () => {
  const conn = ipc.of[id];

  const timeout = setTimeout(() => {
    console.error("Error: Connection timed out (5s)");
    ipc.disconnect(id);
    process.exit(1);
  }, 5000);

  conn.on("connect", () => {
    // Wait for Ack before sending
  });

  conn.on("disconnect", () => {
    if (!clientId) {
      clearTimeout(timeout);
      console.error("Error: Disconnected before Ack received");
      process.exit(1);
    }
  });

  conn.on("message", (data) => {
    if (typeof data !== "object") return;

    // Handle Ack from server
    if (data.type === "Ack" && data.origin === "server") {
      clientId = data.data.clientId;
      clearTimeout(timeout);

      // Send the message
      conn.emit("message", {
        type: "TaskCommand",
        origin: "client",
        clientId,
        data: {
          commandName: "SendMessage",
          data: { text: message },
        },
      });

      console.log(`Sent to ${socketPath} (clientId: ${clientId})`);

      // Give it a moment to flush, then disconnect
      setTimeout(() => {
        ipc.disconnect(id);
        process.exit(0);
      }, 200);
    }
  });
});
