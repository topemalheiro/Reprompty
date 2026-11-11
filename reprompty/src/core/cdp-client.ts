import http from "node:http";
import WebSocketLib from "ws";
import { stripEditorSuffix } from "./editor-titles.js";

const WS = WebSocketLib;

export type AgentKind = "claude-code" | "codex" | "kilo-code" | "kimi-code" | "unknown";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  parentId?: string;
}

export interface CdpWindowTargetGroup {
  page: CdpTarget;
  iframes: CdpTarget[];
}

export interface WindowAgentState {
  pageTitle: string;
  activeAgent: AgentKind;
  availableAgents: AgentKind[];
}

interface ViewSwitcherProbe {
  activeLabel: string | null;
  labels: string[];
}

interface SendViaAgentOptions {
  agent: Exclude<AgentKind, "unknown">;
  windowTitle?: string;
  /** Claude Code only: session to switch to before sending (session ID or name). */
  session?: string;
}

export interface ClaudeSessionInfo {
  sessionId: string;
  name: string;
  /** Relative time as the panel shows it ("now", "1m", "19h", "3d"). */
  time: string;
  /** True for the session currently shown in the panel. */
  active: boolean;
}

type ClaudeSessionScriptOptions =
  | { mode: "list"; query?: string }
  | { mode: "select"; session: string };

function normalizeText(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function uniqueAgents(agents: AgentKind[]): AgentKind[] {
  return Array.from(
    new Set(agents.filter((agent): agent is Exclude<AgentKind, "unknown"> => agent !== "unknown"))
  );
}

function windowTitleScore(candidateTitle: string, windowTitle: string): number {
  const normalizedCandidate = normalizeText(candidateTitle);
  const normalizedWindow = normalizeText(windowTitle);
  if (!normalizedCandidate || !normalizedWindow) {
    return -1;
  }
  if (normalizedCandidate === normalizedWindow) {
    return 100;
  }

  const strippedCandidate = normalizeText(stripEditorSuffix(candidateTitle));
  const strippedWindow = normalizeText(stripEditorSuffix(windowTitle));
  if (strippedCandidate && strippedCandidate === strippedWindow) {
    return 90;
  }
  if (normalizedWindow.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedWindow)) {
    return 80;
  }
  if (strippedWindow && strippedCandidate && (strippedWindow.includes(strippedCandidate) || strippedCandidate.includes(strippedWindow))) {
    return 70;
  }

  return -1;
}

export function mapAgentLabelToKind(label?: string | null): AgentKind {
  const normalized = normalizeText(label);
  if (normalized === "claude code") {
    return "claude-code";
  }
  if (normalized === "codex") {
    return "codex";
  }
  if (normalized === "kilo code") {
    return "kilo-code";
  }
  if (normalized === "kimi code") {
    return "kimi-code";
  }
  return "unknown";
}

export function mapTargetUrlToAgent(url?: string | null): AgentKind {
  const normalized = normalizeText(url);
  if (!normalized) {
    return "unknown";
  }
  if (normalized.includes("extensionid=anthropic.claude-code")) {
    return "claude-code";
  }
  if (normalized.includes("extensionid=openai.chatgpt")) {
    return "codex";
  }
  if (normalized.includes("extensionid=kilocode.kilo-code")) {
    return "kilo-code";
  }
  if (normalized.includes("extensionid=kimicode.kimi-code") || normalized.includes("extensionid=moonshot-ai.kimi-code")) {
    return "kimi-code";
  }
  return "unknown";
}

