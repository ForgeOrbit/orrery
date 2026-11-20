import { Question } from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

// Answering is a human REST operation; there is no MCP answer path. The server refuses
// agent keys, Readers and unrelated members even if a client calls this directly.
export async function answerQuestion(questionId: string, answer: string): Promise<Question> {
  return postJson(`/api/questions/${encodeURIComponent(questionId)}/answer`, { answer }, (value) =>
    Question.parse(value),
  );
}
