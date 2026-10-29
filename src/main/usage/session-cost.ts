/**
 * Per-session cost computation from Claude Code session JSONL `usage` blocks.
 *
 * Each assistant message in a session.jsonl includes a `usage` block:
 *   {
 *     input_tokens, output_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens,
 *     cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens },
 *   }
 *
 * Prices below are Anthropic API list prices (USD per 1M tokens) — no batch
 * discount, no Bedrock/Vertex pass-through. Update when Anthropic publishes
 * new tiers. Source: https://platform.claude.com/docs/en/about-claude/pricing.md
 */

export interface ModelPricing {
  /** Standard input tokens (no cache) — $/M */
  input: number;
  /** Output tokens — $/M */
  output: number;
  /** Cache write — 5 minute TTL — $/M (1.25x input) */
  cacheWrite5m: number;
  /** Cache write — 1 hour TTL — $/M (2x input) */
  cacheWrite1h: number;
  /** Cache read — $/M (0.1x input regardless of TTL) */
  cacheRead: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Claude 5 family (Fable / Mythos)
  'claude-fable-5': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },

  // Opus 4.5 – 4.8 — current generation
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  // Opus 4 (legacy — 3x more expensive than 4.6/4.7)
  'claude-opus-4': { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },

  // Sonnet 4.x / 5
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },

  // Haiku 4.5
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
};

const DEFAULT_PRICING = PRICING['claude-sonnet-4-6'];

/** Look up pricing for a model id, with prefix and family fallbacks. */
export function getModelPricing(model?: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  // Exact match
  if (PRICING[model]) return PRICING[model];
  // Prefix match (longest first) — handles dated suffixes like
  // `claude-haiku-4-5-20251001`.
  const keys = Object.keys(PRICING).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (model.startsWith(k)) return PRICING[k];
  }
  // Family fallback
  if (model.includes('fable') || model.includes('mythos')) return PRICING['claude-fable-5'];
  if (/opus-4(?:-[5678])\b/.test(model)) return PRICING['claude-opus-4-6'];
  if (model.includes('opus')) return PRICING['claude-opus-4'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5'];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  return DEFAULT_PRICING;
}

/** Strip a trailing date suffix so `claude-haiku-4-5-20251001` and
 *  `claude-haiku-4-5` aggregate into the same bucket. */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

/** "claude-opus-4-8" → "Opus 4.8", "claude-fable-5" → "Fable 5".
 *  Unrecognized ids are returned as-is. */
export function modelDisplayLabel(model: string): string {
  const m = normalizeModelId(model);
  const match = m.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (!match) return m;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return match[3] ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
}

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Compute USD cost for a single usage block. */
export function computeCost(usage: RawUsage, model?: string | null): number {
  const p = getModelPricing(model);

  const input = (usage.input_tokens || 0) * p.input;
  const output = (usage.output_tokens || 0) * p.output;
  const cacheRead = (usage.cache_read_input_tokens || 0) * p.cacheRead;

  // Prefer the cache_creation breakdown when present so we charge 5m vs 1h
  // correctly. Fall back to the flat cache_creation_input_tokens at 5m rate
  // for older session formats.
  let cacheWrite = 0;
  if (usage.cache_creation) {
    cacheWrite += (usage.cache_creation.ephemeral_5m_input_tokens || 0) * p.cacheWrite5m;
    cacheWrite += (usage.cache_creation.ephemeral_1h_input_tokens || 0) * p.cacheWrite1h;
  } else {
    cacheWrite += (usage.cache_creation_input_tokens || 0) * p.cacheWrite5m;
  }

  return (input + output + cacheRead + cacheWrite) / 1_000_000;
}
