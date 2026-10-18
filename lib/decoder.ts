// Chess-aware decoder: picks the sequence of LEGAL moves that best matches
// what was read from the scoresheet. Because every move has to be legal in the
// position the earlier moves produced, one clear move fixes the ambiguous moves
// around it — this is what lets the app read sloppy handwriting.
import { Chess } from "chess.js";
import { matchCost, moveForms, readingVariants } from "./notation";

export interface RawPly {
  /** What the model saw, character for character. */
  asWritten: string;
  /** The model's best guess in English SAN. */
  sanGuess?: string;
  /** Other plausible readings, most likely first. */
  alternatives?: string[];
  legibility?: "clear" | "unclear" | "illegible";
}

export type PlyStatus = "read" | "fixed" | "unsure" | "set";

export interface DecodedPly {
  index: number; // 0-based half-move index
  moveNumber: number;
  color: "w" | "b";
  asWritten: string;
  san: string;
  cost: number;
  status: PlyStatus;
  /** Other legal moves here, best match first (includes the chosen move). */
  suggestions: string[];
  /** Every legal move in the position, for the manual picker. */
  legal: string[];
  fenBefore: string;
  fenAfter: string;
  from: string;
  to: string;
}

export interface DecodeResult {
  plies: DecodedPly[];
  /** Plies that couldn't be placed because the game was already over. */
  leftover: number;
  totalCost: number;
}

interface BeamState {
  fen: string;
  cost: number;
  path: Array<{ san: string; cost: number; from: string; to: string }>;
}

const BEAM_MIN = 6; // always keep at least this many candidate lines
const BEAM_MAX = 40; // keep up to this many when several lines are equally plausible
const BEAM_MARGIN = 0.9; // ...as long as they're within this cost of the best line
const PER_STATE_MIN = 4;
const PER_STATE_MARGIN = 0.9;
const ILLEGIBLE_COST = 1.6;

type VerboseMove = ReturnType<Chess["moves"]>[number] & object;

// Legal-move generation is the slow part, so remember it per position.
// Re-decoding after the user fixes one move then reuses almost everything.
const movesCache = new Map<string, Array<Extract<VerboseMove, { san: string }>>>();
function legalMoves(fen: string) {
  let list = movesCache.get(fen);
  if (!list) {
    list = new Chess(fen).moves({ verbose: true });
    if (movesCache.size > 50000) movesCache.clear();
    movesCache.set(fen, list);
  }
  return list;
}

function plyReadings(p: RawPly, language?: string) {
  const out: Array<{ text: string; cost: number }> = [];
  const push = (raw: string | undefined, penalty: number) => {
    if (!raw) return;
    for (const v of readingVariants(raw, language)) out.push({ text: v.text, cost: v.cost + penalty });
  };
  push(p.sanGuess, 0);
  push(p.asWritten, 0.05);
  (p.alternatives ?? []).slice(0, 4).forEach((a, i) => push(a, 0.25 + i * 0.15));
  return out;
}

