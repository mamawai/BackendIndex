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
    descEn: "Existing codebase comprehension, bug localization, test writing, and multi-file patch delivery.",
  },
  architecture: {
    zh: "架构与演进",
    zhTab: "架构与演进",
    en: "Architecture",
    enTab: "Architecture",
    descEn: "Cross-file refactoring, cross-language system migration, and end-to-end program reconstruction.",
  },
  systems: {
    zh: "运维构建",
    zhTab: "运维与 SRE",
    en: "Systems & SRE",
    enTab: "Systems & SRE",
    descEn: "Containerized CLI debugging, legacy build toolchains, OpenTelemetry observability, and tool protocols.",
  },
  sql: {
    zh: "数据库 SQL",
    zhTab: "数据库 SQL",
    en: "Database SQL",
    enTab: "Database SQL",
    descEn: "Enterprise wide-schema Text-to-SQL, SQL optimization ability scoring, EXPLAIN, and dialect migration.",
  },
  performance: {
    zh: "性能与算法",
    zhTab: "性能与算法",
    en: "Perf & Algo",
    enTab: "Perf & Algo",
    descEn: "Production runtime performance optimization (GSO / AlgoTune speedup ref) and IOI-grade algorithms.",
  },
  security: {
    zh: "后端安全",
    zhTab: "后端安全",
    en: "Security",
    enTab: "Security",
    descEn: "CVE PoC vulnerability reproduction & patching, unguided CTF challenges, and exploit analysis.",
  },
};

export const BENCHMARK_DESC_EN: Record<string, string> = {
  swe_rebench: "Rolling decontaminated GitHub issue resolution benchmark tracked over periodic windows.",
  frontierswe: "Pure software engineering implementation track (isolated from research & perf sub-scores).",
  frontiercode: "Engineering code quality benchmark aligned with maintainer merge standards (1.1 Main).",
  bughunt: "Blind bug-fixing across two production TypeScript repos (105 planted bugs, superseded runs excluded).",
  deepswe: "Long-horizon multi-file constrained software engineering repair and feature delivery.",
  cursorbench: "Real IDE multi-file editing and debugging suite (4.0 archive).",
  vals_swebench: "Vals AI independent sandbox & cost-tracked SWE-bench Verified re-evaluation.",
  vals_code_migration: "Cross-language system and CLI engineering migration benchmark (e.g. COBOL to Java).",
  vals_programbench: "Behavioral rebuild of complete CLI/system tools from specifications without reference code.",
  scale_swe_atlas_refactoring: "Large-scale cross-file refactoring checking structural integrity and behavior.",
  scale_swe_atlas_testwriting: "Authoring edge-case repository test patches and mutation/regression verification.",
  scale_swe_atlas_qna: "Repository comprehension via execution tracing and multi-hop codebase QnA.",
  swe_bench_pro: "Long-horizon, multilingual enterprise repository repair suite.",
  swe_bench_multilingual: "Multilingual open-source issue resolution across non-Python repositories.",
  nl2repo: "Generating installable Python repositories from natural language specs and empty workspaces.",
  multi_swe_bench: "8-language repository bug fixing (aggregated from verified per-language best harnesses).",
  aider_polyglot: "225 Exercism 6-language code editing exercises (auxiliary drill, excluded from core repo status).",
  terminal_bench_41: "Terminal-Bench 4.1 general containerized CLI troubleshooting and DevOps automation.",
  vals_terminal_bench: "Vals AI independent Terminus 2 runs on Terminal-Bench 1.0 (legacy 80-task suite).",
  mirrorcode: "Recreating complete CLI tools end-to-end solely from observable behavior specs.",
  otelbench: "OpenTelemetry distributed tracing instrumentation across 11 microservice languages.",
  compilebench: "Resolving legacy toolchains, broken dependencies, and cross-compilation builds.",
  mcpatlas: "Complex MCP protocol multi-tool workflow orchestration (auxiliary track).",
  livesqlbench: "Base-Full v1: 600 contamination-resistant SQL tasks with external knowledge & verified provenance badges.",
  scale_sql_understanding: "SQL comprehension, execution accuracy, and EXPLAIN query plan analysis.",
  scale_sql_optimization: "Slow query rewriting and logical-equivalence SQL optimization ability score (ability_score).",
  scale_sql_dialect: "Large query translation and cross-engine SQL dialect migration.",
  spider2_snow: "Snowflake enterprise wide-schema SQL (shares 547 tasks with Lite; overlap weight adjusted).",
  spider2_lite: "BigQuery / Snowflake / SQLite complex queries (shares 547 tasks with Snow; overlap weight adjusted).",
  spider2_dbt: "DuckDB + DBT real-world data engineering transformation modeling tasks.",
  gso: "Real open-source software repository performance profiling & optimization (Opt@1).",
  vals_ioi: "IOI competition-grade algorithmic design & complexity solving (auxiliary contest track).",
  algotune: "Core numerical & algorithmic kernel speedup multiplier (raw e.g. 2.05× shown uncalibrated outside IRT).",
  aa_engineering: "Artificial Analysis composite index (includes non-coding domains; external ref outside IRT).",
  bfcl_v4: "Berkeley Function Calling & structured multi-turn tool interaction (auxiliary track).",
  vals_cyber: "Vals CyberBench open-source native vulnerability reproduction and repair.",
  cybergym: "CyberGym Level-1 (trials=1) real CVE PoC reproduction with per-run vendor provenance.",
  cybench: "Unguided CTF penetration solved rate (separating official runs, HAL, and lab model cards).",
  exploitbench: "ExploitBench v0.1 automated staged vulnerability Mean Capability.",
  aa_cyber: "Artificial Analysis cyber composite index (overlaps CyberGym-E2E-AA; external ref outside IRT).",
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
