"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CategoryId } from "./types";
import {
  LANG_STORAGE_KEY,
  detectBrowserLang,
  resolveEffectiveLang,
  type Lang,
} from "./lang-detect";

export { detectBrowserLang, type Lang };

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  catLabel: (cid: CategoryId) => string;
  catTabLabel: (cid: CategoryId) => string;
  tx: (zh: string, en: string) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

export const CATEGORY_I18N: Record<
  CategoryId,
  { zh: string; zhTab: string; en: string; enTab: string; descEn: string }
> = {
  repo: {
    zh: "仓库研发",
    zhTab: "仓库研发",
    en: "Repo Eng",
    enTab: "Repo Eng",
    descEn: "Multi-file repository bug localization, real GitHub issue resolution, and end-to-end patch merging.",
  },
  architecture: {
    zh: "架构与构建",
    zhTab: "架构与构建",
    en: "Architecture",
    enTab: "Architecture",
    descEn: "Cross-module codebase QnA, safe refactoring, unit test authoring, legacy migration, and from-scratch rebuilds.",
  },
  systems: {
    zh: "运维构建",
    zhTab: "运维与 SRE",
    en: "Systems & SRE",
    enTab: "Systems & SRE",
    descEn: "Containerized CLI troubleshooting, legacy build toolchains, OpenTelemetry observability, and MCP orchestration.",
  },
  sql: {
    zh: "数据库 SQL",
    zhTab: "数据库 SQL",
    en: "Database SQL",
    enTab: "Database SQL",
    descEn: "Enterprise wide-schema Text-to-SQL, query optimization, EXPLAIN analysis, and SQL dialect migration.",
  },
  performance: {
    zh: "性能与算法",
    zhTab: "性能与算法",
    en: "Perf & Algo",
    enTab: "Perf & Algo",
    descEn: "Production runtime performance optimization, IOI-grade algorithmic design, and structured tool calling.",
  },
  security: {
    zh: "后端安全",
    zhTab: "后端安全",
    en: "Security",
    enTab: "Security",
    descEn: "Vulnerability discovery, CVE PoC reproduction & patching, unguided CTF challenges, and exploit analysis.",
  },
};