export function decodeGame(
  raw: RawPly[],
  opts: { language?: string; pinned?: Record<number, string>; startFen?: string } = {},
): DecodeResult {
  const pinned = opts.pinned ?? {};
  const start = new Chess(opts.startFen);
  let beam: BeamState[] = [{ fen: start.fen(), cost: 0, path: [] }];
  let placed = 0;

  for (let i = 0; i < raw.length; i++) {
    const readings = plyReadings(raw[i], opts.language);
    const illegible = readings.length === 0 || raw[i].legibility === "illegible";
    const next = new Map<string, BeamState>();
    const costCache = new Map<string, number>();
    const costOf = (m: { san: string; from: string; to: string; piece: string; captured?: string; promotion?: string }) => {
      const key = m.from + m.to + m.san;
      let c = costCache.get(key);
      if (c === undefined) {
        c = matchCost(readings, moveForms(m));
        costCache.set(key, c);
      }
      return c;
    };

    for (const state of beam) {
      const moves = legalMoves(state.fen);
      if (moves.length === 0) continue; // game over in this line

      let scored = moves.map((m) => ({
        m,
        c: readings.length === 0 ? ILLEGIBLE_COST : costOf(m),
      }));
      if (illegible && readings.length > 0) scored = scored.map((s) => ({ ...s, c: Math.min(s.c, ILLEGIBLE_COST) }));

      const pin = pinned[i];
      if (pin) {
        const hit = scored.find((s) => s.m.san === pin || s.m.san.replace(/[+#]/g, "") === pin.replace(/[+#]/g, ""));
        scored = hit ? [{ m: hit.m, c: 0 }] : scored;
      }

      scored.sort((a, b) => a.c - b.c);
      const cutoff = scored[0].c + PER_STATE_MARGIN;
      const keep = scored.filter((s, k) => k < PER_STATE_MIN || s.c <= cutoff);
      for (const { m, c } of keep) {
        const fen = m.after; // chess.js gives us the resulting position directly
        const cost = state.cost + c;
        const existing = next.get(fen);
        if (!existing || existing.cost > cost) {
          next.set(fen, { fen, cost, path: [...state.path, { san: m.san, cost: c, from: m.from, to: m.to }] });
        }
      }
    }

    if (next.size === 0) break; // every line has ended (mate/stalemate)
    const sorted = [...next.values()].sort((a, b) => a.cost - b.cost);
    const limit = sorted[0].cost + BEAM_MARGIN;
    beam = sorted.filter((s, k) => k < BEAM_MIN || (k < BEAM_MAX && s.cost <= limit));
    placed = i + 1;
  }

  const best = beam[0];
  const plies: DecodedPly[] = [];
  const replay = new Chess(opts.startFen);
  best.path.forEach((step, i) => {
    const fenBefore = replay.fen();
    const moves = replay.moves({ verbose: true });
    const readings = plyReadings(raw[i], opts.language);
    const ranked = moves
      .map((m) => ({ san: m.san, c: readings.length ? matchCost(readings, moveForms(m)) : ILLEGIBLE_COST }))
      .sort((a, b) => a.c - b.c);
    replay.move(step.san);
    const isPinned = Boolean(pinned[i]);
    let status: PlyStatus;
    if (isPinned) status = "set";
    else if (step.cost <= 0.06) status = "read";
    else if (step.cost < 0.9 && raw[i].legibility !== "illegible") status = "fixed";
    else status = "unsure";
    // a near-tie with another legal move means we're guessing
    if (!isPinned && status !== "unsure" && ranked.length > 1) {
      const runnerUp = ranked.find((r) => r.san !== step.san);
      if (runnerUp && runnerUp.c - step.cost < 0.12 && step.cost > 0.06) status = "unsure";
    }
    plies.push({
      index: i,
      moveNumber: Number(fenBefore.split(" ")[5]),
      color: fenBefore.split(" ")[1] as "w" | "b",
      asWritten: raw[i].asWritten,
      san: step.san,
      cost: step.cost,
      status,
      suggestions: ranked.slice(0, 5).map((r) => r.san),
      legal: moves.map((m) => m.san).sort(),
      fenBefore,
      fenAfter: replay.fen(),
      from: step.from,
      to: step.to,
    });
  });

  return { plies, leftover: raw.length - placed, totalCost: best.cost };
}

/** Build a PGN string from decoded plies and header info. */
export function toPgn(
  plies: DecodedPly[],
  headers: { white?: string; black?: string; event?: string; date?: string; round?: string; result?: string },
): string {
  const result = normalizeResult(headers.result);
  const tag = (k: string, v?: string) => `[${k} "${(v && v.trim()) || "?"}"]`;
  const lines = [
    tag("Event", headers.event),
    tag("Site", "?"),
    tag("Date", headers.date || "????.??.??"),
    tag("Round", headers.round),
    tag("White", headers.white),
    tag("Black", headers.black),
    `[Result "${result}"]`,
    "",
  ];
  const parts: string[] = [];
  for (const p of plies) {
    if (p.color === "w") parts.push(`${p.moveNumber}. ${p.san}`);
    else if (parts.length === 0) parts.push(`${p.moveNumber}... ${p.san}`);
    else parts.push(p.san);
  }
  parts.push(result);
  // wrap at ~80 chars
  let line = "";
  const body: string[] = [];
  for (const w of parts) {
    if ((line + " " + w).trim().length > 80) {
      body.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) body.push(line.trim());
  return lines.join("\n") + "\n" + body.join("\n") + "\n";
}

export function normalizeResult(r?: string): string {
  const s = (r ?? "").replace(/\s/g, "").replace(/½/g, "1/2");
  if (s === "1-0" || s === "0-1" || s === "1/2-1/2") return s;
  if (s === "1/2" || s === "=" || s === "draw") return "1/2-1/2";
  return "*";
}
