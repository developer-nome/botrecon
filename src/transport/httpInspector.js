import { loadRuntimeConfig } from "../core/env.js";
import { collectPageArtifacts } from "../inspect/htmlCollector.js";
import { analyzeInteraction } from "../inspect/jsAnalyzer.js";
import {
  requestAssistedStrategies,
  shouldUseAssistedInference
} from "../inspect/strategyAssist.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const ADAPTIVE_QUESTION_KEYS = [
  "userRequestText",
  "user_request_text",
  "userRequest",
  "request",
  "question",
  "prompt",
  "message",
  "query",
  "text",
  "input"
];

function resolveEndpoint(baseUrl, endpoint) {
  try {
    return new URL(endpoint, baseUrl).href;
  } catch {
    return null;
  }
}

function toPreview(text, max = 220) {
  if (!text) {
    return "";
  }

  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) {
    return compact;
  }

  return `${compact.slice(0, max - 3)}...`;
}

function chooseQuestionPayload(questionText, applicationPurpose, strategy) {
  const questionKey = strategy.questionKey || "question";
  const payload = {
    [questionKey]: questionText
  };

  if (applicationPurpose?.trim() && strategy.purposeKey && strategy.purposeKey !== questionKey) {
    payload[strategy.purposeKey] = applicationPurpose.trim();
  }

  return payload;
}

function buildRequest(strategy, baseUrl, questionText, applicationPurpose) {
  const resolvedUrl = resolveEndpoint(baseUrl, strategy.endpoint);
  if (!resolvedUrl) {
    return { error: "invalid-endpoint", url: null, init: null };
  }

  const method = (strategy.method || "POST").toUpperCase();
  const payload = chooseQuestionPayload(questionText, applicationPurpose, strategy);
  const headers = {
    Accept: "application/json, text/plain, */*"
  };

  const urlObject = new URL(resolvedUrl);
  const init = {
    method,
    headers,
    redirect: "follow"
  };

  if (strategy.payloadMode === "query" || method === "GET") {
    Object.entries(payload).forEach(([key, value]) => {
      urlObject.searchParams.set(key, value);
    });

    return {
      error: null,
      url: urlObject.href,
      init
    };
  }

  if (strategy.payloadMode === "form") {
    const encoded = new URLSearchParams(payload);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = encoded.toString();

    return {
      error: null,
      url: urlObject.href,
      init
    };
  }

  headers["Content-Type"] = "application/json";
  init.body = JSON.stringify(payload);

  return {
    error: null,
    url: urlObject.href,
    init
  };
}

