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

function findClaudeCodeTarget(targets: CdpTarget[], windowTitle?: string): CdpTarget | null {
  const claudePatterns = [
    "extensionId=Anthropic.claude-code",
    "extensionId=anthropic.claude-code",
  ];

  // If we have a window title, find the matching page target first,
  // then get the Claude webview iframe that follows it
  if (windowTitle) {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.type === "page" && t.title && windowTitle.includes(t.title.split(" - ").slice(-2).join(" - ").replace(" - Visual Studio Code", "").trim())) {
        // Found the page, look for Claude iframe after it
        for (let j = i + 1; j < targets.length; j++) {
          if (targets[j].type === "page") break; // hit next page, stop
          for (const pattern of claudePatterns) {
            if (targets[j].type === "iframe" && targets[j].url?.includes(pattern)) {
              return targets[j];
            }
          }
        }
      }
    }

    // Try matching by folder name in the page title
    const folderMatch = windowTitle.match(/^(.+?)\s+-\s+(Visual Studio Code|Kilo Code)/);
    const folder = folderMatch ? folderMatch[1].trim() : windowTitle;
    for (let i = 0; i < targets.length; i++) {
      if (targets[i].type === "page" && targets[i].title?.includes(folder)) {
        for (let j = i + 1; j < targets.length; j++) {
          if (targets[j].type === "page") break;
          for (const pattern of claudePatterns) {
            if (targets[j].type === "iframe" && targets[j].url?.includes(pattern)) {
              return targets[j];
            }
          }
        }
      }
    }
  }

  // Fallback: first Claude webview found
  for (const pattern of claudePatterns) {
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
        params: { expression, returnByValue: true },
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
  message: string,
  windowTitle?: string
): Promise<{ success: boolean; error?: string }> {
  let ws: InstanceType<typeof WS> | null = null;

  try {
    const targets = await getCdpTargets(port);
    const target = findClaudeCodeTarget(targets, windowTitle);
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

    // First: inject text
    await cdpEvaluate(
      ws,
      `
      (function() {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        if (!doc) return 'no_contentDocument';
        var input = doc.querySelector('.messageInput_cKsPxg[contenteditable]');
        if (!input) input = doc.querySelector('[contenteditable="plaintext-only"][role="textbox"]');
        if (!input) input = doc.querySelector('[role="textbox"][contenteditable]');
        if (!input) return 'input_not_found';
        input.focus();
        input.textContent = ${escapedMessage};
        input.dispatchEvent(new InputEvent('input', {bubbles:true, data:${escapedMessage}, inputType:'insertText'}));
        return 'injected';
      })()
      `,
      1
    );

    // Small delay then press Enter
    await new Promise((r) => setTimeout(r, 150));

    const enterResult = await cdpEvaluate(
      ws,
      `
      (function() {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        var input = doc.querySelector('.messageInput_cKsPxg[contenteditable]');
        if (!input) input = doc.querySelector('[contenteditable="plaintext-only"][role="textbox"]');
        if (!input) return 'no_input';
        input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
        input.dispatchEvent(new KeyboardEvent('keypress', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
        input.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
        return 'sent';
      })()
      `,
      2
    );

    const value = (enterResult as any)?.result?.result?.value;
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
