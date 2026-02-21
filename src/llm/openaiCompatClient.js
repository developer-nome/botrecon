const DEFAULT_TIMEOUT_MS = 20000;

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildChatCompletionsUrl(baseUrl) {
  if (!baseUrl) {
    return null;
  }

  const normalized = ensureTrailingSlash(baseUrl.trim());
  if (/\/chat\/completions\/?$/i.test(normalized)) {
    return normalized.replace(/\/$/, "");
  }

  try {
    return new URL("chat/completions", normalized).href;
  } catch {
    return null;
  }
}

function extractAssistantText(responseJson) {
  const choice = responseJson?.choices?.[0];
  if (!choice) {
    return "";
  }

  if (typeof choice.message?.content === "string") {
    return choice.message.content;
  }

  if (Array.isArray(choice.message?.content)) {
    return choice.message.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  }

  if (typeof choice.text === "string") {
    return choice.text;
  }

  return "";
}

function tryParseJson(text) {
  if (!text || !text.trim()) {
    return null;
  }

  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
    // Continue to fenced/substring parsing.
  }

  const fenced = direct.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch {
      // Continue to brace parsing.
    }
  }

  const start = direct.indexOf("{");
  const end = direct.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = direct.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }

  return null;
}

export async function requestOpenAiCompatibleJson({
  apiKey,
  baseUrl,
  model,
  messages,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!apiKey || !baseUrl || !model) {
    return {
      ok: false,
      error: "missing-llm-config",
      data: null,
      rawText: ""
    };
  }

  const url = buildChatCompletionsUrl(baseUrl);
  if (!url) {
    return {
      ok: false,
      error: "invalid-base-url",
      data: null,
      rawText: ""
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: `llm-http-${response.status}`,
        data: null,
        rawText: raw
      };
    }

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "llm-invalid-json-response",
        data: null,
        rawText: raw
      };
    }

    const content = extractAssistantText(parsedResponse);
    const data = tryParseJson(content);
    if (!data) {
      return {
        ok: false,
        error: "llm-invalid-json-content",
        data: null,
        rawText: content || raw
      };
    }

    return {
      ok: true,
      error: null,
      data,
      rawText: content
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "llm-request-failed",
      data: null,
      rawText: ""
    };
  } finally {
    clearTimeout(timeout);
  }
}
