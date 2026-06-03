import React, { useEffect, useRef, useState, useCallback } from "react";

interface DetectedWindow {
  pid: number;
  handle: number;
  title: string;
  folderPath: string;
  processName: string;
  desktop?: string;
  isCurrentDesktop?: boolean;
  extension: "kilo-code" | "claude-code" | "codex" | "kimi-code" | "unknown";
  activeAgent: "kilo-code" | "claude-code" | "codex" | "kimi-code" | "unknown";
  availableAgents: Array<"kilo-code" | "claude-code" | "codex" | "kimi-code">;
  backgroundRoute: "ipc-kilo" | "cdp-kilo" | "cdp-claude" | "cdp-codex" | "cdp-kimi" | "foreground";
  pipePath: string | null;
  sendMethod: "background" | "foreground";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  model?: string;
}

interface VoiceState {
  messages: ChatMessage[];
  isRecording: boolean;
  transcript: string;
  selectedModel: "chatgpt" | "gemini";
  selectedWindow: DetectedWindow | null;
  isLoading: boolean;
  sidebarOpen: boolean;
}

interface VoiceDebugTabProps {
  detectedWindows: DetectedWindow[];
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function VoiceDebugTab({ detectedWindows }: VoiceDebugTabProps) {
  const [state, setState] = useState<VoiceState>({
    messages: [],
    isRecording: false,
    transcript: "",
    selectedModel: "chatgpt",
    selectedWindow: detectedWindows[0] || null,
    isLoading: false,
    sidebarOpen: true,
  });

  const [textInput, setTextInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const setPartial = useCallback(
    (partial: Partial<VoiceState>) => {
      setState((prev) => ({ ...prev, ...partial }));
    },
    [setState]
  );

  // Auto-select first window when detectedWindows changes and none selected
  useEffect(() => {
    if (state.selectedWindow === null && detectedWindows.length > 0) {
      setPartial({ selectedWindow: detectedWindows[0] });
    }
  }, [detectedWindows, state.selectedWindow, setPartial]);

  // Scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages, state.isLoading]);

  // Setup Web Speech API
  useEffect(() => {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      return;
    }

    const recognition = new SpeechRecognitionCtor() as SpeechRecognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setPartial({ isRecording: true, transcript: "" });
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      setPartial({ transcript: final || interim });
    };

    recognition.onerror = (_event: SpeechRecognitionErrorEvent) => {
      setPartial({ isRecording: false });
    };

    recognition.onend = () => {
      setPartial((prev) => {
        if (prev.transcript.trim()) {
          return { ...prev, isRecording: false };
        }
        return { ...prev, isRecording: false };
      });
    };

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    };
  }, [setPartial]);

  const startRecording = useCallback(() => {
    if (!recognitionRef.current) {
      setPartial({ transcript: "Speech recognition not supported in this browser." });
      return;
    }
    try {
      recognitionRef.current.start();
    } catch {
      // Already started or other error
    }
  }, [setPartial]);

  const stopRecording = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
    } catch {
      // ignore
    }
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      const userMsg: ChatMessage = {
        id: generateId(),
        role: "user",
        content: content.trim(),
        timestamp: formatTime(new Date()),
      };

      setPartial({
        messages: [...state.messages, userMsg],
        transcript: "",
        isLoading: true,
      });

      // Mock AI response after a short delay
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const folder = state.selectedWindow?.folderPath || "no window selected";
      const runningScripts = detectedWindows.filter(
        (w) => w.activeAgent !== "unknown"
      ).length;

      const assistantMsg: ChatMessage = {
        id: generateId(),
        role: "assistant",
        content: `Debug mode active. Context: ${folder}. I see ${runningScripts} agent window${runningScripts === 1 ? "" : "s"} running. What would you like me to investigate?`,
        timestamp: formatTime(new Date()),
        model: state.selectedModel,
      };

      setPartial({
        messages: [...state.messages, userMsg, assistantMsg],
        isLoading: false,
      });
    },
    [state.messages, state.selectedModel, state.selectedWindow, detectedWindows, setPartial]
  );

  // Send transcript when recording ends
  useEffect(() => {
    if (!state.isRecording && state.transcript.trim() && !state.isLoading) {
      const transcript = state.transcript;
      // Small delay to let onend finish cleanly
      const timer = setTimeout(() => {
        void sendMessage(transcript);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [state.isRecording, state.transcript, state.isLoading, sendMessage]);

  const handleTextSend = useCallback(() => {
    void sendMessage(textInput);
    setTextInput("");
  }, [textInput, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleTextSend();
      }
    },
    [handleTextSend]
  );

  return (
    <div style={styles.panel}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.topBarLeft}>
          <h2 style={styles.panelTitle}>Voice Debug</h2>
          <select
            style={styles.modelSelect}
            value={state.selectedModel}
            onChange={(e) =>
              setPartial({ selectedModel: e.target.value as "chatgpt" | "gemini" })
            }
          >
            <option value="chatgpt">ChatGPT</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
        <div style={styles.topBarRight}>
          <button
            style={styles.sidebarToggle}
            onClick={() => setPartial({ sidebarOpen: !state.sidebarOpen })}
          >
            {state.sidebarOpen ? "Hide Context" : "Show Context"}
          </button>
          <button
            style={{
              ...styles.recordBtn,
              background: state.isRecording ? "#cc3333" : "#cc3333",
              opacity: state.isRecording ? 1 : 0.85,
            }}
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={stopRecording}
            onTouchStart={startRecording}
            onTouchEnd={stopRecording}
            title="Hold to record"
          >
            {state.isRecording ? "●" : "🎤"}
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div style={styles.mainArea}>
        {/* Chat area */}
        <div
          style={{
            ...styles.chatArea,
            flex: state.sidebarOpen ? 1 : undefined,
            width: state.sidebarOpen ? undefined : "100%",
          }}
        >
          <div style={styles.messagesScroll}>
            {state.messages.length === 0 && !state.isLoading && (
              <div style={styles.welcome}>
                <p style={styles.welcomeText}>
                  Hold the 🎤 button to speak, or type a question below.
                </p>
                <p style={styles.welcomeSub}>
                  Selected model: <strong>{state.selectedModel}</strong>
                </p>
              </div>
            )}

            {state.messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  ...styles.messageRow,
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    ...styles.messageBubble,
                    background:
                      msg.role === "user" ? "#4a9eff" : "#1e1e1e",
                    border:
                      msg.role === "user"
                        ? "none"
                        : "1px solid #3d3d3d",
                  }}
                >
                  <div style={styles.messageContent}>{msg.content}</div>
                  <div style={styles.messageMeta}>
                    {msg.timestamp}
                    {msg.model && ` · ${msg.model}`}
                  </div>
                </div>
              </div>
            ))}

            {state.isLoading && (
              <div style={{ ...styles.messageRow, justifyContent: "flex-start" }}>
                <div style={{ ...styles.messageBubble, background: "#1e1e1e", border: "1px solid #3d3d3d" }}>
                  <div style={styles.thinking}>thinking…</div>
                </div>
              </div>
            )}

            {/* Transcript while recording */}
            {state.isRecording && state.transcript && (
              <div style={{ ...styles.messageRow, justifyContent: "flex-end" }}>
                <div style={{ ...styles.messageBubble, background: "#4a9eff", opacity: 0.7 }}>
                  <div style={styles.messageContent}>{state.transcript}</div>
                  <div style={styles.messageMeta}>Recording…</div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div style={styles.inputArea}>
            <input
              style={styles.textInput}
              placeholder="Ask something…"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={state.isLoading}
            />
            <button
              style={styles.sendBtn}
              onClick={handleTextSend}
              disabled={state.isLoading || !textInput.trim()}
            >
              Send
            </button>
          </div>
        </div>

        {/* Context sidebar */}
        {state.sidebarOpen && (
          <div style={styles.sidebar}>
            <div style={styles.sidebarSection}>
              <strong style={styles.sidebarTitle}>Selected Window</strong>
              {state.selectedWindow ? (
                <div style={styles.sidebarCard}>
                  <div style={styles.sidebarValue}>
                    {state.selectedWindow.folderPath || state.selectedWindow.title}
                  </div>
                  <div style={styles.sidebarMeta}>
                    Agent: {state.selectedWindow.activeAgent}
                  </div>
                  <div style={styles.sidebarMeta}>
                    Route: {state.selectedWindow.backgroundRoute}
                  </div>
                  {state.selectedWindow.desktop && (
                    <div style={styles.sidebarMeta}>
                      Desktop: {state.selectedWindow.desktop}
                    </div>
                  )}
                </div>
              ) : (
                <div style={styles.sidebarEmpty}>No window selected</div>
              )}
            </div>

            <div style={styles.sidebarSection}>
              <strong style={styles.sidebarTitle}>Detected Windows</strong>
              {detectedWindows.length === 0 ? (
                <div style={styles.sidebarEmpty}>None detected</div>
              ) : (
                detectedWindows.map((win) => (
                  <button
                    key={win.handle}
                    style={{
                      ...styles.sidebarWindowBtn,
                      border:
                        state.selectedWindow?.handle === win.handle
                          ? "1px solid #4a9eff"
                          : "1px solid #3d3d3d",
                    }}
                    onClick={() => setPartial({ selectedWindow: win })}
                  >
                    <div style={styles.sidebarWinPath}>
                      {win.folderPath || win.title}
                    </div>
                    <div style={styles.sidebarWinAgent}>{win.activeAgent}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "#2d2d2d",
    borderRadius: "8px",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    minHeight: "400px",
  },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "12px",
  },
  topBarLeft: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  panelTitle: {
    margin: 0,
    fontSize: "18px",
  },
  modelSelect: {
    padding: "6px 10px",
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "13px",
  },
  topBarRight: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  sidebarToggle: {
    padding: "6px 12px",
    background: "#333",
    border: "1px solid #4a4a4a",
    borderRadius: "4px",
    color: "#eee",
    cursor: "pointer",
    fontSize: "12px",
  },
  recordBtn: {
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    border: "none",
    color: "#fff",
    fontSize: "18px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
    transition: "opacity 0.15s",
  },
  mainArea: {
    display: "flex",
    gap: "16px",
    flex: 1,
    minHeight: 0,
  },
  chatArea: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  messagesScroll: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "8px",
    minHeight: 0,
  },
  welcome: {
    textAlign: "center",
    padding: "40px 20px",
  },
  welcomeText: {
    color: "#888",
    fontSize: "14px",
    marginBottom: "8px",
  },
  welcomeSub: {
    color: "#666",
    fontSize: "12px",
  },
  messageRow: {
    display: "flex",
    width: "100%",
  },
  messageBubble: {
    maxWidth: "80%",
    padding: "10px 14px",
    borderRadius: "12px",
    fontSize: "13px",
    lineHeight: 1.5,
  },
  messageContent: {
    color: "#fff",
    wordBreak: "break-word",
  },
  messageMeta: {
    color: "rgba(255,255,255,0.6)",
    fontSize: "10px",
    marginTop: "4px",
  },
  thinking: {
    color: "#888",
    fontStyle: "italic",
  },
  inputArea: {
    display: "flex",
    gap: "8px",
    marginTop: "10px",
    paddingTop: "10px",
    borderTop: "1px solid #3d3d3d",
  },
  textInput: {
    flex: 1,
    padding: "10px 12px",
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "14px",
  },
  sendBtn: {
    padding: "10px 18px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  sidebar: {
    width: "260px",
    minWidth: "200px",
    maxWidth: "300px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    borderLeft: "1px solid #3d3d3d",
    paddingLeft: "16px",
    overflowY: "auto",
    maxHeight: "500px",
  },
  sidebarSection: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  sidebarTitle: {
    fontSize: "13px",
    color: "#888",
    display: "block",
  },
  sidebarCard: {
    background: "#1e1e1e",
    border: "1px solid #3d3d3d",
    borderRadius: "6px",
    padding: "10px",
  },
  sidebarValue: {
    color: "#fff",
    fontSize: "12px",
    wordBreak: "break-word",
    marginBottom: "6px",
  },
  sidebarMeta: {
    color: "#888",
    fontSize: "11px",
  },
  sidebarEmpty: {
    color: "#666",
    fontSize: "12px",
    fontStyle: "italic",
  },
  sidebarWindowBtn: {
    background: "#1e1e1e",
    borderRadius: "4px",
    padding: "8px 10px",
    textAlign: "left",
    cursor: "pointer",
    color: "#fff",
    width: "100%",
  },
  sidebarWinPath: {
    fontSize: "12px",
    wordBreak: "break-word",
    marginBottom: "2px",
  },
  sidebarWinAgent: {
    fontSize: "10px",
    color: "#888",
  },
};
