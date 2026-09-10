import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import SiteNav from "./SiteNav";

// InnoServe 資服競賽規定不得出現學校名稱／logo／指導教授姓名，但中大校務治理競賽那邊要求要露名。
// 同一份程式碼靠這個環境變數切換，部署 InnoServe 用的版本時設 VITE_SHOW_SCHOOL_BRANDING=false。
const SHOW_SCHOOL_BRANDING = import.meta.env.VITE_SHOW_SCHOOL_BRANDING !== "false";

export default function Layout() {
  const { pathname } = useLocation();
  const isHome = pathname === "/";

  return (
    <div className="layout-root">
      <div className="layout-ambient" aria-hidden>
        <div className="layout-ambient__blob layout-ambient__blob--a" />
        <div className="layout-ambient__blob layout-ambient__blob--b" />
        <div className="layout-ambient__blob layout-ambient__blob--c" />
      </div>

      <div className="layout-body">
        {!isHome && (
          <nav className="nav-glass">
            <SiteNav variant="solid" />
          </nav>
        )}

        <main className={isHome ? "main-content-area main-content-area--flush-top" : "main-content-area"}>
          <div key={pathname} className="route-outlet">
            <Outlet />
          </div>
        </main>

        <footer className="site-footer">
          <div className="site-footer__inner">
            {SHOW_SCHOOL_BRANDING ? (
              <>
                <span>國立中央大學 2026 AI 校務治理實務競賽・主題：智慧研發支持</span>
                <span className="site-footer__dot" aria-hidden>·</span>
                <span>本平台限中央大學教職員生使用</span>
              </>
            ) : (
              <span>ResearchGap 專利文獻白地分析平台</span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
