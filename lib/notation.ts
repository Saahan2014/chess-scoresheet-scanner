// Turns a messy handwritten move reading into comparable forms, and scores how
// close a reading is to a legal move, using costs tuned for handwriting mistakes.

/** Characters people's handwriting (or the vision model) commonly confuses. */
const CONFUSIONS: Array<[string, string, number]> = [
  // digits vs digits
  ["1", "7", 0.35], ["3", "8", 0.35], ["5", "6", 0.4], ["6", "8", 0.4], ["3", "5", 0.45],
  ["4", "9", 0.45], ["1", "4", 0.5], ["2", "7", 0.5], ["7", "4", 0.5], ["0", "6", 0.45],
  ["0", "8", 0.5], ["2", "3", 0.5], ["5", "3", 0.45],
  // files vs files
  ["a", "d", 0.35], ["c", "e", 0.35], ["a", "e", 0.45], ["b", "h", 0.35], ["d", "b", 0.5],
  ["a", "c", 0.5], ["f", "t", 0.5], ["g", "q", 0.4], ["e", "f", 0.55], ["h", "n", 0.45],
  // letters vs digits
  ["g", "9", 0.3], ["b", "6", 0.3], ["l", "1", 0.2], ["i", "1", 0.3], ["o", "0", 0.2],
  ["s", "5", 0.3], ["z", "2", 0.35], ["a", "4", 0.5], ["e", "3", 0.5], ["b", "8", 0.4],
  ["d", "0", 0.5], ["q", "9", 0.4], ["h", "4", 0.5], ["f", "7", 0.5],
  // piece letters vs each other / files
  ["n", "h", 0.4], ["r", "k", 0.5], ["q", "o", 0.45], ["b", "r", 0.55], ["k", "h", 0.45],
  ["n", "r", 0.5], ["q", "g", 0.4],
];

const CONFUSION_MAP = new Map<string, number>();
for (const [a, b, c] of CONFUSIONS) {
  CONFUSION_MAP.set(a + b, c);
  CONFUSION_MAP.set(b + a, c);
}

function subCost(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 0.15; // case slip, e.g. "nf3" for "Nf3"
  return CONFUSION_MAP.get(la + lb) ?? 1;
}

function indelCost(ch: string): number {
  if (ch === "x" || ch === ":" || ch === "-") return 0.12; // capture/dash marks are often omitted
  if (ch === "=") return 0.1;
  return 0.9;
}