export function groupTargetsByPage(targets: CdpTarget[]): CdpWindowTargetGroup[] {
  const groups: CdpWindowTargetGroup[] = [];
  const byPageId = new Map<string, CdpWindowTargetGroup>();
  for (const target of targets) {
    if (target.type === "page") {
      const group = { page: target, iframes: [] };
      groups.push(group);
      byPageId.set(target.id, group);
    }
  }

  // /json doesn't keep iframes after their page, so follow parentId up to the page.
  const byId = new Map(targets.map((target) => [target.id, target]));
  let currentGroup: CdpWindowTargetGroup | null = null;
  for (const target of targets) {
    if (target.type === "page") {
      currentGroup = byPageId.get(target.id) ?? null;
      continue;
    }
    if (target.type !== "iframe") continue;

    let parentId = target.parentId;
    const seen = new Set<string>();
    while (parentId && !byPageId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    const group = parentId ? byPageId.get(parentId) : currentGroup;
    group?.iframes.push(target);
  }

  return groups;
}

export function findWindowGroupByTitle(
  groups: CdpWindowTargetGroup[],
  windowTitle?: string
): CdpWindowTargetGroup | null {
  if (groups.length === 0) {
    return null;
  }
  if (!windowTitle) {
    return groups.length === 1 ? groups[0] : null;
  }

  let bestGroup: CdpWindowTargetGroup | null = null;
  let bestScore = -1;
  let tied = false;

  for (const group of groups) {
    const score = windowTitleScore(group.page.title, windowTitle);
    if (score > bestScore) {
      bestGroup = group;
      bestScore = score;
      tied = false;
      continue;
    }
    if (score >= 0 && score === bestScore) {
      tied = true;
    }
  }

  if (bestScore < 0 || tied) {
    return null;
  }

  return bestGroup;
}

function findAgentIframeTarget(
  group: CdpWindowTargetGroup,
  agent: Exclude<AgentKind, "unknown">
): CdpTarget | null {
  const exact = group.iframes.find((target) => mapTargetUrlToAgent(target.url) === agent);
  if (exact) return exact;
  // Fallback: if only one iframe exists, assume it's the active agent's webview
  // (handles cases where the extension URL doesn't match our hardcoded patterns)
  if (group.iframes.length === 1) return group.iframes[0];
  return null;
}

async function getCdpTargets(port: number): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const targets = Array.isArray(parsed) ? parsed : [];
          resolve(
            targets.filter(
              (target): target is CdpTarget =>
                Boolean(target?.type && target?.webSocketDebuggerUrl)
            )
          );
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
 * Cheap fingerprint of the open editor windows and their agent webviews: one
 * HTTP request to VS Code, no KWin traffic. Only the workspace part of each
 * title is kept, so switching files inside a window doesn't count as a change.
 */
export async function getCdpWindowSignature(port: number): Promise<string> {
  const targets = await getCdpTargets(port);
  return targets
    .filter(
      (target) =>
        target.type === "page" ||
        (target.type === "iframe" && mapTargetUrlToAgent(target.url) !== "unknown")
    )
    .map((target) => {
      if (target.type !== "page") return target.id;
      const workspace = stripEditorSuffix(target.title).split(" - ").pop() ?? "";
      return `${target.id}:${workspace}`;
    })
    .sort()
    .join("|");
}

function cdpEvaluate(
  ws: InstanceType<typeof WS>,
  expression: string,
  id: number,
  timeoutMs = 8000
): Promise<{ result?: { result?: { value?: unknown; type?: string } } }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("CDP evaluate timed out"));
    }, timeoutMs);

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
        // Ignore unrelated messages
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

function getEvaluationValue(message: {
  result?: { result?: { value?: unknown; type?: string } };
}): unknown {
  return message?.result?.result?.value;
}

async function withTargetSocket<T>(
  target: CdpTarget,
  callback: (ws: InstanceType<typeof WS>) => Promise<T>
): Promise<T> {
  const ws = new WS(target.webSocketDebuggerUrl);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WS connect timeout")),
        3000
      );
      ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection error"));
      });
    });

    return await callback(ws);
  } finally {
    if (ws.readyState === WebSocketLib.OPEN) {
      ws.close();
    }
  }
}

