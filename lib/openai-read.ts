// Server-only: talks to OpenAI to read the scoresheet image(s).
import type { RawPly } from "./decoder";
import { READ_INSTRUCTIONS, READ_SCHEMA } from "./prompts";

const API = "https://api.openai.com/v1/responses";

/** Models tried in order. OPENAI_MODEL (e.g. your fine-tuned model) always goes first. */
function modelChain(): string[] {
  const chain = [process.env.OPENAI_MODEL, "gpt-6.1-sol", "gpt-6-astra", "gpt-5", "gpt-4.1"];
  return [...new Set(chain.filter((m): m is string => Boolean(m && m.trim())).map((m) => m.trim()))];
}

export class MissingKeyError extends Error {}

export interface SheetReading {
  white: string;
  black: string;
  event: string;
  date: string;
  round: string;
  result: string;
  language: string;
  plies: RawPly[];
  model: string;
}

interface RawSheet {
  white: string;
  black: string;
  event: string;
  date: string;
  round: string;
  result: string;
  language: string;
  plies: Array<{
    move_number: number;
    side: "white" | "black";
    as_written: string;
    san_guess: string;
    alternatives: string[];
    legibility: "clear" | "unclear" | "illegible";
  }>;
}

async function callOpenAI(body: Record<string, unknown>): Promise<{ json: unknown; model: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new MissingKeyError("OPENAI_API_KEY is not set");
  let lastError = "No model available";
  for (const model of modelChain()) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error ?? {};
      lastError = `${model}: ${err.message ?? res.statusText}`;
      const modelProblem =
        res.status === 404 || err.code === "model_not_found" || /model/i.test(err.param ?? "") || /does not exist|not supported|unsupported model/i.test(err.message ?? "");
      if (modelProblem) continue; // try the next model
      if (res.status === 401) throw new Error("OpenAI rejected the API key. Check OPENAI_API_KEY in your Vercel settings.");
      if (res.status === 429) throw new Error("OpenAI rate limit or quota reached. Check your OpenAI billing, then try again.");
      throw new Error(lastError);
    }
    const text = extractText(data);
    if (!text) throw new Error(`${model} returned no text`);
    return { json: JSON.parse(text), model };
  }
  throw new Error(lastError);
}

function extractText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
  for (const item of data?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (c?.type === "output_text" && typeof c.text === "string") return c.text;
      if (c?.type === "refusal") throw new Error("The model declined to read this image.");
    }
  }
  return "";
}

function imageParts(images: string[]) {
  return images.map((url) => ({ type: "input_image", image_url: url, detail: "high" }));
}

/** First pass: transcribe the whole sheet. */
export async function readSheet(images: string[]): Promise<SheetReading> {
  const { json, model } = await callOpenAI({
    instructions: READ_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `Transcribe this chess scoresheet${images.length > 1 ? ` (${images.length} pages, in order)` : ""}.` },
          ...imageParts(images),
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "scoresheet", strict: true, schema: READ_SCHEMA } },
  });
  const sheet = json as RawSheet;
  return {
    white: sheet.white,
    black: sheet.black,
    event: sheet.event,
    date: sheet.date,
    round: sheet.round,
    result: sheet.result,
    language: sheet.language,
    model,
    plies: (sheet.plies ?? []).map((p) => ({
      asWritten: p.as_written,
      sanGuess: p.san_guess,
      alternatives: p.alternatives,
      legibility: p.legibility,
    })),
  };
}

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["choices"],
  properties: {
    choices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ply", "move", "confident"],
        properties: {
          ply: { type: "integer" },
          move: { type: "string" },
          confident: { type: "boolean" },
        },
      },
    },
  },
} as const;

export interface VerifyQuestion {
  ply: number;
  label: string; // e.g. "23... (Black's 23rd move)"
  asWritten: string;
  legal: string[];
}

/** Second pass: for doubtful moves, show the model the legal options and let it look again. */
export async function verifyMoves(images: string[], questions: VerifyQuestion[]) {
  if (questions.length === 0) return [];
  const list = questions
    .map(
      (q) =>
        `ply ${q.ply} — move ${q.label}; first reading "${q.asWritten || "(blank)"}"; legal moves here: ${q.legal.join(", ")}`,
    )
    .join("\n");
  const { json } = await callOpenAI({
    instructions:
      "You check doubtful moves on a handwritten chess scoresheet. For each listed move, look at that cell again and pick the legal move that best matches the handwriting. You must choose from the legal list given. Set confident=false if the handwriting could reasonably be more than one of them.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `Doubtful moves:\n${list}` }, ...imageParts(images)],
      },
    ],
    text: { format: { type: "json_schema", name: "verification", strict: true, schema: VERIFY_SCHEMA } },
  });
  return (json as { choices: Array<{ ply: number; move: string; confident: boolean }> }).choices ?? [];
}
