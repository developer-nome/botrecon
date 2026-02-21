import blessed from "blessed";
import { loadRuntimeConfig, formatConfigSummary } from "../core/env.js";
import { INSPECTION_SCOPE, summarizeScope } from "../core/scope.js";
import { runInspection } from "../core/runner.js";

function isValidUrl(value) {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function splitTokenByWidth(token = "", width = 1, measureWidth = (value) => String(value ?? "").length) {
  if (!token) {
    return [""];
  }

  const lines = [];
  let current = "";

  for (const char of token) {
    const candidate = `${current}${char}`;
    if (measureWidth(candidate) <= width) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
    }
    current = char;
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function wrapLine(text = "", width = 1, measureWidth = (value) => String(value ?? "").length) {
  const safeWidth = Math.max(1, width);
  const trimmed = String(text ?? "").trim();

  if (!trimmed) {
    return [""];
  }

  const words = trimmed.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    if (measureWidth(word) > safeWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      const chunks = splitTokenByWidth(word, safeWidth, measureWidth);
      lines.push(...chunks);
      continue;
    }

    if (!current) {
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;
    if (measureWidth(candidate) <= safeWidth) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function wrapCellText(text = "", width = 1, measureWidth = (value) => String(value ?? "").length) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line, width, measureWidth));
  return lines.length > 0 ? lines : [""];
}

function fitCell(text = "", width = 1, measureWidth = (value) => String(value ?? "").length) {
  const safeWidth = Math.max(1, width);
  const safeText = String(text ?? "");
  let output = "";
  let outputWidth = 0;

  for (const char of safeText) {
    const charWidth = measureWidth(char);
    if (outputWidth + charWidth > safeWidth) {
      break;
    }
    output += char;
    outputWidth += charWidth;
  }

  if (outputWidth < safeWidth) {
    output += " ".repeat(safeWidth - outputWidth);
  }

  return output;
}

function buildResultsTableContent(results = [], totalWidth = 80, measureWidth = (value) => String(value ?? "").length) {
  const safeWidth = Math.max(30, totalWidth);
  const separatorWidth = 1;
  const questionWidth = Math.max(20, Math.floor((safeWidth - separatorWidth) * 0.5));
  const answerWidth = Math.max(20, safeWidth - separatorWidth - questionWidth);
  const separator = "│";
  const divider = `${"─".repeat(questionWidth)}┼${"─".repeat(answerWidth)}`;
  const lines = [
    `${fitCell("Question", questionWidth, measureWidth)}${separator}${fitCell("Answer", answerWidth, measureWidth)}`,
    divider
  ];

  results.forEach((row, index) => {
    const questionLines = wrapCellText(row?.question?.text ?? "", questionWidth, measureWidth);
    const answerLines = wrapCellText(row?.answer ?? "", answerWidth, measureWidth);
    const rowHeight = Math.max(questionLines.length, answerLines.length);

    for (let i = 0; i < rowHeight; i += 1) {
      lines.push(
        `${fitCell(questionLines[i] ?? "", questionWidth, measureWidth)}${separator}${fitCell(answerLines[i] ?? "", answerWidth, measureWidth)}`
      );
    }

    if (index < results.length - 1) {
      lines.push(divider);
    }
  });

  return lines.join("\n");
}

export class BotReconTuiApp {
  constructor() {
    this.config = loadRuntimeConfig();
    this.screen = blessed.screen({
      smartCSR: true,
      title: "BotRecon TUI Inspector"
    });
    this.currentView = "input";

    this.state = {
      targetUrl: "",
      applicationPurpose: "",
      results: []
    };

    this.boundExit = () => {
      this.screen.destroy();
      process.exit(0);
    };
    this.screen.key(["C-c", "f10"], this.boundExit);
    this.screen.key("r", () => {
      if (this.currentView === "report") {
        this.renderInputForm();
      }
    });
  }

  start() {
    this.renderInputForm();
  }

  clearScreen() {
    while (this.screen.children.length > 0) {
      this.screen.children[0].detach();
    }
  }

  renderInputForm() {
    this.clearScreen();
    this.currentView = "input";

    const title = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      content: "{bold}BotRecon Inspector{/bold}  |  Press {bold}Ctrl+C{/bold} or {bold}F10{/bold} to quit",
      style: { fg: "white", bg: "blue" }
    });

    const scopeBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: "100%",
      height: 8,
      tags: true,
      border: "line",
      label: " Scope ",
      content: `${summarizeScope(INSPECTION_SCOPE)}\n\n${formatConfigSummary(this.config)}`
    });

    const form = blessed.form({
      parent: this.screen,
      top: 11,
      left: "center",
      width: "95%",
      height: 12,
      border: "line",
      label: " Inspection Input "
    });

    blessed.text({
      parent: form,
      top: 1,
      left: 2,
      content: "URL to examine:"
    });

    const urlInput = blessed.textbox({
      parent: form,
      name: "targetUrl",
      keys: true,
      inputOnFocus: true,
      top: 2,
      left: 2,
      width: "96%",
      height: 3,
      border: "line",
      value: this.state.targetUrl,
      style: {
        focus: { border: { fg: "cyan" } }
      }
    });

    blessed.text({
      parent: form,
      top: 5,
      left: 2,
      content: "Application purpose:"
    });

    const purposeInput = blessed.textbox({
      parent: form,
      name: "applicationPurpose",
      keys: true,
      inputOnFocus: true,
      top: 6,
      left: 2,
      width: "96%",
      height: 3,
      border: "line",
      value: this.state.applicationPurpose,
      style: {
        focus: { border: { fg: "cyan" } }
      }
    });

    const submit = blessed.button({
      parent: form,
      mouse: true,
      keys: true,
      shrink: true,
      top: 9,
      left: 2,
      name: "submit",
      content: "[ Start Inspection ]",
      style: {
        focus: { bg: "green", fg: "black" },
        hover: { bg: "green", fg: "black" }
      }
    });

    const status = blessed.box({
      parent: this.screen,
      top: 23,
      left: 0,
      width: "100%",
      height: 3,
      border: "line",
      label: " Status ",
      content: this.config.missingKeys.length > 0
        ? `Missing env keys: ${this.config.missingKeys.join(", ")}`
        : "Ready. Type URL, then Tab/Down to move to purpose."
    });

    const stopEditingIfNeeded = (widget) => {
      if (widget && widget._reading && typeof widget._done === "function") {
        widget._done(null, widget.getValue());
      }
    };

    const moveFocus = (from, to) => {
      stopEditingIfNeeded(from);
      to.focus();
      this.screen.render();
      return false;
    };

    urlInput.key(["tab", "down"], () => moveFocus(urlInput, purposeInput));
    purposeInput.key(["S-tab", "up"], () => moveFocus(purposeInput, urlInput));
    purposeInput.key(["tab", "down"], () => moveFocus(purposeInput, submit));
    submit.key(["S-tab", "up"], () => {
      purposeInput.focus();
      this.screen.render();
      return false;
    });

    urlInput.key("enter", () => {
      moveFocus(urlInput, purposeInput);
      return false;
    });

    purposeInput.key("enter", () => {
      submit.emit("press");
      return false;
    });

    [urlInput, purposeInput, submit].forEach((node) => {
      node.key(["C-c", "f10"], this.boundExit);
    });

    submit.on("press", async () => {
      const targetUrl = urlInput.getValue().trim();
      const applicationPurpose = purposeInput.getValue().trim();

      if (this.config.missingKeys.length > 0) {
        status.setContent(`Cannot start: missing env keys ${this.config.missingKeys.join(", ")}`);
        this.screen.render();
        return;
      }

      if (!targetUrl || !isValidUrl(targetUrl)) {
        status.setContent("Please provide a valid URL (including http:// or https://).");
        this.screen.render();
        return;
      }

      if (!applicationPurpose) {
        status.setContent("Please provide the application purpose.");
        this.screen.render();
        return;
      }

      this.state.targetUrl = targetUrl;
      this.state.applicationPurpose = applicationPurpose;

      await this.renderProgressAndRun();
    });

    urlInput.focus();
    this.screen.render();
  }

  async renderProgressAndRun() {
    this.clearScreen();
    this.currentView = "progress";

    const header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      style: { fg: "white", bg: "blue" },
      content: "Running inspection..."
    });

    const current = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: "100%",
      height: 4,
      border: "line",
      label: " Current Question ",
      content: "Preparing..."
    });

    const progressLog = blessed.scrollabletext({
      parent: this.screen,
      top: 7,
      left: 0,
      width: "100%",
      height: "100%-7",
      border: "line",
      label: " Progress ",
      scrollable: true,
      keys: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        inverse: true
      }
    });
    const progressLines = [];
    const addProgressLine = (line) => {
      progressLines.push(line);
      progressLog.setContent(progressLines.join("\n"));
      progressLog.setScrollPerc(100);
    };

    this.screen.render();

    const results = await runInspection({
      targetUrl: this.state.targetUrl,
      applicationPurpose: this.state.applicationPurpose,
      onProgress: ({ type, question, index, total, result, message }) => {
        if (this.currentView !== "progress") {
          return;
        }

        if (type === "phase-info" && message) {
          addProgressLine(message);
        }

        if (type === "question-start") {
          current.setContent(`(${index + 1}/${total}) ${question.text}`);
          addProgressLine(`Starting: ${question.id}`);
        }

        if (type === "question-complete") {
          addProgressLine(`Completed: ${question.id} -> ${result.status}`);
        }

        this.screen.render();
      }
    });

    this.state.results = results;
    this.renderReport();
  }

  renderReport() {
    this.clearScreen();
    this.currentView = "report";

    const header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      style: { fg: "black", bg: "green" },
      content: "Inspection report complete. Press r to run again, Ctrl+C/F10 to quit."
    });

    const summary = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: "100%",
      height: 5,
      border: "line",
      label: " Target ",
      content: [
        `URL: ${this.state.targetUrl}`,
        `Purpose: ${this.state.applicationPurpose}`
      ].join("\n")
    });

    const table = blessed.scrollabletext({
      parent: this.screen,
      top: 8,
      left: 0,
      width: "100%",
      height: "100%-8",
      border: "line",
      label: " Results ",
      wrap: false,
      scrollable: true,
      keys: true,
      mouse: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        inverse: true
      },
      style: {
        fg: "white"
      }
    });

    const renderResultsTable = () => {
      const innerWidth = Math.max(30, table.width - table.iwidth - (table.scrollbar ? 1 : 0));
      table.setContent(
        buildResultsTableContent(
          this.state.results,
          innerWidth,
          (value) => table.strWidth(String(value ?? ""))
        )
      );
    };

    table.on("resize", renderResultsTable);
    renderResultsTable();
    table.focus();
    this.screen.render();
  }
}