function findFirstStringValue(obj) {
  if (obj == null) {
    return null;
  }

  if (typeof obj === "string") {
    return obj;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstStringValue(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof obj === "object") {
    const preferredKeys = [
      "answer",
      "response",
      "output",
      "text",
      "content",
      "message",
      "result"
    ];

    for (const key of preferredKeys) {
      if (typeof obj[key] === "string" && obj[key].trim()) {
        return obj[key];
      }

      if (obj[key] && typeof obj[key] === "object") {
        const found = findFirstStringValue(obj[key]);
        if (found) {
          return found;
        }
      }
    }

    for (const value of Object.values(obj)) {
      const found = findFirstStringValue(value);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function parseResponseBody(rawText, contentType) {
  if (!rawText) {
    return { answer: "", parsed: null, responseKind: "empty" };
  }

  if (/json/i.test(contentType || "")) {
    try {
      const parsed = JSON.parse(rawText);
      const answer = findFirstStringValue(parsed) || JSON.stringify(parsed);
      return { answer, parsed, responseKind: "json" };
    } catch {
      return { answer: rawText, parsed: null, responseKind: "text" };
    }
  }

  const looksLikeHtmlDocument =
    /html|xhtml/i.test(contentType || "") || /<!doctype html|<html\b|<head\b|<body\b/i.test(rawText);

  const answerFromHtml = rawText
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    answer: answerFromHtml || rawText,
    parsed: null,
    responseKind: looksLikeHtmlDocument ? "html-document" : "text"
  };
}

function isLikelyPageShellResponse({ rawText, contentType, requestUrl, pageUrl }) {
  const hasDocumentSignals =
    /text\/html|xhtml/i.test(contentType || "") || /<!doctype html|<html\b|<head\b|<body\b/i.test(rawText);
  if (!hasDocumentSignals) {
    return false;
  }

  try {
    const requestPath = new URL(requestUrl).pathname;
    const pagePath = new URL(pageUrl).pathname;

    if (requestPath === pagePath || /index\.html?$/i.test(requestPath)) {
      return true;
    }
  } catch {
    // Ignore parse failures and continue with content heuristics.
  }

  if (/<form\b|<input\b|<button\b|<script\b/i.test(rawText)) {
    return true;
  }

  return false;
}

function looksLikeMeaningfulAnswer(answer = "") {
  const trimmed = answer.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.length < 2) {
    return false;
  }

  if (/url to examine|application purpose|start inspection/i.test(trimmed)) {
    return false;
  }

  return true;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function extractFieldHintsFrom422(validationText = "") {
  const hints = [];
  const quoted = validationText.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g);
  for (const match of quoted) {
    const token = match[1];
    if (/question|request|text|message|prompt|query|input/i.test(token)) {
      hints.push(token);
    }
  }

  for (const match of validationText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\b/g)) {
    const token = match[1];
    if (/question|request|text|message|prompt|query|input/i.test(token)) {
      hints.push(token);
    }
  }

  return uniqueStrings(hints).slice(0, 8);
}

function build422AdaptiveStrategies(strategy, validationText) {
  const discoveredHints = extractFieldHintsFrom422(validationText);
  const candidateKeys = uniqueStrings([
    strategy.questionKey,
    ...discoveredHints,
    ...ADAPTIVE_QUESTION_KEYS
  ]);

  const alternatives = [];
  const seen = new Set();
  const originalSignature = `${strategy.questionKey || "question"}::${strategy.purposeKey || "-"}`;

  for (const questionKey of candidateKeys) {
    const withoutPurpose = {
      ...strategy,
      questionKey,
      purposeKey: null,
      confidence: Math.max(0.05, (strategy.confidence || 0.5) - 0.08)
    };

    const keyA = `${withoutPurpose.questionKey}::${withoutPurpose.purposeKey || "-"}`;
    if (!seen.has(keyA) && keyA !== originalSignature) {
      alternatives.push(withoutPurpose);
      seen.add(keyA);
    }

    if (strategy.purposeKey && strategy.purposeKey !== questionKey) {
      const withPurpose = {
        ...strategy,
        questionKey,
        purposeKey: strategy.purposeKey,
        confidence: Math.max(0.05, (strategy.confidence || 0.5) - 0.12)
      };

      const keyB = `${withPurpose.questionKey}::${withPurpose.purposeKey}`;
      if (!seen.has(keyB) && keyB !== originalSignature) {
        alternatives.push(withPurpose);
        seen.add(keyB);
      }
    }

    if (alternatives.length >= 10) {
      break;
    }
  }

  return alternatives;
}

async function executeStrategy({ strategy, baseUrl, questionText, applicationPurpose }) {
  const built = buildRequest(strategy, baseUrl, questionText, applicationPurpose);
  if (built.error) {
    throw new Error(`request-build-failed:${built.error}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(built.url, {
      ...built.init,
      signal: controller.signal
    });

    const rawText = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const parsedBody = parseResponseBody(rawText, contentType);
    const answer = parsedBody.answer || "(empty response)";

    if (response.ok) {
      if (isLikelyPageShellResponse({ rawText, contentType, requestUrl: built.url, pageUrl: baseUrl })) {
        return {
          answer: toPreview(answer, 420),
          status: "non-answer-html",
          method: `${strategy.method} ${new URL(built.url).pathname}`,
          confidence: Math.max(0.05, (strategy.confidence || 0.5) - 0.35)
        };
      }

      if (!looksLikeMeaningfulAnswer(answer)) {
        return {
          answer: toPreview(answer, 420),
          status: "non-answer-empty",
          method: `${strategy.method} ${new URL(built.url).pathname}`,
          confidence: Math.max(0.05, (strategy.confidence || 0.5) - 0.3)
        };
      }
    }

    const status = response.ok ? "ok" : `http-${response.status}`;
    const confidence = Math.max(
      0.05,
      Math.min(0.99, (strategy.confidence || 0.5) - (response.ok ? 0 : 0.25))
    );

    return {
      answer: toPreview(answer, 420),
      status,
      method: `${strategy.method} ${new URL(built.url).pathname}`,
      confidence,
      responseKind: parsedBody.responseKind,
      httpStatus: response.status,
      validationSource: toPreview(rawText, 1000)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildNoStrategyExecutor(reason) {
  return async ({ question }) => ({
    questionId: question.id,
    answer: reason,
    status: "no-strategy",
    method: "none",
    confidence: 0.05
  });
}

function mergeAndRankCandidates(...candidateLists) {
  const byKey = new Map();

  for (const list of candidateLists) {
    for (const candidate of list || []) {
      const key = `${candidate.method}::${candidate.endpoint}::${candidate.questionKey}`;
      const existing = byKey.get(key);
      if (!existing || (candidate.confidence || 0) > (existing.confidence || 0)) {
        byKey.set(key, candidate);
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 12);
}

export async function createAutoInspectionExecutor({
  targetUrl,
  applicationPurpose,
  onProgress
}) {
  onProgress?.({
    type: "phase-info",
    message: "Collecting HTML and JavaScript artifacts..."
  });

  const artifacts = await collectPageArtifacts(targetUrl);

  onProgress?.({
    type: "phase-info",
    message: "Analyzing client-side transport paths..."
  });

  const analysis = analyzeInteraction(artifacts);
  const staticCandidates = analysis.candidateTransports;
  const runtimeConfig = loadRuntimeConfig();

  let assistedCandidates = [];
  if (shouldUseAssistedInference({ analysis, targetUrl })) {
    const assisted = await requestAssistedStrategies({
      targetUrl,
      applicationPurpose,
      artifacts,
      analysis,
      config: runtimeConfig,
      onProgress
    });

    if (assisted.error) {
      onProgress?.({
        type: "phase-info",
        message: `Assisted inference not available (${assisted.error}). Continuing with static analysis.`
      });
    } else {
      assistedCandidates = assisted.strategies;
      onProgress?.({
        type: "phase-info",
        message: `Assisted inference added ${assistedCandidates.length} candidate strategy(s).`
      });
    }
  }

  let candidates = mergeAndRankCandidates(assistedCandidates, staticCandidates);

  if (candidates.length === 0) {
    const reason = "No candidate request transport could be inferred from HTML/JS or LLM-assisted analysis.";
    onProgress?.({ type: "phase-info", message: reason });
    return buildNoStrategyExecutor(reason);
  }

  const topCandidate = candidates[0];
  onProgress?.({
    type: "phase-info",
    message: `Using ${topCandidate.method} ${topCandidate.endpoint} as primary strategy (${Math.round(topCandidate.confidence * 100)}% confidence).`
  });

  let lateAssistTried = assistedCandidates.length > 0;

  async function executeWithCandidates(question, candidateSet) {
    const errors = [];

    for (const strategy of candidateSet) {
      try {
        const result = await executeStrategy({
          strategy,
          baseUrl: artifacts.finalPageUrl,
          questionText: question.text,
          applicationPurpose
        });

        if (result.status === "ok" && result.answer) {
          return {
            result,
            errors,
            winningStrategy: {
              ...strategy,
              confidence: Math.max(strategy.confidence || 0.5, 0.98)
            }
          };
        }

        errors.push(`${strategy.method} ${strategy.endpoint}: ${result.status}`);

        if (result.status === "http-422") {
          const adaptiveStrategies = build422AdaptiveStrategies(strategy, result.validationSource || result.answer);
          if (adaptiveStrategies.length > 0) {
            onProgress?.({
              type: "phase-info",
              message: `422 received for ${strategy.endpoint}; retrying payload-key variants...`
            });
          }

          for (const adaptiveStrategy of adaptiveStrategies) {
            const adaptiveResult = await executeStrategy({
              strategy: adaptiveStrategy,
              baseUrl: artifacts.finalPageUrl,
              questionText: question.text,
              applicationPurpose
            });

            if (adaptiveResult.status === "ok" && adaptiveResult.answer) {
              return {
                result: adaptiveResult,
                errors,
                winningStrategy: {
                  ...adaptiveStrategy,
                  confidence: Math.max(adaptiveStrategy.confidence || 0.5, 0.98)
                }
              };
            }

            errors.push(
              `${adaptiveStrategy.method} ${adaptiveStrategy.endpoint} [${adaptiveStrategy.questionKey}]: ${adaptiveResult.status}`
            );
          }
        }
      } catch (error) {
        errors.push(
          `${strategy.method} ${strategy.endpoint}: ${error instanceof Error ? error.message : "request-failed"}`
        );
      }
    }

    return { result: null, errors, winningStrategy: null };
  }

  return async ({ question }) => {
    const primaryAttempt = await executeWithCandidates(question, candidates);
    if (primaryAttempt.result) {
      if (primaryAttempt.winningStrategy) {
        candidates = mergeAndRankCandidates([primaryAttempt.winningStrategy], candidates);
      }
      return {
        questionId: question.id,
        ...primaryAttempt.result
      };
    }

    const allErrors = [...primaryAttempt.errors];

    if (!lateAssistTried && runtimeConfig.apiKey && runtimeConfig.baseUrl && runtimeConfig.model) {
      lateAssistTried = true;
      onProgress?.({
        type: "phase-info",
        message: "Primary strategies failed; attempting assisted inference fallback..."
      });

      const assisted = await requestAssistedStrategies({
        targetUrl,
        applicationPurpose,
        artifacts,
        analysis,
        config: runtimeConfig,
        onProgress
      });

      if (!assisted.error && assisted.strategies.length > 0) {
        candidates = mergeAndRankCandidates(candidates, assisted.strategies);
        const assistedAttempt = await executeWithCandidates(question, candidates);

        if (assistedAttempt.result) {
          if (assistedAttempt.winningStrategy) {
            candidates = mergeAndRankCandidates([assistedAttempt.winningStrategy], candidates);
          }
          return {
            questionId: question.id,
            ...assistedAttempt.result
          };
        }

        allErrors.push(...assistedAttempt.errors);
      } else if (assisted.error) {
        allErrors.push(`assisted-inference:${assisted.error}`);
      }
    }

    return {
      questionId: question.id,
      answer: `All inferred strategies failed. ${toPreview(allErrors.join(" | "), 320)}`,
      status: "failed",
      method: "fallback-exhausted",
      confidence: 0.1
    };
  };
}
