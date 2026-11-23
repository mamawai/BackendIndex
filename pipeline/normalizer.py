"""Model entity resolution, effort/harness extraction, and provider inference."""

from __future__ import annotations

import re

# Known organizations ordered safely with word-boundary checks to prevent false substring hits (e.g. "Scaling" -> "ling")
ORG_RULES: list[tuple[tuple[str, ...], str]] = [
    (("claude", "anthropic", "fable", "opus", "sonnet", "haiku", "mythos"), "Anthropic"),
    (("gpt", "o1", "o3", "o4", "codex", "openai"), "OpenAI"),
    (("gemini", "gemma", "google"), "Google"),
    (("deepseek",), "DeepSeek"),
    (("qwen", "qwq", "alibaba"), "Alibaba"),
    (("glm", "z.ai", "zai", "zhipu"), "Z.ai"),
    (("kimi", "moonshot"), "Moonshot AI"),
    (("grok", "xai", "x-ai"), "xAI"),
    (("llama", "meta", "muse"), "Meta"),
    (("mistral", "codestral", "devstral", "pixtral"), "Mistral AI"),
    (("minimax",), "MiniMax"),
    (("ernie", "baidu"), "Baidu"),
    (("doubao", "seed", "bytedance"), "ByteDance"),
    (("mimo", "xiaomi"), "Xiaomi"),
    (("stepfun",), "StepFun"),
    (("ling", "inclusion", "inclusionai"), "inclusionAI"),
    (("mercury", "inception"), "Inception"),
    (("inkling", "thinking"), "Thinking Machines"),
    (("hy", "hunyuan", "tencent"), "Tencent"),
    (("nova", "amazon"), "Amazon"),
    (("copilot", "phi", "mai", "microsoft"), "Microsoft"),
    (("sakana", "fugu"), "Sakana AI"),
]

