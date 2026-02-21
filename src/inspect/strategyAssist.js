import { requestOpenAiCompatibleJson } from "../llm/openaiCompatClient.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const STATIC_PATH_RE = /\.(?:html?|css|js|png|jpe?g|gif|svg|ico|woff2?|ttf)$/i;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeKey(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "");

  return cleaned || fallback;
}

function looksLikeStaticOrShellEndpoint(endpoint = "", targetUrl = "") {
  if (!endpoint) {
    return true;
  }

  const low = endpoint.toLowerCase();
  if (STATIC_PATH_RE.test(low)) {
    return true;
  }

  if (/(^|\/)index\.html?$/i.test(low)) {
    return true;
  }

  if (low === "/") {
    return true;
  }

  try {
    const resolved = new URL(endpoint, targetUrl);
    const target = new URL(targetUrl);
    if (resolved.pathname === target.pathname) {
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

export function shouldUseAssistedInference({ analysis, targetUrl }) {
  const candidates = analysis?.candidateTransports || [];
  if (candidates.length === 0) {
    return true;
  }

  const top = candidates[0];
  if ((top.confidence ?? 0) < 0.72) {
    return true;
  }

  if (looksLikeStaticOrShellEndpoint(top.endpoint, targetUrl)) {
    return true;
  }

  const allAreFormGets = candidates.every(
    (candidate) => candidate.strategyType === "form" && candidate.method === "GET"
  );

  return allAreFormGets;
}

function extractNetworkSnippets(artifacts) {
  const snippets = [];

  for (const script of artifacts.combinedScripts) {
    const compact = script.code.replace(/\s+/g, " ");
    const regex = /(fetch\s*\([^\)]{0,280}\)|axios\.[a-z]+\s*\([^\)]{0,280}\)|\.open\s*\([^\)]{0,280}\))/gi;

    for (const match of compact.matchAll(regex)) {
      snippets.push({
        source: script.source,
        snippet: match[0]
      });

      if (snippets.length >= 30) {
        return snippets;
      }
    }
  }

  return snippets;
}

function buildPromptPayload({ targetUrl, applicationPurpose, artifacts, analysis }) {
  const networkSnippets = extractNetworkSnippets(artifacts);

  const payload = {
    targetUrl,
    applicationPurpose,
    buttonHandlers: artifacts.buttonHandlers.slice(0, 10),
    forms: artifacts.forms.slice(0, 10),
    staticCandidates: (analysis.candidateTransports || []).slice(0, 8),
    networkSnippets
  };

  return JSON.stringify(payload, null, 2);
}

function normalizeStrategies(rawStrategies, targetUrl) {
  if (!Array.isArray(rawStrategies)) {
    return [];
  }

  const normalized = [];
  for (const raw of rawStrategies) {
    const endpoint = String(raw?.endpoint || "").trim();
    if (!endpoint) {
      continue;
    }

    const method = String(raw?.method || "POST").toUpperCase();
    const safeMethod = ALLOWED_METHODS.has(method) ? method : "POST";

    let payloadMode = String(raw?.payloadMode || "").toLowerCase();
    if (!["json", "form", "query"].includes(payloadMode)) {
      payloadMode = safeMethod === "GET" ? "query" : "json";
    }

    let confidence = Number(raw?.confidence);
    if (!Number.isFinite(confidence)) {
      confidence = 0.7;
    }

    if (looksLikeStaticOrShellEndpoint(endpoint, targetUrl)) {
      confidence -= 0.2;
    }

    normalized.push({
      strategyType: "llm-assist",
      source: "openai-compatible-assist",
      endpoint,
      method: safeMethod,
      payloadMode,
      questionKey: sanitizeKey(raw?.questionKey, "question"),
      purposeKey: sanitizeKey(raw?.purposeKey, "purpose"),
      sourceSnippet: String(raw?.rationale || "LLM-assisted transport inference"),
      confidence: clamp(confidence, 0.1, 0.95)
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const candidate of normalized) {
    const key = `${candidate.method}::${candidate.endpoint}::${candidate.questionKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped.slice(0, 8);
}

export async function requestAssistedStrategies({
  targetUrl,
  applicationPurpose,
  artifacts,
  analysis,
  config,
  onProgress
}) {
  if (!config?.apiKey || !config?.baseUrl || !config?.model) {
    return { strategies: [], error: "missing-llm-config" };
  }

  const userPayload = buildPromptPayload({
    targetUrl,
    applicationPurpose,
    artifacts,
    analysis
  });

  onProgress?.({
    type: "phase-info",
    message: "Running OpenAI-compatible assisted inference for transport strategy..."
  });

  const systemPrompt = [
    "You are a web app reverse engineering assistant.",
    "Infer likely HTTP request strategies used to send chat/user questions.",
    "Return strict JSON only.",
    "Schema: {\"strategies\":[{\"endpoint\":string,\"method\":\"GET\"|\"POST\"|\"PUT\"|\"PATCH\"|\"DELETE\",\"payloadMode\":\"json\"|\"form\"|\"query\",\"questionKey\":string,\"purposeKey\":string,\"confidence\":number,\"rationale\":string}]}",
    "Prefer API-like endpoints over static/html pages."
  ].join(" ");

  const response = await requestOpenAiCompatibleJson({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPayload }
    ]
  });

  if (!response.ok) {
    return {
      strategies: [],
      error: response.error || "llm-assist-failed"
    };
  }

  const strategies = normalizeStrategies(response.data?.strategies, targetUrl);
  if (strategies.length === 0) {
    return {
      strategies: [],
      error: "llm-no-strategies"
    };
  }

  return {
    strategies,
    error: null
  };
}
