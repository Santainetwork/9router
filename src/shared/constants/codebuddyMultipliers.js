// CodeBuddy / WorkBuddy credit multipliers (积分倍率).
//
// A multiplier is the credit burn rate per model: the higher it is, the more
// credits a request costs. Source: the WorkBuddy client's published rates and
// the iOA channel overlay (`credits` field in product.ioa.json). Values drift,
// so this is a display-only reference — it never feeds billing or routing.
//
// Keys match the bare model id as CodeBuddy reports it (no `cbai/` prefix).
export const CODEBUDDY_MULTIPLIERS = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash", multiplier: 0.03 },
  { id: "deepseek-v4-flash", label: "DeepSeek-V4-Flash", multiplier: 0.17 },
  { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro", multiplier: 0.51 },
  { id: "minimax-m3", label: "MiniMax-M3", multiplier: 0.25 },
  { id: "kimi-k2.6", label: "Kimi-K2.6", multiplier: 0.52 },
  { id: "kimi-k2.7", label: "Kimi-K2.7-Code", multiplier: 0.57 },
  { id: "kimi-k3", label: "Kimi-K3", multiplier: 1.62 },
  { id: "glm-5v-turbo", label: "GLM-5v-Turbo", multiplier: 0.71 },
  { id: "glm-5.0-turbo", label: "GLM-5.0-Turbo", multiplier: 0.79 },
  { id: "glm-5.1", label: "GLM-5.1", multiplier: 0.79 },
  { id: "glm-5.2", label: "GLM-5.2", multiplier: 0.79 },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", multiplier: 0.79 },
  { id: "glm-5.3", label: "GLM-5.3", multiplier: 0.79 },
  { id: "claude-sonnet-4.6", label: "Claude-Sonnet-4.6", multiplier: 2.0 },
  { id: "claude-opus-4.8", label: "Claude-Opus-4.8", multiplier: 3.33 },
  { id: "claude-opus-5", label: "Claude-Opus-5", multiplier: 3.33 },
  { id: "gpt-5.5", label: "GPT-5.5", multiplier: 3.31 },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", multiplier: 0.14 },
  { id: "gpt-6-astra", label: "GPT-6-Astra", multiplier: 6.67 },
  { id: "hy3-preview", label: "Hy3-Preview", multiplier: 0.0 },
];
