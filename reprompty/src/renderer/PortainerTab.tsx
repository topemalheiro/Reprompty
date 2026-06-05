import React, { useEffect, useRef, useState } from "react";

export default function PortainerTab() {
  const webviewRef = useRef<HTMLWebViewElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graphitiRunning, setGraphitiRunning] = useState(false);
  const [graphitiMessage, setGraphitiMessage] = useState("");

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleLoadStart = () => {
      setIsLoading(true);
      setError(null);
    };

    const handleLoadStop = () => {
      setIsLoading(false);
    };

    const handleFailLoad = (event: Event) => {
      const e = event as any;
      setIsLoading(false);
      setError(`Failed to load Portainer: ${e.errorDescription || "unknown error"}`);
    };

    webview.addEventListener("did-start-loading", handleLoadStart);
    webview.addEventListener("did-stop-loading", handleLoadStop);
    webview.addEventListener("did-fail-load", handleFailLoad);

    return () => {
      webview.removeEventListener("did-start-loading", handleLoadStart);
      webview.removeEventListener("did-stop-loading", handleLoadStop);
      webview.removeEventListener("did-fail-load", handleFailLoad);
    };
  }, []);

  useEffect(() => {
    checkGraphitiStatus();
    const interval = setInterval(checkGraphitiStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const checkGraphitiStatus = async () => {
    try {
      const s = await window.electronAPI.graphitiStatus();
      setGraphitiRunning(s.running);
    } catch {
      setGraphitiRunning(false);
    }
  };

  const handleGraphitiStart = async () => {
    setGraphitiMessage("Starting Graphiti MCP...");
    try {
      const result = await window.electronAPI.graphitiStart();
      if (result.success) {
        setGraphitiMessage("Graphiti MCP started");
      } else {
        setGraphitiMessage(`Start failed: ${result.error}`);
      }
    } catch (err) {
      setGraphitiMessage(`Error: ${err}`);
    }
    checkGraphitiStatus();
  };

  const handleGraphitiStop = async () => {
    setGraphitiMessage("Stopping Graphiti MCP...");
    try {
      const result = await window.electronAPI.graphitiStop();
      if (result.success) {
        setGraphitiMessage("Graphiti MCP stopped");
      } else {
        setGraphitiMessage(`Stop failed: ${result.error}`);
      }
    } catch (err) {
      setGraphitiMessage(`Error: ${err}`);
    }
    checkGraphitiStatus();
  };

  const handleGraphitiOpenUI = () => {
    window.open("http://localhost:8000/mcp/", "_blank");
  };

  const handleReload = () => {
    webviewRef.current?.reload();
  };

  const handleOpenExternal = () => {
    window.open("https://localhost:9443", "_blank");
  };

  return (
    <div style={styles.panel}>
      <div style={styles.headerRow}>
        <div style={styles.headerLeft}>
          <h2 style={styles.panelTitle}>Portainer</h2>
          {isLoading && <span style={styles.loadingText}>Loading…</span>}
        </div>
        <div style={styles.headerActions}>
          <button style={styles.btn} onClick={handleReload}>
            Reload
          </button>
          <button style={styles.secondaryBtn} onClick={handleOpenExternal}>
            Open in Browser
          </button>
        </div>
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      {/* Graphiti MCP Control Bar */}
      <div style={styles.serviceBar}>
        <div style={styles.serviceBarLeft}>
          <span style={graphitiRunning ? styles.statusDotGreen : styles.statusDotRed}>●</span>
          <span style={styles.serviceName}>
            <b>Graphiti MCP</b>
          </span>
          <span style={styles.serviceStatus}>
            {graphitiRunning ? "running" : "stopped"}
          </span>
          {graphitiMessage && (
            <span style={styles.serviceMessage}>{graphitiMessage}</span>
          )}
        </div>
        <div style={styles.serviceBarRight}>
          <button style={styles.btn} onClick={handleGraphitiStart} disabled={graphitiRunning}>
            Start
          </button>
          <button style={styles.secondaryBtn} onClick={handleGraphitiStop} disabled={!graphitiRunning}>
            Stop
          </button>
          <button style={styles.secondaryBtn} onClick={handleGraphitiOpenUI}>
            Open UI
          </button>
        </div>
      </div>

      <div style={styles.webviewWrap}>
        <webview
          ref={webviewRef}
          src="https://localhost:9443"
          style={styles.webview}
          allowpopups="true"
        />
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
    height: "calc(100vh - 160px)",
    minHeight: "400px",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
    flexWrap: "wrap",
    gap: "12px",
    flexShrink: 0,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  panelTitle: {
    margin: 0,
    fontSize: "18px",
  },
  loadingText: {
    fontSize: "12px",
    color: "#888",
  },
  headerActions: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  btn: {
    padding: "8px 16px",
    background: "#4a9eff",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "13px",
  },
  secondaryBtn: {
    padding: "8px 14px",
    background: "#333",
    border: "1px solid #4a4a4a",
    borderRadius: "4px",
    color: "#eee",
    cursor: "pointer",
    fontSize: "12px",
  },
  errorBanner: {
    padding: "10px 12px",
    background: "#331111",
    border: "1px solid #663333",
    borderRadius: "4px",
    color: "#ff4a4a",
    fontSize: "13px",
    marginBottom: "16px",
    flexShrink: 0,
  },
  serviceBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 14px",
    background: "#252525",
    border: "1px solid #3d3d3d",
    borderRadius: "6px",
    marginBottom: "12px",
    flexShrink: 0,
    flexWrap: "wrap",
    gap: "10px",
  },
  serviceBarLeft: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  serviceBarRight: {
    display: "flex",
    gap: "8px",
  },
  statusDotGreen: {
    color: "#44ff44",
    fontSize: "16px",
  },
  statusDotRed: {
    color: "#ff4444",
    fontSize: "16px",
  },
  serviceName: {
    fontSize: "14px",
    color: "#fff",
  },
  serviceStatus: {
    fontSize: "12px",
    color: "#888",
  },
  serviceMessage: {
    fontSize: "11px",
    color: "#aaa",
    fontStyle: "italic",
  },
  webviewWrap: {
    flex: 1,
    borderRadius: "6px",
    overflow: "hidden",
    border: "1px solid #3d3d3d",
    minHeight: 0,
  },
  webview: {
    width: "100%",
    height: "100%",
    border: "none",
    display: "inline-flex",
  },
};
