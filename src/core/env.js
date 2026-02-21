import path from "node:path";
import dotenv from "dotenv";

const REQUIRED_ENV_KEYS = ["API_KEY_", "BASE_URL", "LLM_MODEL"];

export function loadRuntimeConfig() {
  const envPath = path.resolve(process.cwd(), ".env");
  dotenv.config({ path: envPath });

  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => !process.env[key]);

  return {
    envPath,
    missingKeys,
    apiKey: process.env.API_KEY_ ?? "",
    baseUrl: process.env.BASE_URL ?? "",
    model: process.env.LLM_MODEL ?? ""
  };
}

export function formatConfigSummary(config) {
  const redactedKey = config.apiKey ? `${config.apiKey.slice(0, 4)}...` : "(missing)";

  return [
    "Environment configuration:",
    `- API_KEY_: ${redactedKey}`,
    `- BASE_URL: ${config.baseUrl || "(missing)"}`,
    `- LLM_MODEL: ${config.model || "(missing)"}`
  ].join("\n");
}
