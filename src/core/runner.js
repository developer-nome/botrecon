import { getInspectionQuestions } from "./questions.js";
import { createAutoInspectionExecutor } from "../transport/httpInspector.js";

export async function runInspection({ targetUrl, applicationPurpose, executor, onProgress }) {
  const questions = getInspectionQuestions([], { applicationPurpose });
  const results = [];
  let activeExecutor = executor;

  if (!activeExecutor) {
    activeExecutor = await createAutoInspectionExecutor({
      targetUrl,
      applicationPurpose,
      onProgress
    });
  }

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    onProgress?.({ type: "question-start", question, index: i, total: questions.length });

    const result = await activeExecutor({ question, targetUrl, applicationPurpose });

    results.push({ question, ...result });
    onProgress?.({ type: "question-complete", question, result, index: i, total: questions.length });
  }

  return results;
}
