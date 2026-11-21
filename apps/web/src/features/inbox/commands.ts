import { Question } from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

export async function answerQuestion(questionId: string, answer: string): Promise<Question> {
  return postJson(`/api/questions/${encodeURIComponent(questionId)}/answer`, { answer }, (value) =>
    Question.parse(value),
  );
}
