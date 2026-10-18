// Turns a reviewed game (image + the moves you confirmed) into one training
// example for OpenAI vision fine-tuning. Collect these, then run
// `npm run fine-tune -- ./training` to train a model on your handwriting.
import type { DecodedPly } from "./decoder";
import { READ_INSTRUCTIONS } from "./prompts";

export interface HeaderInfo {
  white: string;
  black: string;
  event: string;
  date: string;
  round: string;
  result: string;
  language: string;
}

export function buildTrainingExample(images: string[], plies: DecodedPly[], headers: HeaderInfo): string {
  const answer = {
    white: headers.white,
    black: headers.black,
    event: headers.event,
    date: headers.date,
    round: headers.round,
    result: headers.result,
    language: headers.language || "English",
    plies: plies.map((p) => ({
      move_number: p.moveNumber,
      side: p.color === "w" ? "white" : "black",
      as_written: p.asWritten,
      san_guess: p.san.replace(/[+#]/g, ""),
      alternatives: [],
      legibility: "clear",
    })),
  };
  const example = {
    messages: [
      { role: "system", content: READ_INSTRUCTIONS },
      {
        role: "user",
        content: [
          { type: "text", text: `Transcribe this chess scoresheet${images.length > 1 ? ` (${images.length} pages, in order)` : ""}.` },
          ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
        ],
      },
      { role: "assistant", content: JSON.stringify(answer) },
    ],
  };
  return JSON.stringify(example) + "\n";
}