async function probeViewSwitcher(group: CdpWindowTargetGroup): Promise<ViewSwitcherProbe> {
  return withTargetSocket(group.page, async (ws) => {
    const result = await cdpEvaluate(
      ws,
      `
      (() => {
        function findContainer() {
          const selectors = [
            'ul.actions-container[aria-label="Active View Switcher"]',
            '.composite-bar .actions-container',
            '[aria-label="Active View Switcher"]',
            '.composite-bar',
            '.activitybar .actions-container',
            '.sidebar .composite-bar',
          ];
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) return el;
          }
          return null;
        }

        function getLabel(item) {
          const labelNode = item.querySelector('.action-label');
          return (
            labelNode?.getAttribute('aria-label') ||
            labelNode?.getAttribute('title') ||
            labelNode?.textContent?.trim() ||
            item.getAttribute('aria-label') ||
            item.getAttribute('title') ||
            item.getAttribute('data-title') ||
            ''
          );
        }

        function isSelected(item) {
          return (
            item.classList.contains('checked') ||
            item.getAttribute('aria-selected') === 'true' ||
            item.classList.contains('active') ||
            item.getAttribute('aria-current') === 'true' ||
            item.querySelector('.active') !== null
          );
        }

        const container = findContainer();
        if (!container) {
          return { activeLabel: null, labels: [] };
        }

        const items = Array.from(container.querySelectorAll('li.action-item, .action-item'));
        const labels = items
          .map((item) => {
            const label = getLabel(item);
            const selected = isSelected(item);
            return label ? { label, selected } : null;
          })
          .filter((item) => Boolean(item));

        // If nothing reported itself selected, treat the first item as active.
        // VS Code:'s side-panel switcher usually keeps one tab active.
        let active = labels.find((item) => item.selected)?.label ?? null;
        if (!active && labels.length > 0) {
          active = labels[0].label;
        }

        return {
          activeLabel: active,
          labels: labels.map((item) => item.label),
        };
      })()
      `,
      1
    );

    const value = getEvaluationValue(result);
    if (!value || typeof value !== "object") {
      return { activeLabel: null, labels: [] };
    }

    const probe = value as { activeLabel?: unknown; labels?: unknown };
    return {
      activeLabel:
        typeof probe.activeLabel === "string" ? probe.activeLabel : null,
      labels: Array.isArray(probe.labels)
        ? probe.labels.filter((item): item is string => typeof item === "string")
        : [],
    };
  });
}

function buildWindowAgentState(
  group: CdpWindowTargetGroup,
  probe: ViewSwitcherProbe
): WindowAgentState {
  const iframeAgents = group.iframes.map((target) => mapTargetUrlToAgent(target.url));
  const labelAgents = probe.labels.map((label) => mapAgentLabelToKind(label));
  const availableAgents = uniqueAgents([...iframeAgents, ...labelAgents]);
  let activeAgent = mapAgentLabelToKind(probe.activeLabel);
  // If no explicit active tab is selected but agents are loaded, fall back
  // to the first available agent rather than failing to send.
  if (activeAgent === "unknown" && availableAgents.length > 0) {
    activeAgent = availableAgents[0];
  }
  return {
    pageTitle: group.page.title,
    activeAgent,
    availableAgents,
  };
}

export async function getWindowAgentStates(port: number): Promise<WindowAgentState[]> {
  const targets = await getCdpTargets(port);
  const groups = groupTargetsByPage(targets);
  const states: WindowAgentState[] = [];

  for (const group of groups) {
    try {
      const probe = await probeViewSwitcher(group);
      states.push(buildWindowAgentState(group, probe));
    } catch {
      const availableAgents = uniqueAgents(
        group.iframes.map((target) => mapTargetUrlToAgent(target.url))
      );
      states.push({
        pageTitle: group.page.title,
        activeAgent: availableAgents.length > 0 ? availableAgents[0] : "unknown",
        availableAgents,
      });
    }
  }

  return states;
}

