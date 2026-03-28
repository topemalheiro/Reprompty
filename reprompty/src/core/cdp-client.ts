import http from "node:http";

// Use globalThis.WebSocket which is available in Electron's main process (Node 22+)
// Falls back to a minimal raw socket implementation if needed
const WS = globalThis.WebSocket;

// ============================================================================
// CDP Client - Send messages to Claude Code via Chrome DevTools Protocol
// ============================================================================

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Fetch all CDP targets from VS Code's debug port
 */
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

/**
 * Find the Claude Code webview target among CDP targets
 */
function findClaudeCodeTarget(targets: CdpTarget[]): CdpTarget | null {
  // Claude Code extension ID in the webview URL
  const claudePatterns = [
    "extensionId=Anthropic.claude-code",
    "extensionId=anthropic.claude-code",
    "claude-code",
  ];

  // Prefer iframe type (the actual webview content)
  for (const pattern of claudePatterns) {
    const iframe = targets.find(
      (t) => t.type === "iframe" && t.url?.includes(pattern)
    );
    if (iframe) return iframe;
  }

  // Fall back to any matching target
  for (const pattern of claudePatterns) {
    const any = targets.find((t) => t.url?.includes(pattern));
    if (any) return any;
  }

  return null;
}

/**
 * Send a CDP Runtime.evaluate command via WebSocket
 */
function cdpEvaluate(
  ws: InstanceType<typeof WS>,
  expression: string,
  id: number
): Promise<{ result: { value?: unknown; type?: string } }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("CDP evaluate timed out"));
    }, 5000);

    const handler = (event: MessageEvent | { data: string }) => {
      try {
        const raw = typeof event === "object" && "data" in event ? event.data : String(event);
        const msg = JSON.parse(String(raw));
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler as EventListener);
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg);
          }
        }
      } catch {
        // Not our message, ignore
      }
    };

    ws.addEventListener("message", handler as EventListener);
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
        },
      })
    );
  });
}

/**
 * Send a message to Claude Code via CDP (background, no focus stealing).
 *
 * Flow:
 * 1. GET http://127.0.0.1:{port}/json to list all CDP targets
 * 2. Find the Claude Code webview iframe
 * 3. Connect via WebSocket to the target's debug URL
 * 4. Use Runtime.evaluate to find the input element and inject text + submit
 */
export async function sendViaCdp(
  port: number,
  message: string
): Promise<{ success: boolean; error?: string }> {
  let ws: InstanceType<typeof WS> | null = null;

  try {
    // 1. Get targets
    const targets = await getCdpTargets(port);

    // 2. Find Claude Code webview
    const target = findClaudeCodeTarget(targets);
    if (!target) {
      return {
        success: false,
        error: "Claude Code webview not found among CDP targets",
      };
    }

    // 3. Connect via WebSocket
    ws = new WS(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WS connect timeout")), 3000);
      ws!.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws!.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection error"));
      });
    });

    // 4. Inject text into the chat input and submit
    const escapedMessage = JSON.stringify(message);
    const result = await cdpEvaluate(
      ws,
      `
      (function() {
        // Find textarea or contenteditable input
        var input = document.querySelector('textarea');
        if (!input) input = document.querySelector('[contenteditable="true"]');
        if (!input) input = document.querySelector('input[type="text"]');
        if (!input) return 'input_not_found';

        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          // Use native setter to trigger React's onChange
          var nativeSet = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          );
          if (!nativeSet && input.tagName === 'INPUT') {
            nativeSet = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            );
          }
          if (nativeSet && nativeSet.set) {
            nativeSet.set.call(input, ${escapedMessage});
          } else {
            input.value = ${escapedMessage};
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));

          // Submit via Enter
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
          input.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
          return 'sent';
        } else {
          // contenteditable
          input.textContent = ${escapedMessage};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
          return 'sent';
        }
      })()
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
    if (ws && ws.readyState === WS.OPEN) {
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
