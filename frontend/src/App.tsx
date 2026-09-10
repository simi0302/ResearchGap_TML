import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import ExplorePage from "./pages/ExplorePage";

// WhiteSpacePage/TrendsPage pull in ECharts, the heaviest dependency — code-split
// them so the homepage (which doesn't need charts) loads fast.
const WhiteSpacePage = lazy(() => import("./pages/WhiteSpacePage"));
const TrendsPage = lazy(() => import("./pages/TrendsPage"));
const ChatPage = lazy(() => import("./pages/ChatPage"));

// minHeight keeps the page roughly the same height while the lazy chunk loads,
// so swapping the fallback for the real page doesn't visibly jump the layout.
function RouteFallback() {
  return (
    <div style={{
      minHeight: "calc(100vh - 220px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#94a3b8", fontSize: 14,
    }}>
      載入中…
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ExplorePage />} />
          <Route
            path="white-space"
            element={<Suspense fallback={<RouteFallback />}><WhiteSpacePage /></Suspense>}
          />
          <Route
            path="trends"
            element={<Suspense fallback={<RouteFallback />}><TrendsPage /></Suspense>}
          />
          <Route
            path="chat"
            element={<Suspense fallback={<RouteFallback />}><ChatPage /></Suspense>}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