# Explicit canonical alias overrides (normalized slug -> (canonical_id, display_name, org))
EXPLICIT_ALIASES: dict[str, tuple[str, str, str]] = {
    "fable-5-2": ("claude-fable-5-2", "Claude Fable 5.2", "Anthropic"),
    "claude-fable-5-2": ("claude-fable-5-2", "Claude Fable 5.2", "Anthropic"),
    "anthropic-fable-5-2": ("claude-fable-5-2", "Claude Fable 5.2", "Anthropic"),
    "fable-5-1": ("claude-fable-5-1", "Claude Fable 5.1", "Anthropic"),
    "claude-fable-5-1": ("claude-fable-5-1", "Claude Fable 5.1", "Anthropic"),
    "fable-5": ("claude-fable-5", "Claude Fable 5", "Anthropic"),
    "anthropic-fable-5": ("claude-fable-5", "Claude Fable 5", "Anthropic"),
    "claude-fable-5": ("claude-fable-5", "Claude Fable 5", "Anthropic"),
    "opus-5-5": ("claude-opus-5-5", "Claude Opus 5.5", "Anthropic"),
    "claude-opus-5-5": ("claude-opus-5-5", "Claude Opus 5.5", "Anthropic"),
    "anthropic-opus-5-5": ("claude-opus-5-5", "Claude Opus 5.5", "Anthropic"),
    "opus-5": ("claude-opus-5", "Claude Opus 5", "Anthropic"),
    "anthropic-opus-5": ("claude-opus-5", "Claude Opus 5", "Anthropic"),
    "claude-opus-5": ("claude-opus-5", "Claude Opus 5", "Anthropic"),
    "sonnet-5-5": ("claude-sonnet-5-5", "Claude Sonnet 5.5", "Anthropic"),
    "claude-sonnet-5-5": ("claude-sonnet-5-5", "Claude Sonnet 5.5", "Anthropic"),
    "sonnet-5": ("claude-sonnet-5", "Claude Sonnet 5", "Anthropic"),
    "anthropic-sonnet-5": ("claude-sonnet-5", "Claude Sonnet 5", "Anthropic"),
    "claude-sonnet-5": ("claude-sonnet-5", "Claude Sonnet 5", "Anthropic"),
    "claude-opus-4-6": ("claude-opus-4-6", "Claude Opus 4.6", "Anthropic"),
    "claude-4-6-opus": ("claude-opus-4-6", "Claude Opus 4.6", "Anthropic"),
    "claude-opus-4-5": ("claude-opus-4-5", "Claude Opus 4.5", "Anthropic"),
    "claude-4-5-opus": ("claude-opus-4-5", "Claude Opus 4.5", "Anthropic"),
    "claude-sonnet-4-6": ("claude-sonnet-4-6", "Claude Sonnet 4.6", "Anthropic"),
    "claude-4-6-sonnet": ("claude-sonnet-4-6", "Claude Sonnet 4.6", "Anthropic"),
    "claude-sonnet-4-5": ("claude-sonnet-4-5", "Claude Sonnet 4.5", "Anthropic"),
    "claude-4-5-sonnet": ("claude-sonnet-4-5", "Claude Sonnet 4.5", "Anthropic"),
    "claude-haiku-4-5": ("claude-haiku-4-5", "Claude Haiku 4.5", "Anthropic"),
    "claude-opus-4-1": ("claude-opus-4-1", "Claude Opus 4.1", "Anthropic"),
    "claude-sonnet-4": ("claude-sonnet-4", "Claude Sonnet 4", "Anthropic"),
    "claude-3-7-sonnet": ("claude-3-7-sonnet", "Claude 3.7 Sonnet", "Anthropic"),
    "claude-sonnet-3-7": ("claude-3-7-sonnet", "Claude 3.7 Sonnet", "Anthropic"),
    "claude-3-5-sonnet": ("claude-3-5-sonnet", "Claude 3.5 Sonnet", "Anthropic"),
    "claude-sonnet-3-5": ("claude-3-5-sonnet", "Claude 3.5 Sonnet", "Anthropic"),
    "claude-3-opus": ("claude-3-opus", "Claude 3 Opus", "Anthropic"),
    "gpt-6-2-astra": ("gpt-6-2-astra", "GPT-6.2 Astra", "OpenAI"),
    "gpt-6-2-astra-pro": ("gpt-6-2-astra-pro", "GPT-6.2 Astra Pro", "OpenAI"),
    "gpt-6-2-sol": ("gpt-6-2-sol", "GPT-6.2 Sol", "OpenAI"),
    "gpt-6-2-sol-pro": ("gpt-6-2-sol-pro", "GPT-6.2 Sol Pro", "OpenAI"),
    "gpt-6-1-sol": ("gpt-6-1-sol", "GPT-6.1 Sol", "OpenAI"),
    "gpt-6-astra": ("gpt-6-astra", "GPT-6 Astra", "OpenAI"),
    "gpt-6-sol": ("gpt-6-sol", "GPT-6 Sol", "OpenAI"),
    "gpt-5-6-sol": ("gpt-5-6-sol", "GPT-5.6 Sol", "OpenAI"),
    "gpt-5-6-terra": ("gpt-5-6-terra", "GPT-5.6 Terra", "OpenAI"),
    "gpt-5-4": ("gpt-5-4", "GPT-5.4", "OpenAI"),
    "gpt-5-3-codex": ("gpt-5-3-codex", "GPT-5.3 Codex", "OpenAI"),
    "gpt-5-2-codex": ("gpt-5-2-codex", "GPT-5.2 Codex", "OpenAI"),
    "gpt-5-2": ("gpt-5-2", "GPT-5.2", "OpenAI"),
    "gpt5-2": ("gpt-5-2", "GPT-5.2", "OpenAI"),
    "gpt-5-mini": ("gpt-5-mini", "GPT-5 Mini", "OpenAI"),
    "gpt5": ("gpt-5", "GPT-5", "OpenAI"),
    "gpt-5-1-codex-max": ("gpt-5-1-codex-max", "GPT-5.1 Codex Max", "OpenAI"),
    "gpt-5-1-codex": ("gpt-5-1-codex", "GPT-5.1 Codex", "OpenAI"),
    "gpt-5-1": ("gpt-5-1", "GPT-5.1", "OpenAI"),
    "gpt-5-codex": ("gpt-5-codex", "GPT-5 Codex", "OpenAI"),
    "gpt-5": ("gpt-5", "GPT-5", "OpenAI"),
    "o1-preview": ("o1-preview", "o1-preview", "OpenAI"),
    "o1-mini": ("o1-mini", "o1-mini", "OpenAI"),
    "o1": ("o1", "o1", "OpenAI"),
    "o3-mini": ("o3-mini", "o3-mini", "OpenAI"),
    "o3": ("o3", "o3", "OpenAI"),
    "o4-mini": ("o4-mini", "o4-mini", "OpenAI"),
    "claude-mythos-preview": ("claude-mythos-preview", "Claude Mythos Preview", "Anthropic"),
    "muse-spark": ("muse-spark", "Muse Spark", "Meta"),
    "muse-spark-1-1": ("muse-spark-1-1", "Muse Spark 1.1", "Meta"),
    "gemini-4-neon": ("gemini-4-neon", "Gemini 4 Neon", "Google"),
    "gemini-4-carbon": ("gemini-4-carbon", "Gemini 4 Carbon", "Google"),
    "gemini-4-hydrogen": ("gemini-4-hydrogen", "Gemini 4 Hydrogen", "Google"),
    "gemini-4-argon": ("gemini-4-argon", "Gemini 4 Argon", "Google"),
    "gemini-3-5-flash": ("gemini-3-5-flash", "Gemini 3.5 Flash", "Google"),
    "gemini-3-1-pro": ("gemini-3-1-pro", "Gemini 3.1 Pro", "Google"),
    "gemini-3-1-pro-preview": ("gemini-3-1-pro", "Gemini 3.1 Pro", "Google"),
    "gemini-3-pro": ("gemini-3-pro", "Gemini 3 Pro", "Google"),
    "gemini-3-pro-preview": ("gemini-3-pro", "Gemini 3 Pro", "Google"),
    "gemini-3-flash": ("gemini-3-flash", "Gemini 3 Flash", "Google"),
    "gemini-3-flash-preview": ("gemini-3-flash", "Gemini 3 Flash", "Google"),
    "grok-grok-4-5": ("grok-4-5", "Grok 4.5", "xAI"),
    "grok-4-5": ("grok-4-5", "Grok 4.5", "xAI"),
    "grok-4-6": ("grok-4-6", "Grok 4.6", "xAI"),
    "grok-4-1-fast": ("grok-4-1-fast", "Grok 4.1 Fast", "xAI"),
    "grok-4-1-fast-reasoning": ("grok-4-1-fast-reasoning", "Grok 4.1 Fast Reasoning", "xAI"),
    "grok-4-fast-reasoning": ("grok-4-fast-reasoning", "Grok 4 Fast Reasoning", "xAI"),
    "grok-4": ("grok-4", "Grok 4", "xAI"),
    "deepseek-v4-pro": ("deepseek-v4-pro", "DeepSeek V4 Pro", "DeepSeek"),
    "deepseek-v4-1-flash": ("deepseek-v4-1-flash", "DeepSeek V4.1 Flash", "DeepSeek"),
    "deepseek-v3-2": ("deepseek-v3-2", "DeepSeek V3.2", "DeepSeek"),
    "glm-5-3": ("glm-5-3", "GLM-5.3", "Z.ai"),
    "glm-5-2": ("glm-5-2", "GLM-5.2", "Z.ai"),
    "glm-5": ("glm-5", "GLM-5", "Z.ai"),
    "glm-4-7": ("glm-4-7", "GLM-4.7", "Z.ai"),
    "kimi-k3-1-pro": ("kimi-k3-1-pro", "Kimi K3.1 Pro", "Moonshot AI"),
    "kimi-k3-pro": ("kimi-k3-pro", "Kimi K3 Pro", "Moonshot AI"),
    "kimi-k2-thinking": ("kimi-k2-thinking", "Kimi K2 Thinking", "Moonshot AI"),
    "minimax-m2-7": ("minimax-m2-7", "MiniMax M2.7", "MiniMax"),
    "minimax-m2-5": ("minimax-m2-5", "MiniMax M2.5", "MiniMax"),
    "qwen3-8-27b": ("qwen3-8-27b", "Qwen3.8 27B", "Alibaba"),
    "qwen-3-8-27b": ("qwen3-8-27b", "Qwen3.8 27B", "Alibaba"),
    "qwen3-8-max": ("qwen-3-8-max", "Qwen 3.8 Max", "Alibaba"),
    "qwen-3-8-max": ("qwen-3-8-max", "Qwen 3.8 Max", "Alibaba"),
    "qwen3-8-max-0902": ("qwen-3-8-max", "Qwen 3.8 Max", "Alibaba"),
    "qwen3-7-max": ("qwen3-7-max", "Qwen3.7 Max", "Alibaba"),
    "qwen-3-7-max": ("qwen3-7-max", "Qwen3.7 Max", "Alibaba"),
    "qwen3-7-plus": ("qwen3-7-plus", "Qwen3.7 Plus", "Alibaba"),
    "qwen-3-7-plus": ("qwen3-7-plus", "Qwen3.7 Plus", "Alibaba"),
    "qwen3-6-plus": ("qwen3-6-plus", "Qwen3.6 Plus", "Alibaba"),
    "qwen-3-6-plus": ("qwen3-6-plus", "Qwen3.6 Plus", "Alibaba"),
    "qwen3-8-omni-flash": ("qwen3-8-omni-flash", "Qwen3.8 Omni Flash", "Alibaba"),
    "qwen4-max": ("qwen4-max", "Qwen4 Max", "Alibaba"),
    "deepseek-v4-flash-0731": ("deepseek-v4-flash", "DeepSeek V4 Flash", "DeepSeek"),
    "deepseek-v4-flash-0423": ("deepseek-v4-flash", "DeepSeek V4 Flash", "DeepSeek"),
    "claude-haiku-5-5": ("claude-haiku-5-5", "Claude Haiku 5.5", "Anthropic"),
    "haiku-5-5": ("claude-haiku-5-5", "Claude Haiku 5.5", "Anthropic"),
    "kimi-k2-6": ("kimi-k2-6", "Kimi K2.6", "Moonshot AI"),
    "kimi-2-5": ("kimi-k2-5", "Kimi K2.5", "Moonshot AI"),
    "kimi-k2-5": ("kimi-k2-5", "Kimi K2.5", "Moonshot AI"),
    "grok4-7": ("grok-4-7", "Grok 4.7", "xAI"),
    "grok-4-7": ("grok-4-7", "Grok 4.7", "xAI"),
    "minimax-m3": ("minimax-m3", "MiniMax M3", "MiniMax"),
    "qwen3-6-max": ("qwen3-6-max", "Qwen3.6 Max", "Alibaba"),
    "qwen3-6-max-preview": ("qwen-3-6-max-preview", "Qwen 3.6 Max (Preview)", "Alibaba"),
    "qwen3-6-35b-a3b": ("qwen-3-6-35b-a3b", "Qwen 3.6 35B-A3B", "Alibaba"),
    "qwen3-5-397b-a17b": ("qwen3-5-397b", "Qwen3.5 397B", "Alibaba"),
    "mistral-large-4-0": ("mistral-large-4", "Mistral Large 4", "Mistral AI"),
    "hy4-preview": ("hy4-preview", "Hy4 preview", "Tencent"),
    "muse-wonder": ("muse-wonder-1-0", "Muse Wonder 1.0", "Meta"),
    "muse-wonder-1-0": ("muse-wonder-1-0", "Muse Wonder 1.0", "Meta"),
    "glm-5-1": ("glm-5-1", "GLM-5.1", "Z.ai"),
    "mimo-v2-6-pro": ("mimo-v2-6-pro", "MiMo-V2.6-Pro", "Xiaomi"),
    "mimo-v2-6-flash": ("mimo-v2-6-flash", "MiMo-V2.6-Flash", "Xiaomi"),
}

