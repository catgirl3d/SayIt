import { t } from '@/i18n'

export const MAX_HOTWORDS = 1000
export const BUILTIN_SET_WORDS_KEY = 'builtinSetWords'
export const BUILTIN_SET_ACTIVE_KEY = 'builtinSetActive'
export const CUSTOM_THEMES_KEY = 'customHotwordThemes'
export const CUSTOM_THEME_ACTIVE_KEY = 'customThemeActive'
export const LEGACY_MANUAL_WORDS_KEY = 'manualHotwords'

export interface CustomTheme {
  id: string
  name: string
  words: string[]
}

export const BUILTIN_SETS: Record<string, { label: string; description: string; words: string[] }> = {
  ai: {
    get label() { return t('dict.aiSet') },
    get description() { return t('dict.aiSetDesc') },
    words: [
      'ChatGPT', 'GPT', 'OpenAI', 'Claude', 'DeepSeek', 'Gemini',
      'LLM', 'Token', 'Prompt', 'Agent', 'Ollama', 'OpenClaw',
      'ASR', 'Codex', 'Claude Code', 'SayIt', 'Hermes',
      'Vibe Coding', 'Typeless', 'Vibe',
    ],
  },
  // Medium-sized on purpose: built-in sets are composed ahead of custom categories, Gemini and
  // the Qwen audio stream take only the first 100 words, and Deepgram rejects keyterms above
  // 500 tokens in total. Prefer names ASR tends to mangle over plain English words.
  code: {
    get label() { return t('dict.codeSet') },
    get description() { return t('dict.codeSetDesc') },
    words: [
      'Git', 'GitHub', 'GitHub Actions', 'commit', 'rebase', 'cherry-pick',
      'merge conflict', 'pull request', 'worktree', 'squash', 'monorepo', 'changelog',
      'TypeScript', 'JavaScript', 'Python', 'Rust', 'C++', 'C#', 'Node.js', 'WebAssembly',
      'React', 'Next.js', 'Svelte', 'Tailwind', 'Vite', 'Vitest', 'ESLint',
      'npm', 'pnpm', 'Cargo', 'Tauri', 'VS Code', 'Neovim', 'JetBrains', 'PowerShell',
      'Docker', 'Kubernetes', 'kubectl', 'Terraform', 'Nginx', 'Cloudflare', 'Vercel', 'CI/CD',
      'PostgreSQL', 'SQLite', 'Redis', 'MongoDB', 'GraphQL', 'gRPC', 'REST API',
      'WebSocket', 'JSON', 'YAML', 'OAuth', 'JWT', 'localhost',
      'refactor', 'linter', 'regex', 'async', 'middleware', 'endpoint', 'stack trace', 'stderr',
    ],
  },
  // Domain presets below follow the same word and token budgets as `code`; model.test.ts enforces them.
  agents: {
    get label() { return t('dict.agentsSet') },
    get description() { return t('dict.agentsSetDesc') },
    words: [
      'MCP', 'subagent', 'tool call', 'system prompt', 'context window', 'slash command',
      'Windsurf', 'Cline', 'Kilo Code', 'GitHub Copilot', 'Gemini CLI', 'Aider',
      'OpenRouter', 'Groq', 'Grok', 'Hugging Face', 'Llama', 'Qwen', 'Mistral', 'Anthropic',
      'vLLM', 'GGUF', 'LoRA', 'RLHF', 'KV cache', 'fine-tuning', 'RAG', 'LangChain', 'LlamaIndex',
      'Replit', 'Devin', 'Tabnine', 'Sourcegraph', 'MoE',
    ],
  },
  devops: {
    get label() { return t('dict.devopsSet') },
    get description() { return t('dict.devopsSetDesc') },
    words: [
      'AWS', 'Azure', 'GCP', 'S3', 'EC2', 'Lambda', 'Helm', 'Argo CD', 'Ansible', 'Pulumi',
      'Grafana', 'Prometheus', 'Loki', 'OpenTelemetry', 'CloudWatch', 'Datadog', 'Sentry', 'PagerDuty',
      'Kafka', 'RabbitMQ', 'Elasticsearch', 'Istio', 'Traefik', 'Jenkins', 'GitLab', 'Podman',
      'Okta', 'Keycloak', 'systemd', 'SSH', 'DNS', 'TLS', 'CDN', 'load balancer', 'autoscaling',
      'SLA', 'SRE', 'DevOps', 'IaC',
    ],
  },
  data: {
    get label() { return t('dict.dataSet') },
    get description() { return t('dict.dataSetDesc') },
    words: [
      'pandas', 'NumPy', 'PyTorch', 'TensorFlow', 'Jupyter', 'scikit-learn', 'Matplotlib', 'DataFrame',
      'ETL', 'SQL', 'BigQuery', 'Snowflake', 'Databricks', 'Redshift', 'dbt', 'Airflow',
      'Apache Spark', 'Parquet', 'vector database', 'CUDA', 'GPU', 'NVIDIA', 'Pydantic', 'LightGBM',
      'XGBoost', 'MLflow', 'MLOps', 'AutoML', 'BERT', 'CNN', 'LSTM', 'Kaggle',
      'Colab', 'OpenCV', 'Plotly', 'Tableau', 'Power BI', 'Looker', 'Metabase', 'Anaconda',
    ],
  },
  product: {
    get label() { return t('dict.productSet') },
    get description() { return t('dict.productSetDesc') },
    words: [
      'Jira', 'Confluence', 'Notion', 'Trello', 'Asana', 'Miro', 'ClickUp', 'Basecamp', 'Wrike',
      'Airtable', 'Smartsheet', 'Productboard', 'Mixpanel', 'Amplitude', 'Hotjar', 'Pendo',
      'Zendesk', 'Intercom', 'Typeform', 'Gantt', 'Kanban', 'Scrum', 'MVP', 'OKR', 'KPI',
      'PRD', 'NPS', 'DAU', 'MAU', 'POC', 'QA', 'UAT', 'ETA', 'WIP',
    ],
  },
  design: {
    get label() { return t('dict.designSet') },
    get description() { return t('dict.designSetDesc') },
    words: [
      'Figma', 'FigJam', 'Framer', 'Webflow', 'Storybook', 'Zeplin', 'Adobe XD', 'Affinity Designer',
      'Procreate', 'Photoshop', 'Illustrator', 'InDesign', 'Canva', 'Lottie', 'Rive', 'Dribbble',
      'Behance', 'Pantone', 'SVG', 'RGB', 'CSS', 'WCAG', 'UI/UX', 'wireframe', 'mockup',
      'design system', 'viewport', 'breakpoint', 'dark mode', 'Radix UI', 'shadcn/ui', 'Material UI',
    ],
  },
  business: {
    get label() { return t('dict.businessSet') },
    get description() { return t('dict.businessSetDesc') },
    words: [
      'SaaS', 'B2B', 'B2C', 'ARR', 'MRR', 'churn', 'CAC', 'LTV', 'ROI', 'EBITDA', 'P&L',
      'SEO', 'SMM', 'CTR', 'CPC', 'PPC', 'CRO', 'ROAS', 'UTM', 'A/B test', 'ICP', 'MQL', 'CRM',
      'GMV', 'COGS', 'CapEx', 'landing page', 'HubSpot', 'Salesforce', 'Pipedrive', 'Mailchimp',
      'QuickBooks', 'Shopify', 'Zapier', 'Google Ads', 'Google Analytics', 'Meta Ads', 'TikTok', 'LinkedIn',
    ],
  },
  office: {
    get label() { return t('dict.officeSet') },
    get description() { return t('dict.officeSetDesc') },
    words: [
      'Zoom', 'Google Meet', 'Microsoft Teams', 'Slack', 'Webex', 'Telegram', 'WhatsApp', 'Viber',
      'Gmail', 'Google Docs', 'Google Sheets', 'Google Slides', 'Google Forms', 'Google Drive',
      'Google Calendar', 'Google Workspace', 'PowerPoint', 'OneDrive', 'OneNote', 'SharePoint',
      'Dropbox', 'Loom', 'Calendly', 'Zoho', 'Lucidchart', 'Mentimeter', 'Kahoot', 'Grammarly',
      'DocuSign', 'Evernote', 'Otter.ai',
    ],
  },
  creative: {
    get label() { return t('dict.creativeSet') },
    get description() { return t('dict.creativeSetDesc') },
    words: [
      'OBS', 'Streamlabs', 'StreamElements', 'Restream', 'Elgato', 'Twitch', 'YouTube', 'Discord',
      'VTuber', 'Unity', 'Unreal Engine', 'Godot', 'Blender', 'DaVinci Resolve', 'Premiere Pro',
      'After Effects', 'Final Cut Pro', 'Audacity', 'Ableton', 'FL Studio', 'Cubase', 'Pro Tools',
      'Kontakt', 'Lightroom', 'Inkscape', 'GIMP', 'Krita', 'Midjourney', 'Stable Diffusion', 'ComfyUI',
      'ffmpeg', 'VST', 'bitrate', 'codec', 'FPS', 'HDR', '1080p', 'Roblox', 'Minecraft', 'Xbox',
    ],
  },
}