export function findWindowAgentState(
  states: WindowAgentState[],
  windowTitle?: string
): WindowAgentState | null {
  if (states.length === 0) {
    return null;
  }
  if (!windowTitle) {
    return states.length === 1 ? states[0] : null;
  }

  let bestState: WindowAgentState | null = null;
  let bestScore = -1;
  let tied = false;

  for (const state of states) {
    const score = windowTitleScore(state.pageTitle, windowTitle);
    if (score > bestScore) {
      bestState = state;
      bestScore = score;
      tied = false;
      continue;
    }
    if (score >= 0 && score === bestScore) {
      tied = true;
    }
  }

  if (bestScore < 0 || tied) {
    return null;
  }

  return bestState;
}

function getSendScript(agent: Exclude<AgentKind, "unknown">, message: string) {
  const escapedMessage = JSON.stringify(message);

  if (agent === "claude-code") {
    return {
      inject: `
      (() => {
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
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${escapedMessage}, inputType: 'insertText' }));
        return 'injected';
      })()
      `,
      submit: `
      (() => {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        var input = doc.querySelector('.messageInput_cKsPxg[contenteditable]');
        if (!input) input = doc.querySelector('[contenteditable="plaintext-only"][role="textbox"]');
        if (!input) input = doc.querySelector('[role="textbox"][contenteditable]');
        if (!input) return 'no_input';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'sent';
      })()
      `,
    };
  }

  if (agent === "codex") {
    return {
      inject: `
      (() => {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        if (!doc) return 'no_contentDocument';
        var input = doc.querySelector('div.ProseMirror[contenteditable="true"]');
        if (!input) input = doc.querySelector('.ProseMirror[contenteditable="true"]');
        if (!input) return 'input_not_found';
        input.focus();
        input.innerHTML = '';
        var paragraph = doc.createElement('p');
        paragraph.textContent = ${escapedMessage};
        input.appendChild(paragraph);
        input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: ${escapedMessage}, inputType: 'insertText' }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${escapedMessage}, inputType: 'insertText' }));
        return 'injected';
      })()
      `,
      submit: `
      (() => {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        var input = doc.querySelector('div.ProseMirror[contenteditable="true"]');
        if (!input) input = doc.querySelector('.ProseMirror[contenteditable="true"]');
        if (!input) return 'no_input';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'sent';
      })()
      `,
    };
  }

  if (agent === "kilo-code") {
    return {
      inject: `
      (() => {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        if (!doc) return 'no_contentDocument';
        var input = doc.querySelector('textarea');
        if (!input) input = doc.querySelector('[role="textbox"]');
        if (!input) return 'input_not_found';
        var setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setValue) return 'no_value_setter';
        input.focus();
        setValue.call(input, ${escapedMessage});
        input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: ${escapedMessage}, inputType: 'insertText' }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: ${escapedMessage}, inputType: 'insertText' }));
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return 'injected';
      })()
      `,
      submit: `
      (() => {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        var input = doc.querySelector('textarea');
        if (!input) input = doc.querySelector('[role="textbox"]');
        if (!input) return 'no_input';
        var sendButton = Array.from(doc.querySelectorAll('button')).find(function (button) {
          if (button.disabled) return false;
          var label = (button.getAttribute('aria-label') || button.textContent || '').toLowerCase();
          return label.includes('send');
        });
        if (sendButton) {
          sendButton.click();
          return 'sent_button';
        }
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'sent';
      })()
      `,
    };
  }

  if (agent === "kimi-code") {
    return {
      inject: `
      (() => {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        if (!doc) return 'no_contentDocument';
        var input = doc.querySelector('textarea');
        if (!input) input = doc.querySelector('[role="textbox"]');
        if (!input) input = doc.querySelector('div[contenteditable="true"]');
        if (!input) return 'input_not_found';
        var setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        input.focus();
        if (setValue && input.tagName === 'TEXTAREA') {
          setValue.call(input, ${escapedMessage});
        } else if (input.isContentEditable) {
          input.innerHTML = '<p>' + ${escapedMessage}.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p>';
        } else {
          input.textContent = ${escapedMessage};
        }
        input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: ${escapedMessage}, inputType: 'insertText' }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: ${escapedMessage}, inputType: 'insertText' }));
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return 'injected';
      })()
      `,
      submit: `
      (() => {
        var iframe = document.querySelector('iframe');
        if (!iframe) return 'no_iframe';
        var doc = iframe.contentDocument;
        var input = doc.querySelector('textarea');
        if (!input) input = doc.querySelector('[role="textbox"]');
        if (!input) input = doc.querySelector('div[contenteditable="true"]');
        if (!input) return 'no_input';
        // Kimi Code: uses React; synthetic button clicks do not trigger its onClick.
        // Dispatch Enter key events on the textarea instead — this is what actually works.
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'sent_enter';
      })()
      `
    };
  }

  return null;
}

