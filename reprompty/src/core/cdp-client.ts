import http from "node:http";
import WebSocketLib from "ws";

const WS = WebSocketLib;

// ============================================================================
// CDP Client - Send messages to Claude Code via Chrome DevTools Protocol
//
// The Claude Code extension's chat input lives inside a nested iframe:
//   webview target → iframe.contentDocument → .messageInput_cKsPxg[contenteditable]
//
// We inject text + dispatch Enter key to submit. Zero focus stealing.
// ============================================================================

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function getCdpTargets(port: number): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Failed to parse CDP targets"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("CDP targets request timed out"));
    });
  });
}

function findClaudeCodeTarget(targets: CdpTarget[]): CdpTarget | null {
  const patterns = [
    "extensionId=Anthropic.claude-code",
    "extensionId=anthropic.claude-code",
  ];

  for (const pattern of patterns) {
    const target = targets.find(
      (t) => t.type === "iframe" && t.url?.includes(pattern)
    );
    if (target) return target;
  }

  return null;
}

function cdpEvaluate(
  ws: InstanceType<typeof WS>,
  expression: string,
  id: number
): Promise<{ result: { value?: unknown; type?: string } }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("CDP evaluate timed out"));
    }, 8000);

    const handler = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg);
          }
        }
      } catch {
        // Not our message
      }
    };

    ws.on("message", handler);
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      })
    );
  });
}

/**
 * Send a message to Claude Code via CDP (background, no focus stealing).
 *
 * Path: webview target → iframe.contentDocument → .messageInput_cKsPxg → inject text → Enter
 */
export async function sendViaCdp(
  port: number,
  message: string
): Promise<{ success: boolean; error?: string }> {
  let ws: InstanceType<typeof WS> | null = null;

  try {
    const targets = await getCdpTargets(port);
    const target = findClaudeCodeTarget(targets);
    if (!target) {
      return { success: false, error: "Claude Code webview not found" };
    }

    ws = new WS(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WS connect timeout")),
        3000
      );
      ws!.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws!.on("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection error"));
      });
    });

    const escapedMessage = JSON.stringify(message);

    const result = await cdpEvaluate(
      ws,
      `
      new Promise(function(resolve) {
        var iframe = document.querySelector('iframe');
        if (!iframe) { resolve('no_iframe'); return; }

        var doc = iframe.contentDocument;
        if (!doc) { resolve('no_contentDocument'); return; }

        var input = doc.querySelector('.messageInput_cKsPxg[contenteditable]');
        if (!input) {
          // Fallback selectors
          input = doc.querySelector('[contenteditable="plaintext-only"][role="textbox"]');
        }
        if (!input) {
          input = doc.querySelector('[role="textbox"][contenteditable]');
        }
        if (!input) { resolve('input_not_found'); return; }

        // Focus and inject text
        input.focus();
        input.textContent = ${escapedMessage};
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          data: ${escapedMessage},
          inputType: 'insertText'
        }));

        // Small delay then press Enter to submit
        setTimeout(function() {
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
          input.dispatchEvent(new KeyboardEvent('keypress', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
          input.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
          resolve('sent');
        }, 100);
      })
      `,
      1
    );

    const value = result?.result?.value;
    if (value === "sent") {
      return { success: true };
    }

    return {
      success: false,
      error: `CDP inject returned: ${String(value)}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (ws && ws.readyState === WebSocketLib.OPEN) {
      ws.close();
    }
  }
}

/**
 * Check if CDP is available and Claude Code webview is reachable
 */
export async function isCdpAvailable(port: number): Promise<boolean> {
  try {
    const targets = await getCdpTargets(port);
    return findClaudeCodeTarget(targets) !== null;
  } catch {
    return false;
  }
}
