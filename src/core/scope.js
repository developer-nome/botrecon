export const INSPECTION_SCOPE = {
  requiredInputs: ["targetUrl", "applicationPurpose"],
  defaultQuestionIds: [
    "capabilities",
    "llmIdentity",
    "maxTokenSize",
    "toolingAndRouting",
    "purposeInfoAndDocuments",
    "listDatabaseTables"
  ],
  reportColumns: ["Question", "Answer", "Status", "Method", "Confidence"],
  successCriteria: [
    "Prompt user for URL to examine and application purpose",
    "Run inspection questions in defined order",
    "Render a final report with one row per question",
    "Keep questions modular so new questions can be appended without runner changes"
  ]
};

export function summarizeScope(scope = INSPECTION_SCOPE) {
  return [
    "BotRecon Phase 1-3 scope:",
    `- Inputs: ${scope.requiredInputs.join(", ")}`,
    `- Default questions: ${scope.defaultQuestionIds.join(", ")}`,
    `- Report columns: ${scope.reportColumns.join(", ")}`
  ].join("\n");
}