async function sendIntoAgentTarget(
  target: CdpTarget,
  agent: Exclude<AgentKind, "unknown">,
  message: string
): Promise<{ success: boolean; error?: string }> {
  const scripts = getSendScript(agent, message);
  if (!scripts) {
    return { success: false, error: `CDP sending is not supported for ${agent}` };
  }

  try {
    return await withTargetSocket(target, async (ws) => {
      const injectResult = await cdpEvaluate(ws, scripts.inject, 1);
      const injectValue = getEvaluationValue(injectResult);
      if (injectValue !== "injected") {
        return {
          success: false,
          error: `CDP inject returned: ${String(injectValue)}`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      const submitResult = await cdpEvaluate(ws, scripts.submit, 2);
      const submitValue = getEvaluationValue(submitResult);
      if (submitValue === "sent" || submitValue === "sent_button" || submitValue === "sent_enter") {
        return { success: true };
      }

      return {
        success: false,
        error: `CDP submit returned: ${String(submitValue)}`,
      };
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function resolveAgentTarget(
  port: number,
  agent: Exclude<AgentKind, "unknown">,
  windowTitle?: string
): Promise<{ target: CdpTarget } | { error: string }> {
  const targets = await getCdpTargets(port);
  const groups = groupTargetsByPage(targets);
  const windowGroup = findWindowGroupByTitle(groups, windowTitle);

  if (!windowGroup) {
    return {
      error: windowTitle
        ? `No unique VS Code CDP target matched "${windowTitle}"`
        : "No unique VS Code CDP target matched the requested agent",
    };
  }

  const iframeTarget = findAgentIframeTarget(windowGroup, agent);
  if (!iframeTarget) {
    return { error: `${agent} webview not found in ${windowGroup.page.title}` };
  }

  return { target: iframeTarget };
}

/**
 * Drives the Claude Code panel's "Session history" dropdown. Rows are
 * button#sessions-list-row-<sessionId>; class names carry a per-build hash
 * suffix (sessionItem_OOQiHg), so they are matched by prefix only.
 * "select" re-opens the dropdown after clicking to confirm the switch, so a
 * prompt is never sent into the wrong session.
 */
function getClaudeSessionScript(options: ClaudeSessionScriptOptions): string {
  return `
  (async () => {
    var opts = ${JSON.stringify(options)};
    var iframe = document.querySelector('iframe');
    var doc = iframe && iframe.contentDocument;
    if (!doc) return { error: 'no_contentDocument' };
    var win = doc.defaultView;
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    async function waitFor(fn, ms) {
      var end = Date.now() + ms;
      while (Date.now() < end) { var v = fn(); if (v) return v; await sleep(50); }
      return fn();
    }
    function listOpen() { return doc.querySelector('[role="dialog"] #sessions-list'); }
    function rows() { return Array.from(doc.querySelectorAll('button[id^="sessions-list-row-"]')); }
    function readRow(b) {
      var name = b.querySelector('[class*="sessionName_"]');
      var time = b.querySelector('[class*="sessionTime_"]');
      return {
        sessionId: b.id.slice('sessions-list-row-'.length),
        name: (name ? name.textContent : '').trim(),
        time: (time ? time.textContent : '').trim(),
        active: /(^|\\s)active_/.test(b.className),
      };
    }
    function rowIds() { return rows().map(function (b) { return b.id; }).join(','); }
    function searchInput() { return doc.querySelector('input[placeholder^="Search sessions"]'); }
    async function setSearch(value) {
      var input = searchInput();
      if (!input) {
        var toggle = doc.querySelector('[aria-label="Search sessions"]');
        if (toggle) { toggle.click(); input = await waitFor(searchInput, 1000); }
      }
      if (!input) return false;
      if (input.value === value) return true;
      var before = rowIds();
      // React controlled input: set through the native setter so onChange fires.
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      await waitFor(function () { return rowIds() !== before; }, 800);
      return true;
    }

    var historyButton = doc.querySelector('[aria-label="Session history"]');
    if (!historyButton) return { error: 'session_history_button_not_found' };
    async function open() {
      if (!listOpen()) historyButton.click();
      if (!(await waitFor(listOpen, 2000))) return false;
      var localTab = Array.from(doc.querySelectorAll('[role="dialog"] button[aria-pressed]')).find(function (b) {
        return b.textContent.trim() === 'Local';
      });
      if (localTab && localTab.getAttribute('aria-pressed') !== 'true') {
        localTab.click();
        await sleep(200);
      }
      await waitFor(function () { return rows().length > 0; }, 1500);
      return true;
    }
    async function close() {
      if (listOpen()) historyButton.click();
      await waitFor(function () { return !listOpen(); }, 1000);
    }

    var wasOpen = Boolean(listOpen());
    if (!(await open())) return { error: 'session_list_did_not_open' };

    if (opts.mode === 'list') {
      var searched = opts.query ? await setSearch(opts.query) : false;
      var listed = rows().map(readRow);
      if (searched) await setSearch('');
      if (!wasOpen) await close();
      return { sessions: listed };
    }

    var wanted = String(opts.session || '').trim();
    var lower = wanted.toLowerCase();
    function pick() {
      var all = rows();
      var byId = all.filter(function (b) { return b.id === 'sessions-list-row-' + wanted; });
      if (byId.length === 1) return { row: byId[0] };
      var exact = all.filter(function (b) { return readRow(b).name.toLowerCase() === lower; });
      if (exact.length === 1) return { row: exact[0] };
      if (exact.length > 1) return { ambiguous: exact.map(readRow) };
      var partial = all.filter(function (b) { return readRow(b).name.toLowerCase().indexOf(lower) !== -1; });
      if (partial.length === 1) return { row: partial[0] };
      if (partial.length > 1) return { ambiguous: partial.map(readRow) };
      return null;
    }

    var initial = rows().map(readRow);
    var found = pick();
    if (!found) {
      // Sessions outside the initial list can still be found by the dropdown's own search.
      await setSearch(wanted);
      await sleep(150);
      found = pick();
    }
    if (!found || !found.row) {
      await setSearch('');
      await close();
      return found && found.ambiguous
        ? { error: 'ambiguous_session', candidates: found.ambiguous }
        : { error: 'session_not_found', visible: initial };
    }

    var selected = readRow(found.row);
    if (selected.active) {
      await setSearch('');
      await close();
      return { selected: selected, verified: true };
    }

    found.row.click();
    await waitFor(function () { return !listOpen(); }, 1500);
    await close();
    await sleep(300);

    if (!(await open())) return { selected: selected, verified: false };
    var nowActive = await waitFor(function () {
      var row = doc.getElementById('sessions-list-row-' + selected.sessionId);
      return row && /(^|\\s)active_/.test(row.className) ? row : null;
    }, 1500);
    await setSearch('');
    await close();
    return { selected: selected, verified: Boolean(nowActive) };
  })()
  `;
}

function describeSessionError(value: Record<string, unknown>): string {
  const error = String(value.error);
  if (error === "ambiguous_session" && Array.isArray(value.candidates)) {
    const names = (value.candidates as ClaudeSessionInfo[])
      .map((session) => `"${session.name}" (${session.sessionId})`)
      .join(", ");
    return `More than one Claude session matches; use the session ID or a longer name: ${names}`;
  }
  if (error === "session_not_found" && Array.isArray(value.visible)) {
    const names = (value.visible as ClaudeSessionInfo[])
      .map((session) => `"${session.name}"`)
      .join(", ");
    return `No Claude session matched. Sessions in this window: ${names || "(none)"}`;
  }
  return `Claude session history returned: ${error}`;
}

async function runClaudeSessionScript(
  target: CdpTarget,
  options: ClaudeSessionScriptOptions
): Promise<Record<string, unknown>> {
  return withTargetSocket(target, async (ws) => {
    const result = await cdpEvaluate(ws, getClaudeSessionScript(options), 1, 20000);
    const value = getEvaluationValue(result);
    if (!value || typeof value !== "object") {
      return { error: `unexpected_result:${String(value)}` };
    }
    return value as Record<string, unknown>;
  });
}

async function selectClaudeSessionInTarget(
  target: CdpTarget,
  session: string
): Promise<{ success: boolean; session?: ClaudeSessionInfo; error?: string }> {
  const value = await runClaudeSessionScript(target, { mode: "select", session });
  if (value.error) {
    return { success: false, error: describeSessionError(value) };
  }
  const selected = value.selected as ClaudeSessionInfo;
  if (!value.verified) {
    return {
      success: false,
      session: selected,
      error: `Clicked Claude session "${selected.name}" but the panel did not switch to it`,
    };
  }
  return { success: true, session: selected };
}

export async function listClaudeSessions(
  port: number,
  options: { windowTitle?: string; query?: string } = {}
): Promise<{ success: boolean; sessions?: ClaudeSessionInfo[]; error?: string }> {
  try {
    const resolved = await resolveAgentTarget(port, "claude-code", options.windowTitle);
    if ("error" in resolved) {
      return { success: false, error: resolved.error };
    }
    const value = await runClaudeSessionScript(resolved.target, {
      mode: "list",
      query: options.query,
    });
    if (value.error) {
      return { success: false, error: describeSessionError(value) };
    }
    return { success: true, sessions: value.sessions as ClaudeSessionInfo[] };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function selectClaudeSession(
  port: number,
  options: { windowTitle?: string; session: string }
): Promise<{ success: boolean; session?: ClaudeSessionInfo; error?: string }> {
  try {
    const resolved = await resolveAgentTarget(port, "claude-code", options.windowTitle);
    if ("error" in resolved) {
      return { success: false, error: resolved.error };
    }
    return await selectClaudeSessionInTarget(resolved.target, options.session);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendViaAgentCdp(
  port: number,
  message: string,
  options: SendViaAgentOptions
): Promise<{ success: boolean; error?: string; session?: ClaudeSessionInfo }> {
  try {
    if (options.session && options.agent !== "claude-code") {
      return {
        success: false,
        error: `Choosing a session is only supported for Claude Code (target agent: ${options.agent})`,
      };
    }

    const resolved = await resolveAgentTarget(port, options.agent, options.windowTitle);
    if ("error" in resolved) {
      return { success: false, error: resolved.error };
    }

    if (options.session) {
      const selection = await selectClaudeSessionInTarget(resolved.target, options.session);
      if (!selection.success) {
        return { success: false, error: selection.error };
      }
      // Give the panel a moment to swap the conversation and its input in.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const sent = await sendIntoAgentTarget(resolved.target, options.agent, message);
      return { ...sent, session: selection.session };
    }

    return sendIntoAgentTarget(resolved.target, options.agent, message);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendViaCdp(
  port: number,
  message: string,
  windowTitle?: string
): Promise<{ success: boolean; error?: string }> {
  return sendViaAgentCdp(port, message, {
    agent: "kilo-code",
    windowTitle,
  });
}

export async function isCdpAvailable(
  port: number,
  agent: Exclude<AgentKind, "unknown"> = "kilo-code"
): Promise<boolean> {
  try {
    const targets = await getCdpTargets(port);
    const groups = groupTargetsByPage(targets);
    return groups.some((group) => Boolean(findAgentIframeTarget(group, agent)));
  } catch {
    return false;
  }
}
