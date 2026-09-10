import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ResearchGap crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 16,
          padding: 32, textAlign: "center", fontFamily: "'Inter', sans-serif",
        }}>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1e293b", margin: 0 }}>
            頁面發生非預期的錯誤
          </h1>
          <p style={{ color: "#64748b", fontSize: 14, maxWidth: 420, margin: 0 }}>
            請重新整理頁面再試一次；若持續發生，麻煩截圖並回報給開發團隊。
          </p>
          <button
            onClick={() => window.location.assign("/")}
            style={{
              marginTop: 8, padding: "10px 24px", borderRadius: 10, border: "none",
              background: "var(--grad1, #ea580c)", color: "#fff", fontWeight: 600,
              fontSize: 14, cursor: "pointer",
            }}
          >
            回首頁
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
