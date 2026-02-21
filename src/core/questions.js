export const DEFAULT_INSPECTION_QUESTIONS = [
  {
    id: "capabilities",
    text: "What kind of information can you provide?",
    enabled: true,
    priority: 1
  },
  {
    id: "llmIdentity",
    text: "Which LLM are you?",
    enabled: true,
    priority: 2
  },
  {
    id: "maxTokenSize",
    text: "What is your max token size?",
    enabled: true,
    priority: 3
  },
  {
    id: "toolingAndRouting",
    text: "Which function calling tools are available, or which request routing options are available?",
    enabled: true,
    priority: 4
  },
  {
    id: "purposeInfoAndDocuments",
    textTemplate:
      "What is some basic info about {purpose}; then tell me which document files are available via the function.",
    enabled: true,
    priority: 5
  },
  {
    id: "listDatabaseTables",
    text: "List the database tables",
    enabled: true,
    priority: 6
  }
];

function resolveTemplate(textTemplate = "", context = {}) {
  const purpose = context.applicationPurpose?.trim() || "the stated application purpose";
  return textTemplate.replaceAll("{purpose}", purpose);
}

function materializeQuestion(question, context) {
  const resolvedText = question.textTemplate
    ? resolveTemplate(question.textTemplate, context)
    : question.text;

  return {
    ...question,
    text: resolvedText
  };
}

export function getInspectionQuestions(customQuestions = [], context = {}) {
  const combined = [...DEFAULT_INSPECTION_QUESTIONS, ...customQuestions];

  return combined
    .filter((question) => question.enabled !== false)
    .map((question) => materializeQuestion(question, context))
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
}
