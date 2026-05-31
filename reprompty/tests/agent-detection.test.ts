import { describe, expect, it } from "bun:test";
import {
  findWindowAgentState,
  groupTargetsByPage,
  mapAgentLabelToKind,
  mapTargetUrlToAgent,
  type CdpTarget,
  type WindowAgentState,
} from "../src/core/cdp-client.ts";
import { resolveBackgroundRoute } from "../src/platform/windows.ts";

describe("agent detection helpers", () => {
  it("maps side-panel labels to agent kinds", () => {
    expect(mapAgentLabelToKind("Claude Code")).toBe("claude-code");
    expect(mapAgentLabelToKind("Codex")).toBe("codex");
    expect(mapAgentLabelToKind("Kilo Code")).toBe("kilo-code");
    expect(mapAgentLabelToKind("Unknown")).toBe("unknown");
  });

  it("maps iframe target urls to agent kinds", () => {
    expect(
      mapTargetUrlToAgent(
        "vscode-webview://123?extensionId=Anthropic.claude-code"
      )
    ).toBe("claude-code");
    expect(
      mapTargetUrlToAgent(
        "vscode-webview://123?extensionId=openai.chatgpt"
      )
    ).toBe("codex");
    expect(
      mapTargetUrlToAgent(
        "vscode-webview://123?extensionId=kilocode.kilo-code"
      )
    ).toBe("kilo-code");
  });

  it("groups page targets with the iframe targets that follow them", () => {
    const targets: CdpTarget[] = [
      {
        id: "page-1",
        type: "page",
        title: "Repo A - Visual Studio Code",
        url: "https://page-a",
        webSocketDebuggerUrl: "ws://page-a",
      },
      {
        id: "iframe-claude",
        type: "iframe",
        title: "",
        url: "vscode-webview://?extensionId=Anthropic.claude-code",
        webSocketDebuggerUrl: "ws://iframe-claude",
      },
      {
        id: "iframe-codex",
        type: "iframe",
        title: "",
        url: "vscode-webview://?extensionId=openai.chatgpt",
        webSocketDebuggerUrl: "ws://iframe-codex",
      },
      {
        id: "page-2",
        type: "page",
        title: "Repo B - Visual Studio Code",
        url: "https://page-b",
        webSocketDebuggerUrl: "ws://page-b",
      },
      {
        id: "iframe-kilo",
        type: "iframe",
        title: "",
        url: "vscode-webview://?extensionId=kilocode.kilo-code",
        webSocketDebuggerUrl: "ws://iframe-kilo",
      },
    ];

    const groups = groupTargetsByPage(targets);
    expect(groups).toHaveLength(2);
    expect(groups[0].page.id).toBe("page-1");
    expect(groups[0].iframes.map((target) => target.id)).toEqual([
      "iframe-claude",
      "iframe-codex",
    ]);
    expect(groups[1].page.id).toBe("page-2");
    expect(groups[1].iframes.map((target) => target.id)).toEqual([
      "iframe-kilo",
    ]);
  });

  it("matches window agent state by the visible VS Code title", () => {
    const states: WindowAgentState[] = [
      {
        pageTitle: "Mascot.txt - Reprompty - Visual Studio Code",
        activeAgent: "codex",
        availableAgents: ["claude-code", "codex"],
      },
      {
        pageTitle: "mcp_settings.json - Aperant-MCP - Visual Studio Code",
        activeAgent: "claude-code",
        availableAgents: ["claude-code", "codex"],
      },
    ];

    expect(
      findWindowAgentState(
        states,
        "Mascot.txt - Reprompty - Visual Studio Code"
      )?.activeAgent
    ).toBe("codex");
    expect(
      findWindowAgentState(states, "Reprompty - Visual Studio Code")
        ?.activeAgent
    ).toBe("codex");
  });

  it("resolves background route from the active agent instead of raw CDP availability", () => {
    expect(
      resolveBackgroundRoute("claude-code", ["claude-code", "codex"], false)
    ).toBe("cdp-claude");
    expect(
      resolveBackgroundRoute("codex", ["claude-code", "codex"], false)
    ).toBe("cdp-codex");
    expect(resolveBackgroundRoute("kilo-code", ["kilo-code"], true)).toBe(
      "ipc-kilo"
    );
    expect(resolveBackgroundRoute("kilo-code", ["kilo-code"], false)).toBe(
      "cdp-kilo"
    );
    expect(
      resolveBackgroundRoute("unknown", ["claude-code", "codex"], false)
    ).toBe("foreground");
  });
});