export function uniqueWords(words: string[]) {
  return Array.from(new Set(words.map((w) => w.trim()).filter(Boolean)))
}

export function parseWordsInput(raw: string) {
  return uniqueWords(raw.split(/[,\uFF0C\n]+/).map((w) => w.trim()))
}

export function collectAllSourceWords(
  builtinWordsMap: Record<string, string[]>,
  customThemes: CustomTheme[],
): Set<string> {
  const set = new Set<string>()
  for (const words of Object.values(builtinWordsMap)) {
    for (const word of words) set.add(word)
  }
  for (const theme of customThemes) {
    for (const word of theme.words) set.add(word)
  }
  return set
}

export function collectActiveSourceWords(
  builtinWordsMap: Record<string, string[]>,
  builtinActiveMap: Record<string, boolean>,
  customThemes: CustomTheme[],
  customThemeActiveMap: Record<string, boolean>,
): string[] {
  const activeWords: string[] = []

  for (const [key, words] of Object.entries(builtinWordsMap)) {
    if (!builtinActiveMap[key]) continue
    activeWords.push(...words)
  }

  for (const theme of customThemes) {
    if (!customThemeActiveMap[theme.id]) continue
    activeWords.push(...theme.words)
  }

  return uniqueWords(activeWords)
}

/**
 * Legacy manual hotwords that move into a custom category. Words of an active built-in set are
 * skipped because they stay active through that set; words of an inactive set are kept, otherwise
 * the migration would silently drop them.
 */
