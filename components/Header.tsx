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