EFFORT_PATTERN = re.compile(
    r"(?:\s*\(\s*(xhigh|high|medium|low|max|minimal|none|pro|promax|thinking|reasoning|ultra|unknown)\s*\)"
    r"|\s*\[\s*(xhigh|high|medium|low|max|minimal|none|thinking|reasoning|ultra)\s*\]"
    r"|_(xhigh|high|medium|low|max|minimal|none|promax|ultra|unknown)"
    r"|-(xhigh|high|medium|low|max)(?=$|-)"
    r"|\s*-\s*thinking(?:-\d+k)?)$",
    re.IGNORECASE,
)

# Separate precision suffixes from reasoning effort so quantization checkpoints fold cleanly without overwriting effort
QUANT_PATTERN = re.compile(
    r"(?:\s*\(\s*(?:fp8|nvfp4|fp4|bf16|fp16|int8|int4)\s*\)"
    r"|\s*\[\s*(?:fp8|nvfp4|fp4|bf16|fp16)\s*\]"
    r"|[-\s]+(?:fp8|nvfp4|fp4|bf16|fp16|int8|int4))$",
    re.IGNORECASE,
)

AGENT_PRODUCT_MARKERS = (
    "claude code agent",
    "codex agent",
    "cursor agent",
    "junie",
    "copilot fusion",
    "genloop",
    "signalpilot",
    "databao",
    "decisionx",
    "native mini",
    "sqlflash",
    "sqlshift",
    "interfaze",
    "tcdataagent",
    "judge",
)


