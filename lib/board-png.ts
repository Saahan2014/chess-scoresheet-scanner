// Draws a position onto a canvas and exports it as a PNG.

export interface BoardTheme {
  light: string;
  dark: string;
  highlight: string;
  frame: string;
  caption: string;
}

export const THEMES: Record<string, BoardTheme> = {
  club: { light: "#EEEED2", dark: "#769656", highlight: "rgba(246, 223, 70, 0.62)", frame: "#FFFFFF", caption: "#1C2433" },
  wood: { light: "#F0D9B5", dark: "#B58863", highlight: "rgba(205, 210, 106, 0.75)", frame: "#FFFFFF", caption: "#2B2118" },
  ink: { light: "#E6EBF4", dark: "#7D90B8", highlight: "rgba(255, 214, 102, 0.7)", frame: "#FFFFFF", caption: "#14213D" },
  print: { light: "#FFFFFF", dark: "#B9B9B9", highlight: "rgba(0, 0, 0, 0.14)", frame: "#FFFFFF", caption: "#000000" },
};

export interface RenderOptions {
  fen: string;
  size: number; // board edge in px
  flip?: boolean;
  coordinates?: boolean;
  lastMove?: { from: string; to: string } | null;
  theme?: keyof typeof THEMES;
  caption?: string[]; // lines drawn under the board
}

const PIECE_CODES = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];
let piecesPromise: Promise<Record<string, HTMLImageElement>> | null = null;

export function loadPieces(): Promise<Record<string, HTMLImageElement>> {
  if (!piecesPromise) {
    piecesPromise = Promise.all(
      PIECE_CODES.map(
        (code) =>
          new Promise<[string, HTMLImageElement]>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve([code, img]);
            img.onerror = () => reject(new Error(`Couldn't load piece ${code}`));
            img.src = `/pieces/${code}.svg`;
          }),
      ),
    ).then((pairs) => Object.fromEntries(pairs));
  }
  return piecesPromise;
}

function parseBoard(fen: string): (string | null)[][] {
  const rows = fen.split(" ")[0].split("/");
  return rows.map((row) => {
    const out: (string | null)[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let k = 0; k < Number(ch); k++) out.push(null);
      else out.push((ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase());
    }
    return out;
  });
}

function squareXY(sq: string, flip: boolean) {
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]) - 1;
  return flip ? { col: 7 - file, row: rank } : { col: file, row: 7 - rank };
}

function findKingInCheck(fen: string, inCheck: boolean): string | null {
  if (!inCheck) return null;
  const turn = fen.split(" ")[1];
  const board = parseBoard(fen);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) if (board[r][c] === `${turn}K`) return String.fromCharCode(97 + c) + (8 - r);
  return null;
}

export async function renderBoard(canvas: HTMLCanvasElement, opts: RenderOptions & { inCheck?: boolean }) {
  const pieces = await loadPieces();
  const theme = THEMES[opts.theme ?? "club"];
  const size = Math.round(opts.size);
  const sq = size / 8;
  const pad = Math.round(size * 0.04);
  const captionLines = (opts.caption ?? []).filter(Boolean);
  const captionSize = Math.max(12, Math.round(size * 0.034));
  const captionH = captionLines.length ? Math.round(captionLines.length * captionSize * 1.45 + pad * 0.6) : 0;

  canvas.width = size + pad * 2;
  canvas.height = size + pad * 2 + captionH;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = theme.frame;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(pad, pad);

  const flip = Boolean(opts.flip);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? theme.light : theme.dark;
      ctx.fillRect(c * sq, r * sq, Math.ceil(sq), Math.ceil(sq));
    }

  if (opts.lastMove) {
    ctx.fillStyle = theme.highlight;
    for (const s of [opts.lastMove.from, opts.lastMove.to]) {
      const { col, row } = squareXY(s, flip);
      ctx.fillRect(col * sq, row * sq, Math.ceil(sq), Math.ceil(sq));
    }
  }

  const checked = findKingInCheck(opts.fen, Boolean(opts.inCheck));
  if (checked) {
    const { col, row } = squareXY(checked, flip);
    const cx = col * sq + sq / 2;
    const cy = row * sq + sq / 2;
    const g = ctx.createRadialGradient(cx, cy, sq * 0.1, cx, cy, sq * 0.62);
    g.addColorStop(0, "rgba(220, 30, 30, 0.95)");
    g.addColorStop(0.55, "rgba(220, 30, 30, 0.35)");
    g.addColorStop(1, "rgba(220, 30, 30, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(col * sq, row * sq, sq, sq);
  }

  if (opts.coordinates !== false) {
    ctx.font = `600 ${Math.round(sq * 0.18)}px "Instrument Sans Variable", system-ui, sans-serif`;
    for (let i = 0; i < 8; i++) {
      const fileChar = String.fromCharCode(97 + (flip ? 7 - i : i));
      const rankChar = String(flip ? i + 1 : 8 - i);
      // files along the bottom edge
      ctx.fillStyle = (7 + i) % 2 === 0 ? theme.dark : theme.light;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(fileChar, (i + 1) * sq - sq * 0.06, size - sq * 0.04);
      // ranks along the left edge
      ctx.fillStyle = i % 2 === 0 ? theme.dark : theme.light;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(rankChar, sq * 0.06, i * sq + sq * 0.05);
    }
  }

  const board = parseBoard(opts.fen);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const row = flip ? 7 - r : r;
      const col = flip ? 7 - c : c;
      ctx.drawImage(pieces[p], col * sq, row * sq, sq, sq);
    }
  ctx.restore();

  if (captionLines.length) {
    ctx.fillStyle = theme.caption;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    captionLines.forEach((line, i) => {
      ctx.font = `${i === 0 ? 650 : 450} ${captionSize}px "Instrument Sans Variable", system-ui, sans-serif`;
      ctx.fillText(line, pad, size + pad + pad * 0.6 + i * captionSize * 1.45, size);
    });
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't create PNG"))), "image/png"),
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
