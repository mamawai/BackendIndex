"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useLang } from "@/lib/i18n";

export type NavTab = "leaderboard" | "compare" | "pareto" | "methodology";

interface HeaderProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  generatedAt: string;
  isDark: boolean;
  onToggleTheme: () => void;
}

const REPO_URL = "https://github.com/mamawai/BackendIndex";

const NAV_ITEMS: { id: NavTab; zh: string; en: string }[] = [
  { id: "leaderboard", zh: "排行榜", en: "Leaderboard" },
  { id: "compare", zh: "模型对比", en: "Compare" },
  { id: "pareto", zh: "Pareto 性价比", en: "Pareto Frontier" },
  { id: "methodology", zh: "方法论与权重", en: "Methodology" },
];

export function Header({
  activeTab,
  onTabChange,
  generatedAt,
  isDark,
  onToggleTheme,
}: HeaderProps) {
  const { lang, toggleLang, tx } = useLang();
  const [scrolled, setScrolled] = useState(false);
  const dateLabel = generatedAt ? generatedAt.slice(0, 10) : "2026-11-22";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-30 bg-[var(--color-background)] transition-colors duration-200 ${
        scrolled ? "border-b border-[var(--color-border)]" : "border-b border-transparent"
      }`}
    >
      <div className="page-shell flex h-15 items-center justify-between gap-6">
        <button
          type="button"
          onClick={() => onTabChange("leaderboard")}
          className="flex shrink-0 items-baseline gap-1.5 text-left transition-opacity hover:opacity-80 active:scale-[0.98]"
        >
          <span className="text-[16px] font-semibold tracking-[-0.025em] text-[var(--color-foreground)]">
            Backend<span className="text-[var(--color-primary)]">.</span>Index
          </span>
          <span className="hidden text-xs text-[var(--color-muted-foreground)] md:inline">
            {tx("后端代码能力独立指数", "Backend Code Benchmark Index")}
          </span>
        </button>

        <nav className="wiib-nav overflow-x-auto" aria-label={tx("主导航", "Main Navigation")}>
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-active={active}
                onClick={() => onTabChange(item.id)}
              >
                <span>{lang === "en" ? item.en : item.zh}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2.5">
          <div className="hidden items-center gap-2 rounded-full bg-[var(--color-fill)] px-3 py-1.5 text-xs text-[var(--color-muted-foreground)] md:inline-flex">
            <span className="lamp-dot" aria-hidden="true" />
            <span className="font-mono text-[11px] font-medium text-[var(--color-foreground)]">
              {dateLabel}
            </span>
          </div>

          <button
            type="button"
            onClick={toggleLang}
            aria-label={tx("切换界面语言", "Switch language")}
            title={tx("切换界面语言（默认跟随浏览器语言）", "Switch language (defaults to browser language)")}
            className="btn sm font-mono text-[11.5px]"
          >
            <span className={lang === "zh" ? "text-[var(--color-foreground)] font-semibold" : "text-[var(--color-faint)]"}>
              中
            </span>
            <span className="text-[var(--color-faint)]">/</span>
            <span className={lang === "en" ? "text-[var(--color-foreground)] font-semibold" : "text-[var(--color-faint)]"}>
              EN
            </span>
          </button>

          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={tx("访问 GitHub 仓库", "View source on GitHub")}
            title={tx("在 GitHub 上查看源码 (mamawai/BackendIndex)", "View on GitHub (mamawai/BackendIndex)")}
            className="ib"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={tx("切换浅色/深色主题", "Toggle light/dark theme")}
            className="ib"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}
