// Environment loading and validation. No dependencies: parses .env itself so it
// works the same on Windows, macOS and Linux.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const buf = fs.readFileSync(file);
  // Tolerate files saved by Windows tools as UTF-16 or with a BOM.
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf-8");
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip trailing inline comment on unquoted values
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, "");
    value = value.replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, ".env"));

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const bool = (k: string, d: boolean): boolean => {
  const v = env(k).toLowerCase();
  return v ? ["1", "true", "yes", "on"].includes(v) : d;
};

export const config = {
  sampleMode: bool("SAMPLE_MODE", !fs.existsSync(path.join(ROOT, ".env"))),
  port: Number(env("PORT", "8787")) || 8787,
  zetaris: {
    restUrl: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0").replace(/\/+$/, ""),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"),
    schema: env("ZETARIS_SCHEMA", "echorx"),
  },
  dataBaseUrl: env("DATA_BASE_URL").replace(/\/+$/, ""),
  meterless: {
    baseUrl: normaliseBaseUrl(env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1")),
    token: env("METERLESS_RUNTIME_TOKEN"),
    app: env("METERLESS_APP", "echorx"),
  },
  models: {
    fast: env("MODEL_FAST", "nvidia/nemotron-3.5-lightning-30b-a3b"),
    deep: env("MODEL_DEEP", "nvidia/nemotron-3-ultra-550b-a55b"),
    vision: env("MODEL_VISION", "meterless/vision"),
    fallback: env("MODEL_FALLBACK", "meterless/auto"),
  },
  varDir: path.resolve(ROOT, env("ECHORX_VAR_DIR", "./var")),
  hmemDir: env("ECHORX_VAR_DIR") ? path.resolve(ROOT, env("ECHORX_VAR_DIR"), "hmem") : path.resolve(ROOT, env("HMEM_DIR", "./var/hmem")),
};

/** Power Prompt rule: normalise any pasted URL to <host>/v1 and never produce /v1/v1. */
export function normaliseBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  u = u.replace(/(\/v1)+$/, "");
  u = u.replace(/\/chat\/completions$/, "").replace(/\/models$/, "").replace(/(\/v1)+$/, "");
  return `${u}/v1`;
}

export function liveConfigProblems(): string[] {
  const problems: string[] = [];
  if (!config.zetaris.apiKey || /your-zetaris/.test(config.zetaris.apiKey)) problems.push("ZETARIS_API_KEY is missing from .env");
  if (!config.meterless.token || /your-nightshift|^rt-local$/.test(config.meterless.token)) problems.push("METERLESS_RUNTIME_TOKEN is missing (copy it from Nightshift > Console; 'rt-local' is a placeholder)");
  return problems;
}

fs.mkdirSync(path.join(config.varDir, "cases"), { recursive: true });
fs.mkdirSync(path.join(config.varDir, "traces"), { recursive: true });