export const BENCHMARK_DESC_EN: Record<string, string> = {
  swe_rebench: "Continuously scraped decontaminated GitHub issue resolution benchmark.",
  frontierswe: "Hard real-world software engineering and low-level systems tasks.",
  frontiercode: "Engineering code quality benchmark aligned with repository maintainer merge bars.",
  bughunt: "Blind bug-fixing across two production TypeScript repositories with 105 hidden bugs.",
  deepswe: "Long-horizon multi-step software engineering and agent harness bug repair.",
  cursorbench: "IDE repository editing, debugging, and multi-file modification tasks.",
  vals_swebench: "Vals AI independent sandbox & cost-tracked SWE-bench re-evaluation.",
  vals_code_migration: "Legacy repository upgrades and cross-version engineering migrations.",
  vals_programbench: "Rebuilding complete software systems from scratch without reference source.",
  scale_swe_atlas_refactoring: "Large-scale cross-file codebase refactoring avoiding architectural regressions.",
  scale_swe_atlas_testwriting: "Edge-case unit test authoring and verification for production repositories.",
  scale_swe_atlas_qna: "Multi-hop codebase architecture tracing and cross-module comprehension QnA.",
  swe_bench_pro: "Long-horizon, multilingual, decontaminated enterprise software repair suite.",
  swe_bench_multilingual: "Multilingual repository issue fixing across non-Python codebases.",
  nl2repo: "Generating complete working repositories directly from natural language specs.",
  multi_swe_bench: "Multilingual repository bug fixing across 8 backend programming languages.",
  aider_polyglot: "Six-language terminal code editing benchmark (pass@2).",
  terminal_bench_41: "Complex Linux shell debugging, DevOps automation, and sandbox recovery.",
  vals_terminal_bench: "Vals AI independent terminal engineering runs under Terminus 2.",
  mirrorcode: "Recreating complete CLI and system tools without source access to pass E2E suites.",
  otelbench: "OpenTelemetry distributed tracing instrumentation across 11 microservice languages.",
  compilebench: "Resolving legacy toolchains, broken dependencies, and cross-compilation builds.",
  mcpatlas: "Complex MCP protocol tool orchestration across multi-service workflows.",
  livesqlbench: "600 contamination-resistant enterprise SQL and business-logic drift tasks.",
  scale_sql_understanding: "SQL execution accuracy and deep EXPLAIN query plan comprehension.",
  scale_sql_optimization: "Slow query rewriting, logical equivalence, and SQL runtime optimization.",
  scale_sql_dialect: "Large query translation and multi-engine SQL dialect migration.",
  spider2_snow: "Enterprise Snowflake Text-to-SQL workflows over 1,000+ column schemas.",
  spider2_lite: "Complex enterprise BigQuery / Snowflake / SQLite analytical query suite.",
  spider2_dbt: "Real-world DuckDB + DBT data engineering modeling tasks.",
  gso: "Real open-source software profiling and performance optimization (OPT@1).",
  vals_ioi: "International Olympiad in Informatics algorithmic & complexity optimization.",
  algotune: "Core numerical and algorithmic kernel runtime speedup optimization.",
  aa_engineering: "Artificial Analysis composite software engineering benchmark index.",
  bfcl_v4: "Berkeley Function Calling & backend JSON schema structured tool invocation.",
  vals_cyber: "Vals AI independent cybersecurity defense and vulnerability analysis suite.",
  cybergym: "Real software CVE PoC reproduction and automated patch verification.",
  cybench: "Unguided CTF and backend service penetration security challenges.",
  exploitbench: "Automated vulnerability analysis and exploit capability evaluation.",
  aa_cyber: "Artificial Analysis cybersecurity capability index.",
};

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("zh");

  useEffect(() => {
    const syncInitialOrBrowserLang = () => {
      let saved: string | null = null;
      try {
        saved = window.localStorage.getItem(LANG_STORAGE_KEY);
      } catch {
        // Ignore storage access errors
      }
      setLangState(
        resolveEffectiveLang(saved, [
          ...(Array.isArray(navigator.languages) ? navigator.languages : []),
          navigator.language,
        ])
      );
    };

    syncInitialOrBrowserLang();
    window.addEventListener("languagechange", syncInitialOrBrowserLang);
    return () => {
      window.removeEventListener("languagechange", syncInitialOrBrowserLang);
    };
  }, []);

  useEffect(() => {
    const nextHtmlLang = lang === "en" ? "en" : "zh-CN";
    const nextTitle =
      lang === "en"
        ? "BackendIndex · Independent Backend Engineering AI Benchmark Index"
        : "BackendIndex · 后端代码能力独立综合指数";

    const syncDocumentMeta = () => {
      if (document.documentElement.lang !== nextHtmlLang) {
        document.documentElement.lang = nextHtmlLang;
      }
      if (document.title !== nextTitle) {
        document.title = nextTitle;
      }
    };

    syncDocumentMeta();

    // Next.js App Router metadata resolution can update <title> shortly after hydration.
    const observer = new MutationObserver(syncDocumentMeta);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // Ignore storage access errors
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === "zh" ? "en" : "zh");
  }, [lang, setLang]);

  const value = useMemo<LangContextValue>(
    () => ({
      lang,
      setLang,
      toggleLang,
      catLabel: (cid) => CATEGORY_I18N[cid]?.[lang] ?? cid,
      catTabLabel: (cid) => (lang === "en" ? CATEGORY_I18N[cid]?.enTab : CATEGORY_I18N[cid]?.zhTab) ?? cid,
      tx: (zh, en) => (lang === "en" ? en : zh),
    }),
    [lang, setLang, toggleLang]
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) {
    return {
      lang: "zh",
      setLang: () => {},
      toggleLang: () => {},
      catLabel: (cid) => CATEGORY_I18N[cid]?.zh ?? cid,
      catTabLabel: (cid) => CATEGORY_I18N[cid]?.zhTab ?? cid,
      tx: (zh) => zh,
    };
  }
  return ctx;
}
