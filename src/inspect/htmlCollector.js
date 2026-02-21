const DEFAULT_FETCH_TIMEOUT_MS = 10000;

function parseAttributes(raw = "") {
  const attributes = {};
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_:.\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/=`]+)))?/g;

  for (const match of raw.matchAll(attrRegex)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (key) {
      attributes[key] = value;
    }
  }

  return attributes;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

async function fetchWithTimeout(url, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: response.headers,
      text
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractForms(html) {
  const forms = [];
  const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;

  for (const match of html.matchAll(formRegex)) {
    const attrs = parseAttributes(match[1]);
    const body = match[2] ?? "";

    const inputs = [];
    const inputRegex = /<(input|textarea|select)\b([^>]*)>/gi;
    for (const inputMatch of body.matchAll(inputRegex)) {
      const inputAttrs = parseAttributes(inputMatch[2]);
      inputs.push({
        tag: inputMatch[1].toLowerCase(),
        name: inputAttrs.name ?? "",
        id: inputAttrs.id ?? "",
        type: inputAttrs.type ?? ""
      });
    }

    forms.push({
      action: attrs.action ?? "",
      method: (attrs.method ?? "GET").toUpperCase(),
      enctype: (attrs.enctype ?? "").toLowerCase(),
      id: attrs.id ?? "",
      name: attrs.name ?? "",
      inputs
    });
  }

  return forms;
}

function extractButtonHandlers(html) {
  const handlers = [];
  const buttonRegex = /<(button|input)\b([^>]*)>/gi;

  for (const match of html.matchAll(buttonRegex)) {
    const attrs = parseAttributes(match[2]);
    const onclick = attrs.onclick ?? "";

    if (!onclick) {
      continue;
    }

    const callMatch = onclick.match(/([A-Za-z_$][\w$]*)\s*\(/);
    handlers.push({
      tag: match[1].toLowerCase(),
      id: attrs.id ?? "",
      name: attrs.name ?? "",
      onclick,
      handlerName: callMatch?.[1] ?? ""
    });
  }

  return handlers;
}

function extractScripts(html) {
  const inlineScripts = [];
  const externalScriptRefs = [];
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(scriptRegex)) {
    const attrs = parseAttributes(match[1]);
    const body = match[2] ?? "";

    if (attrs.src) {
      externalScriptRefs.push(attrs.src.trim());
      continue;
    }

    if (body.trim()) {
      inlineScripts.push(stripComments(body));
    }
  }

  return { inlineScripts, externalScriptRefs };
}

function resolveUrl(baseUrl, maybeRelativeUrl) {
  try {
    return new URL(maybeRelativeUrl, baseUrl).href;
  } catch {
    return null;
  }
}

export async function collectPageArtifacts(targetUrl) {
  const page = await fetchWithTimeout(targetUrl);

  if (!page.ok) {
    throw new Error(`Failed to fetch target page: HTTP ${page.status}`);
  }

  const html = page.text;
  const forms = extractForms(html);
  const buttonHandlers = extractButtonHandlers(html);
  const { inlineScripts, externalScriptRefs } = extractScripts(html);

  const externalScripts = [];
  for (const scriptRef of externalScriptRefs) {
    const resolvedUrl = resolveUrl(page.url || targetUrl, scriptRef);
    if (!resolvedUrl) {
      externalScripts.push({ url: scriptRef, error: "invalid-url", code: "" });
      continue;
    }

    try {
      const response = await fetchWithTimeout(resolvedUrl);
      if (!response.ok) {
        externalScripts.push({ url: resolvedUrl, error: `http-${response.status}`, code: "" });
        continue;
      }

      externalScripts.push({
        url: resolvedUrl,
        error: null,
        code: stripComments(response.text)
      });
    } catch (error) {
      externalScripts.push({
        url: resolvedUrl,
        error: error instanceof Error ? error.message : "fetch-failed",
        code: ""
      });
    }
  }

  return {
    targetUrl,
    finalPageUrl: page.url || targetUrl,
    html,
    forms,
    buttonHandlers,
    inlineScripts,
    externalScripts,
    combinedScripts: [
      ...inlineScripts.map((code, index) => ({ source: `inline-${index + 1}`, code })),
      ...externalScripts
        .filter((script) => script.code)
        .map((script) => ({ source: script.url, code: script.code }))
    ]
  };
}
