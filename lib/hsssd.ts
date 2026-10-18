// Helpers for the public HSSSD dataset (Handwritten Standardized Chess Scoresheet
// Dataset, huggingface.co/datasets/BenjaminKost/HSSSD). Used only to measure accuracy.
import { decodeGame, type DecodedPly, type RawPly } from "./decoder";

export const HSSSD_ROWS = 228;
const API = "https://datasets-server.huggingface.co/rows?dataset=BenjaminKost/HSSSD&config=default&split=train";

export interface HsssdRow {
  index: number;
  imageUrl: string;
  width: number;
  height: number;
  labels: string[];
}

export async function fetchRow(index: number): Promise<HsssdRow> {
  const res = await fetch(`${API}&offset=${index}&length=1`);
  const data = await res.json().catch(() => ({}));
  const row = data?.rows?.[0]?.row;
  if (!res.ok || !row?.image?.src) throw new Error(data?.error ? "The dataset viewer couldn't load this sheet." : `Dataset error (${res.status}).`);
  return { index, imageUrl: row.image.src, width: row.image.width, height: row.image.height, labels: row.labels ?? [] };
}

// A token that looks like a move in English or German notation (pieces K D T L S / K Q R B N).
const MOVE_TOKEN = /^(?:[KQRBNDTLS]?[a-h]?[1-8]?[x:]?[a-h][1-8](?:=?[QRBNDTLS])?[+#]?|[O0]-[O0](?:-[O0])?[+#]?)$/;

/** Pull the move list out of a label (header text, names and opening name come first). */
export function labelMoves(labels: string[]): string[] {
  const tokens = labels.join("").split(/\s+/).filter(Boolean);
  const isMove = (t: string) => MOVE_TOKEN.test(t);
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens.slice(i, i + 4).length >= 2 && tokens.slice(i, i + 4).every(isMove)) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const moves: string[] = [];
  for (let i = start; i < tokens.length && isMove(tokens[i]); i++) moves.push(tokens[i]);
  return moves;
}

/** The true game, decoded with chess rules from the typed-out label. Null if the label isn't a clean legal game. */
export function truthFromLabels(labels: string[]): DecodedPly[] | null {
  const moves = labelMoves(labels);
  if (moves.length < 4) return null;
  const raw: RawPly[] = moves.map((m) => ({ asWritten: m }));
  const res = decodeGame(raw, { language: "German" });
  // labels are typed text, so nearly every move should match exactly
  const exact = res.plies.filter((p) => p.cost <= 0.4).length;
  if (res.plies.length < moves.length * 0.9 || exact < res.plies.length * 0.9) return null;
  return res.plies;
}

export interface SheetScore {
  total: number;
  aiOnly: number; // moves the AI's raw reading got right
  withRules: number; // moves right after the chess-rule checker
  mistakes: Array<{ label: string; truth: string; got: string }>;
}

const bare = (s: string) => s.replace(/[+#!?x:]/g, "").replace(/^0-0-0$/, "O-O-O").replace(/^0-0$/, "O-O");

/** Compare a reading with the truth, move by move. */
export function scoreSheet(truth: DecodedPly[], rawFromAi: RawPly[], decoded: DecodedPly[]): SheetScore {
  let aiOnly = 0;
  let withRules = 0;
  const mistakes: SheetScore["mistakes"] = [];
  truth.forEach((t, i) => {
    const label = `${t.moveNumber}${t.color === "w" ? "." : "..."}`;
    const guess = rawFromAi[i]?.sanGuess ?? rawFromAi[i]?.asWritten ?? "";
    if (guess && bare(guess) === bare(t.san)) aiOnly++;
    const got = decoded[i]?.san;
    if (got === t.san) withRules++;
    else mistakes.push({ label, truth: t.san, got: got ?? "(missing)" });
  });
  return { total: truth.length, aiOnly, withRules, mistakes };
}
