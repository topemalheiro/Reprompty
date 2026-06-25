import * as vscode from "vscode";
import { CliChat } from "./cli";

export function activate(context: vscode.ExtensionContext) {
  const chat = new CliChat();

  const provider = new ChatPanelProvider(context.extensionUri, chat);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("wrappy.chatView", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrappy.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.wrappy");
      await vscode.commands.executeCommand("wrappy.chatView.focus");
    })
  );
}

class ChatPanelProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chat: CliChat
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Replay existing history when the view is reopened.
    for (const message of this.chat.getHistory()) {
      webviewView.webview.postMessage({
        type: "addMessage",
        role: message.role,
        content: message.content,
      });
    }

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "send") {
        webviewView.webview.postMessage({
          type: "addMessage",
          role: "user",
          content: message.text,
        });

        try {
          const reply = await this.chat.send(message.text);
          webviewView.webview.postMessage({
            type: "addMessage",
            role: "assistant",
            content: reply,
          });
        } catch (err) {
          webviewView.webview.postMessage({
            type: "addMessage",
            role: "assistant",
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (message.type === "clear") {
        this.chat.clear();
        webviewView.webview.postMessage({ type: "clear" });
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "chat.js")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wrappy</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-panel-background);
      margin: 0;
      padding: 8px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      margin-bottom: 8px;
    }
    .message {
      padding: 8px;
      margin-bottom: 6px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
    #toolbar {
      display: flex;
      gap: 6px;
      margin-bottom: 6px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    #input {
      width: 100%;
      min-height: 60px;
      resize: vertical;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px;
      font-family: var(--vscode-font-family);
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-clear">Clear</button>
  </div>
  <div id="messages"></div>
  <textarea id="input" placeholder="Type a message..."></textarea>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