/** Weighted edit distance with handwriting-aware substitution costs. */
export function handDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m * 0.9;
  if (m === 0) return n * 0.9;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  prev[0] = 0;
  for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + indelCost(b[j - 1]);
  for (let i = 1; i <= n; i++) {
    cur[0] = prev[0] + indelCost(a[i - 1]);
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(
        prev[j] + indelCost(a[i - 1]),
        cur[j - 1] + indelCost(b[j - 1]),
        prev[j - 1] + subCost(a[i - 1], b[j - 1]),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

const FIGURINES: Record<string, string> = {
  "♔": "K", "♚": "K", "♕": "Q", "♛": "Q", "♖": "R", "♜": "R",
  "♗": "B", "♝": "B", "♘": "N", "♞": "N", "♙": "", "♟": "",
};

/** Piece letters in other scoresheet languages, mapped to English. */
const LANGUAGE_PIECES: Record<string, Record<string, string>> = {
  german: { K: "K", D: "Q", T: "R", L: "B", S: "N" },
  french: { R: "K", D: "Q", T: "R", F: "B", C: "N" },
  spanish: { R: "K", D: "Q", T: "R", A: "B", C: "N" },
  dutch: { K: "K", D: "Q", T: "R", L: "B", P: "N" },
  italian: { R: "K", D: "Q", T: "R", A: "B", C: "N" },
  russian: { "Кр": "K", "Ф": "Q", "Л": "R", "С": "B", "К": "N" },
};

/** Basic cleanup of one handwritten reading. */
export function cleanReading(raw: string): string {
  let s = (raw ?? "").trim();
  for (const [fig, letter] of Object.entries(FIGURINES)) s = s.split(fig).join(letter);
  s = s.replace(/[!?+#‡†]/g, "").replace(/\s+/g, "");
  s = s.replace(/^\d+\.+/, ""); // stray move numbers like "12." or "12..."
  s = s.replace(/e\.?p\.?$/i, "");
  // castling written with zeros, O's, or dashes missing
  if (/^[0oO]-?[0oO]-?[0oO]$/.test(s)) return "O-O-O";
  if (/^[0oO]-?[0oO]$/.test(s)) return "O-O";
  s = s.replace(/[×:]/g, "x");
  return s;
}

/** Every plausible English reading of what was written, with a small cost for each translation. */
export function readingVariants(raw: string, language?: string): Array<{ text: string; cost: number }> {
  const base = cleanReading(raw);
  if (!base) return [];
  const out = new Map<string, number>();
  const add = (t: string, c: number) => {
    if (!t) return;
    const prev = out.get(t);
    if (prev === undefined || c < prev) out.set(t, c);
  };
  add(base, 0);
  const lang = (language ?? "").toLowerCase();
  for (const [name, table] of Object.entries(LANGUAGE_PIECES)) {
    const penalty = lang.includes(name) ? 0 : 0.35;
    for (const [foreign, eng] of Object.entries(table)) {
      if (base.startsWith(foreign) && foreign !== eng) add(eng + base.slice(foreign.length), penalty);
    }
  }
  return [...out.entries()].map(([text, cost]) => ({ text, cost }));
}

export interface MoveForms {
  san: string; // canonical SAN with check marks
  forms: string[]; // ways the same move might be written
}

interface VerboseMoveLike {
  san: string;
  from: string;
  to: string;
  piece: string;
  captured?: string;
  promotion?: string;
}

/** All the ways a player might reasonably write a given legal move. */
export function moveForms(m: VerboseMoveLike): MoveForms {
  const san = m.san;
  const bare = san.replace(/[+#]/g, "");
  const forms = new Set<string>([bare]);
  const P = m.piece === "p" ? "" : m.piece.toUpperCase();
  const promo = m.promotion ? m.promotion.toUpperCase() : "";
  if (bare.startsWith("O-O")) {
    forms.add(bare);
    // some players write castling as the king move
    forms.add(`K${m.to}`);
    forms.add(`K${m.from}${m.to}`);
  } else {
    // long algebraic: Ng1-f3, Ng1xf3, e2-e4, e2e4
    forms.add(`${P}${m.from}${m.captured ? "x" : "-"}${m.to}${promo}`);
    forms.add(`${P}${m.from}${m.to}${promo}`);
    if (m.piece === "p" && m.captured) {
      // pawn captures written short: "ed5", "ed", "exd"
      forms.add(`${m.from[0]}${m.to}${promo}`);
      forms.add(`${m.from[0]}x${m.to[0]}`);
      forms.add(`${m.from[0]}${m.to[0]}`);
    }
    if (promo) {
      forms.add(bare.replace("=", ""));
      forms.add(bare.replace("=", "/"));
    }
    // pieces sometimes written without disambiguation, or with it when not needed
    if (P) {
      forms.add(`${P}${m.captured ? "x" : ""}${m.to}`);
      forms.add(`${P}${m.to}`);
    }
  }
  return { san, forms: [...forms] };
}

/** How well a set of readings for one ply matches a legal move. Lower is better. */
export function matchCost(
  readings: Array<{ text: string; cost: number }>,
  forms: MoveForms,
): number {
  let best = Infinity;
  for (const r of readings) {
    for (const f of forms.forms) {
      const extra = f === forms.san.replace(/[+#]/g, "") ? 0 : 0.05;
      const d = handDistance(r.text, f) + r.cost + extra;
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}