export function legacyWordsToMigrate(
  legacyWords: string[],
  builtinWordsMap: Record<string, string[]>,
  builtinActiveMap: Record<string, boolean>,
): string[] {
  const covered = new Set(collectActiveSourceWords(builtinWordsMap, builtinActiveMap, [], {}))
  return uniqueWords(legacyWords).filter((w) => !covered.has(w))
}

export function composeHotwords(
  preservedWords: string[],
  builtinWordsMap: Record<string, string[]>,
  builtinActiveMap: Record<string, boolean>,
  customThemes: CustomTheme[],
  customThemeActiveMap: Record<string, boolean>,
): string[] {
  const activeWords = collectActiveSourceWords(
    builtinWordsMap,
    builtinActiveMap,
    customThemes,
    customThemeActiveMap,
  )

  return uniqueWords([...preservedWords, ...activeWords]).slice(0, MAX_HOTWORDS)
}

export function normalizeBuiltinSetWords(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, string[]> = {}

  for (const [key, setDef] of Object.entries(BUILTIN_SETS)) {
    const raw = obj[key]
    if (!Array.isArray(raw)) continue

    const allow = new Set(setDef.words)
    result[key] = uniqueWords(raw.map((v) => String(v))).filter((w) => allow.has(w))
  }

  return result
}

/**
 * Fills built-in sets that have no saved word list with their defaults. The store gets a set's
 * words only after the user edits or resets it, so a set added in a later release is missing
 * from existing installs while its saved active flag can already be on.
 */
export function withBuiltinSetDefaults(savedWords: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [key, setDef] of Object.entries(BUILTIN_SETS)) {
    result[key] = savedWords[key] ?? uniqueWords(setDef.words)
  }
  return result
}

export function normalizeBuiltinSetActive(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, boolean> = {}

  for (const key of Object.keys(BUILTIN_SETS)) {
    if (typeof obj[key] === 'boolean') {
      result[key] = obj[key] as boolean
    }
  }

  return result
}

export function normalizeCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return []

  const usedIds = new Set<string>()
  const themes: CustomTheme[] = []

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const name = String(obj.name || '').trim()
    if (!name) continue

    const words = Array.isArray(obj.words) ? uniqueWords(obj.words.map((w) => String(w))) : []
    let id = String(obj.id || '').trim()
    if (!id || usedIds.has(id)) {
      id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    }

    usedIds.add(id)
    themes.push({ id, name, words })
  }

  return themes
}

export function normalizeCustomThemeActive(value: unknown, themes: CustomTheme[]): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const result: Record<string, boolean> = {}

  for (const theme of themes) {
    if (typeof obj[theme.id] === 'boolean') {
      result[theme.id] = obj[theme.id] as boolean
    }
  }

  return result
}

/** Removes `word` from one custom category only; other categories and built-in sets keep it. */
export function removeThemeWord(themes: CustomTheme[], themeId: string, word: string): CustomTheme[] {
  return themes.map((theme) => (
    theme.id === themeId ? { ...theme, words: theme.words.filter((w) => w !== word) } : theme
  ))
}

/**
 * Adds `word` to custom category `themeId`, or removes it when the category already has it.
 * A case-insensitive match counts as present, so picking "GitHub" never adds a second "github".
 */
export function toggleThemeWord(themes: CustomTheme[], themeId: string, word: string): CustomTheme[] {
  const lower = word.toLowerCase()
  return themes.map((theme) => {
    if (theme.id !== themeId) return theme
    const present = theme.words.some((w) => w.toLowerCase() === lower)
    const words = present ? theme.words.filter((w) => w.toLowerCase() !== lower) : [...theme.words, word]
    return { ...theme, words }
  })
}

export function createThemeId() {
  return `theme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}