def infer_organization(name: str, fallback: str | None = None) -> str:
    """Infer model creator organization from name or fallback without substring collisions."""
    if fallback and fallback.strip() and fallback.strip().lower() not in ("unknown", "other"):
        fb = fallback.strip()
        if "Google" in fb:
            return "Google"
        if "Moonshot" in fb or fb.lower() == "kimi":
            return "Moonshot AI"
        if fb.lower() == "qwen":
            return "Alibaba"
        if "Zhipu" in fb or fb == "Z.ai":
            return "Z.ai"
        if "SpaceXSI" in fb or fb.lower() == "xai":
            return "xAI"
        if fb.lower().startswith("meta"):
            return "Meta"
        return fb
    low = name.lower()
    for keys, org in ORG_RULES:
        for k in keys:
            if re.search(rf"(?<![a-z0-9]){re.escape(k)}(?=$|[^a-z])", low):
                return org
    return "Other"


def slugify(text: str) -> str:
    """Normalize text to a lowercase hyphenated slug."""
    s = text.lower().strip()
    s = s.replace(".", "-")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


class ModelNormalizer:
    """Maps disparate benchmark model strings into canonical model IDs."""

    def __init__(self) -> None:
        self.epoch_version_to_group: dict[str, tuple[str, str]] = {}
        self.known_aliases: dict[str, tuple[str, str, str]] = dict(EXPLICIT_ALIASES)

    def register_epoch_metadata(self, rows: list[dict[str, str]]) -> None:
        """Register Epoch model_metadata.csv mappings for exact resolution."""
        for r in rows:
            ver = (r.get("model_version") or "").strip().lower()
            grp = (r.get("model_group") or "").strip()
            org = infer_organization(grp, r.get("organization"))
            if ver and grp:
                self.epoch_version_to_group[ver] = (grp, org)
                slug = slugify(grp)
                if slug not in self.known_aliases:
                    self.known_aliases[slug] = (slug, grp, org)

    def register_openrouter_models(self, models: list[dict]) -> None:
        """Register OpenRouter model names & slugs to enrich alias lookup."""
        for m in models:
            mid = m.get("id", "")
            if ":batch" in mid or ":free" in mid or ":extended" in mid or ":thinking" in mid:
                continue
            raw_name = m.get("name", "")
            if ":" in raw_name:
                org_part, model_part = [p.strip() for p in raw_name.split(":", 1)]
            else:
                org_part, model_part = "", raw_name.strip()
            org = infer_organization(model_part, org_part)
            slug = slugify(model_part)
            if slug and slug not in self.known_aliases:
                self.known_aliases[slug] = (slug, model_part, org)
            id_tail = slugify(mid.split("/")[-1])
            if id_tail and id_tail not in self.known_aliases:
                canon_id, disp, o = self.known_aliases[slug]
                self.known_aliases[id_tail] = (canon_id, disp, o)

    def normalize(
        self,
        raw_name: str,
        org_hint: str | None = None,
        harness_hint: str | None = None,
    ) -> tuple[str, str, str, str | None, str | None, bool]:
        """Return (canonical_id, display_name, org, effort, harness, is_agent_product)."""
        text = re.sub(r"\s+", " ", raw_name).strip()
        low = text.lower()

        if low in self.epoch_version_to_group:
            grp, org = self.epoch_version_to_group[low]
            eff_m = EFFORT_PATTERN.search(text)
            effort = next((g for g in eff_m.groups() if g), None) if eff_m else None
            slug = slugify(grp)
            cid, disp, canonical_org = self.known_aliases.get(slug, (slug, grp, org))
            return cid, disp, canonical_org, effort, harness_hint, False

        is_agent_product = any(marker in low for marker in AGENT_PRODUCT_MARKERS)

        # Strip ONLY valid HuggingFace/OpenRouter namespace prefixes (never dates like '(11/25)')
        cleaned = re.sub(r"^openrouter/[a-z0-9_.-]+/", "", text, flags=re.I)
        ns_m = re.match(r"^[a-z][a-z0-9_.-]{1,30}/(.+)$", cleaned, flags=re.I)
        if ns_m and not cleaned.startswith("http"):
            cleaned = ns_m.group(1)
        cleaned = re.sub(r"\s+Model$", "", cleaned).strip()

        # Handle "Agent + BaseModel" patterns (multi-LLM combinations like "X + Opus 4.5 Judge" are agent systems)
        harness = harness_hint
        if " + " in cleaned:
            parts = [p.strip() for p in cleaned.split(" + ")]
            if len(parts) > 2 or "judge" in cleaned.lower():
                is_agent_product = True
            else:
                left, right = parts
                l_org = infer_organization(left)
                r_org = infer_organization(right)
                if l_org != "Other" and r_org != "Other":
                    is_agent_product = True
                elif r_org != "Other":
                    harness = harness or left
                    cleaned = right
                    is_agent_product = False
                elif l_org != "Other":
                    harness = harness or right
                    cleaned = left
                    is_agent_product = False

        # Handle wrapper patterns like "AntQL 1.1 (Claude Opus 5.5)", "Claude Opus 4.6 (OpenHands CLI)", "OpenCode-Grok4.7"
        if cleaned.lower().startswith("opencode-"):
            harness = harness or "OpenCode"
            cleaned = cleaned[len("opencode-"):].strip()
        paren_m = re.match(r"^(.+?)\s*\(([^()]+)\)\s*$", cleaned)
        if paren_m:
            outer, inner = paren_m.group(1).strip(), paren_m.group(2).strip()
            inner_clean = EFFORT_PATTERN.sub("", inner).strip().rstrip(",").strip()
            if any(h in inner.lower() for h in ("cli", "code", "agent", "aider", "harbor", "openhands")):
                harness = harness or inner
                cleaned = outer
                is_agent_product = False
            elif infer_organization(inner_clean) != "Other" and infer_organization(outer) == "Other":
                harness = harness or outer
                cleaned = inner_clean
                is_agent_product = False

        # Peel trailing (MM/YY) benchmark date tags and AA '(..., Default Fallback)' markers cleanly
        cleaned = re.sub(r"\s*\(\d{2}/\d{2}\)\s*$", "", cleaned).strip()
        cleaned = re.sub(r"\(\s*([^()]+?)\s*,\s*Default Fallback\s*\)$", r"(\1)", cleaned, flags=re.I).strip()

        # Strip precision quantization tags (FP8, NVFP4) separately from reasoning effort
        while QUANT_PATTERN.search(cleaned):
            cleaned = QUANT_PATTERN.sub("", cleaned).strip()

        # Strip effort/thinking tags only when pre-stripping string is not itself a canonical model ID
        effort: str | None = None
        while True:
            pre_slug = slugify(re.sub(r"\s+", " ", cleaned).strip())
            if pre_slug in self.known_aliases:
                break
            m = EFFORT_PATTERN.search(cleaned)
            if not m:
                break
            found = next((g for g in m.groups() if g), None)
            if found and found.lower() != "unknown":
                effort = effort or found.lower()
            cleaned = cleaned[: m.start()].strip()

        if slugify(cleaned) not in self.known_aliases:
            cleaned = re.sub(r"\s+\d{4}$", "", cleaned).strip()
            cleaned = re.sub(r"-\d{8}$", "", cleaned).strip()
        if slugify(cleaned) not in self.known_aliases:
            cleaned = re.sub(r"-preview$", "", cleaned, flags=re.I).strip()
        cleaned = re.sub(r"-together$", "", cleaned, flags=re.I).strip()
        cleaned = re.sub(r"\s+", " ", cleaned).strip()

        # Strip duplicated org/wrapper prefixes while keeping canonical brand prefix intact
        cleaned = re.sub(
            r"^(?:CodeArts-|Anthropic\s+|OpenAI\s+|Google\s+|Z\.ai\s+|Grok\s+|DeepSeek\s+|Qwen\s+|Mistral\s+)(?=(?:Claude|Fable|Opus|Sonnet|Haiku|GPT|o1|o3|o4|Gemini|GLM|Grok|DeepSeek|Qwen|Mistral|MiniMax))",
            "",
            cleaned,
            flags=re.I,
        )
        if harness:
            h_map = {
                "claude-code": "Claude Code",
                "codex-cli": "Codex CLI",
                "mini-swe-agent": "Mini-SWE-agent",
                "antigravity-cli": "Antigravity CLI",
            }
            harness = h_map.get(harness.lower().strip(), harness)
        if cleaned.lower().startswith("anthropic ") and not cleaned.lower().startswith("anthropic claude"):
            cleaned = "Claude " + cleaned[len("anthropic "):].strip()

        slug = slugify(cleaned)
        if slug in self.known_aliases:
            cid, disp, org = self.known_aliases[slug]
            return cid, disp, org, effort, harness, is_agent_product

        org = infer_organization(cleaned, org_hint)
        disp = cleaned
        if disp == disp.lower() and "-" in disp:
            disp = " ".join(w.upper() if w in ("gpt", "glm", "swe") else w.capitalize() for w in disp.split("-"))
        return slug, disp, org, effort, harness, is_agent_product
