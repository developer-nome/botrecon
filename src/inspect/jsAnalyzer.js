const QUESTION_KEY_HINTS = [
  "question",
  "prompt",
  "message",
  "query",
  "input",
  "text",
  "request",
  "userrequest",
  "userrequesttext",
  "userinput"
];
const PURPOSE_KEY_HINTS = ["purpose", "domain", "topic", "intent", "context"];
const STATIC_PATH_RE = /\.(?:html?|css|js|png|jpe?g|gif|svg|ico|woff2?|ttf)$/i;

function extractMethod(optionsChunk = "") {
  const methodMatch = optionsChunk.match(/method\s*:\s*['\"]([A-Za-z]+)['\"]/i);
  if (methodMatch) {
    return methodMatch[1].toUpperCase();
  }
  return "POST";
}

function hasQuestionishToken(text = "") {
  return /question|prompt|message|query|ask|input|chat|llm|bot|token|response|api|completions|inference|generate/i.test(text);
}

function isLikelyStaticOrShellEndpoint(endpoint = "", finalPageUrl = "") {
  const normalized = endpoint.toLowerCase().trim();
  if (!normalized) {
    return true;
  }

  if (STATIC_PATH_RE.test(normalized)) {
    return true;
  }

  if (/(^|\/)index\.html?$/.test(normalized) || normalized === "/") {
    return true;
  }

  try {
    const resolved = new URL(endpoint, finalPageUrl);
    const page = new URL(finalPageUrl);
    return resolved.pathname === page.pathname;
  } catch {
    return false;
  }
}

function inferPayloadKeys(snippet = "") {
  const keys = [];
  const bodyObject = snippet.match(/JSON\.stringify\s*\(\s*\{([\s\S]*?)\}\s*\)/i);
  if (bodyObject?.[1]) {
    for (const match of bodyObject[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
      keys.push(match[1]);
    }
  }

  if (keys.length === 0) {
    for (const hint of QUESTION_KEY_HINTS) {
      if (new RegExp(`\\b${hint}\\b`, "i").test(snippet)) {
        keys.push(hint);
      }
    }
  }

  return Array.from(new Set(keys));
}

function inferQuestionKey(keys = [], formInputs = []) {
  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (QUESTION_KEY_HINTS.some((hint) => normalized === hint || normalized.includes(hint))) {
      return key;
    }
  }

  for (const input of formInputs) {
    const candidate = (input.name || input.id || "").toLowerCase();
    if (QUESTION_KEY_HINTS.some((hint) => candidate.includes(hint))) {
      return input.name || input.id;
    }
  }

  const firstNamedInput = formInputs.find((input) => input.name || input.id);
  if (firstNamedInput) {
    return firstNamedInput.name || firstNamedInput.id;
  }

  return "question";
}

function inferPurposeKey(keys = []) {
  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (PURPOSE_KEY_HINTS.some((hint) => normalized === hint || normalized.includes(hint))) {
      return key;
    }
  }

  return null;
}

function scoreCandidate({
  endpoint = "",
  method = "POST",
  sourceSnippet = "",
  strategyType = "unknown",
  finalPageUrl = "",
  hasHandlerSignal = false
}) {
  let score = 0.35;

  if (endpoint) {
    score += 0.2;
  }

  if (method === "POST") {
    score += 0.15;
  }

  if (hasQuestionishToken(endpoint)) {
    score += 0.15;
  }

  if (hasQuestionishToken(sourceSnippet)) {
    score += 0.1;
  }

  if (strategyType !== "form") {
    score += 0.05;
  }

  if (hasHandlerSignal) {
    score += 0.1;
  }

  if (isLikelyStaticOrShellEndpoint(endpoint, finalPageUrl)) {
    score -= 0.3;
  }

  return Math.min(score, 0.95);
}

function findFetchCandidates(script, source, formInputs, finalPageUrl, handlerNames = []) {
  const candidates = [];
  const fetchRegex = /fetch\s*\(\s*(['\"`])([^'\"`]+)\1\s*(?:,\s*(\{[\s\S]{0,800}?\}))?\s*\)/gi;

  for (const match of script.matchAll(fetchRegex)) {
    const endpoint = match[2]?.trim() || "";
    const optionsChunk = match[3] || "";
    const method = extractMethod(optionsChunk);
    const payloadKeys = inferPayloadKeys(optionsChunk);
    const hasHandlerSignal = handlerNames.some((name) => script.includes(`${name}(`));

    candidates.push({
      strategyType: "fetch",
      source,
      endpoint,
      method,
      payloadMode: method === "GET" ? "query" : "json",
      questionKey: inferQuestionKey(payloadKeys, formInputs),
      purposeKey: inferPurposeKey(payloadKeys),
      sourceSnippet: match[0],
      confidence: scoreCandidate({
        endpoint,
        method,
        sourceSnippet: match[0],
        strategyType: "fetch",
        finalPageUrl,
        hasHandlerSignal
      })
    });
  }

  return candidates;
}

function findAxiosCandidates(script, source, formInputs, finalPageUrl, handlerNames = []) {
  const candidates = [];

  const axiosMethodRegex = /axios\.(get|post|put|patch|delete)\s*\(\s*(['\"`])([^'\"`]+)\2/gi;
  for (const match of script.matchAll(axiosMethodRegex)) {
    const method = match[1].toUpperCase();
    const endpoint = match[3]?.trim() || "";
    const hasHandlerSignal = handlerNames.some((name) => script.includes(`${name}(`));

    candidates.push({
      strategyType: "axios",
      source,
      endpoint,
      method,
      payloadMode: method === "GET" ? "query" : "json",
      questionKey: inferQuestionKey([], formInputs),
      purposeKey: "purpose",
      sourceSnippet: match[0],
      confidence: scoreCandidate({
        endpoint,
        method,
        sourceSnippet: match[0],
        strategyType: "axios",
        finalPageUrl,
        hasHandlerSignal
      })
    });
  }

  return candidates;
}

function findXhrCandidates(script, source, formInputs, finalPageUrl, handlerNames = []) {
  const candidates = [];
  const xhrRegex = /\.open\s*\(\s*['\"]([A-Za-z]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]/gi;

  for (const match of script.matchAll(xhrRegex)) {
    const method = match[1].toUpperCase();
    const endpoint = match[2]?.trim() || "";
    const hasHandlerSignal = handlerNames.some((name) => script.includes(`${name}(`));

    candidates.push({
      strategyType: "xhr",
      source,
      endpoint,
      method,
      payloadMode: method === "GET" ? "query" : "json",
      questionKey: inferQuestionKey([], formInputs),
      purposeKey: "purpose",
      sourceSnippet: match[0],
      confidence: scoreCandidate({
        endpoint,
        method,
        sourceSnippet: match[0],
        strategyType: "xhr",
        finalPageUrl,
        hasHandlerSignal
      })
    });
  }

  return candidates;
}

function findFormCandidates(forms = [], pageUrl = "") {
  return forms
    .map((form) => {
      const endpoint = form.action || pageUrl;
      const method = (form.method || "GET").toUpperCase();
      const payloadMode = method === "GET" ? "query" : "form";

      return {
        strategyType: "form",
        source: form.id || form.name || "html-form",
        endpoint,
        method,
        payloadMode,
        questionKey: inferQuestionKey([], form.inputs || []),
        purposeKey: "purpose",
        sourceSnippet: JSON.stringify(form),
        confidence: scoreCandidate({
          endpoint,
          method,
          sourceSnippet: JSON.stringify(form),
          strategyType: "form",
          finalPageUrl: pageUrl
        })
      };
    })
    .filter((candidate) => Boolean(candidate.endpoint));
}

function dedupeByEndpointAndMethod(candidates = []) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    const key = `${candidate.method}::${candidate.endpoint}::${candidate.questionKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(candidate);
  }

  return output;
}

export function analyzeInteraction(artifacts) {
  const formInputs = artifacts.forms.flatMap((form) => form.inputs || []);
  const handlerNames = artifacts.buttonHandlers
    .map((handler) => handler.handlerName)
    .filter(Boolean);
  const scriptCandidates = [];

  for (const script of artifacts.combinedScripts) {
    scriptCandidates.push(
      ...findFetchCandidates(
        script.code,
        script.source,
        formInputs,
        artifacts.finalPageUrl,
        handlerNames
      )
    );
    scriptCandidates.push(
      ...findAxiosCandidates(
        script.code,
        script.source,
        formInputs,
        artifacts.finalPageUrl,
        handlerNames
      )
    );
    scriptCandidates.push(
      ...findXhrCandidates(
        script.code,
        script.source,
        formInputs,
        artifacts.finalPageUrl,
        handlerNames
      )
    );
  }

  const formCandidates = findFormCandidates(artifacts.forms, artifacts.finalPageUrl);

  const allCandidates = dedupeByEndpointAndMethod([...scriptCandidates, ...formCandidates])
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);

  return {
    buttonHandlers: artifacts.buttonHandlers,
    candidateTransports: allCandidates,
    summary: {
      inlineScripts: artifacts.inlineScripts.length,
      externalScripts: artifacts.externalScripts.length,
      forms: artifacts.forms.length,
      handlers: artifacts.buttonHandlers.length,
      candidates: allCandidates.length
    }
  };
}
