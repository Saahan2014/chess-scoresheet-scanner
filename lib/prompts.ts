// Shared between the server (reading) and the browser (training-data export).

export const READ_INSTRUCTIONS = `You are a chess arbiter who transcribes handwritten tournament scoresheets.

Read the moves in game order: 1. White, 1... Black, 2. White, and so on. Scoresheets often
have two blocks of columns (moves 1-30 or 1-40 on the left, the rest on the right) and may
span a second page; follow the move numbers, not the visual layout.

For every half-move give:
- as_written: exactly the characters you see, even if they look wrong (keep the player's language and symbols).
- san_guess: your best reading as standard English algebraic notation (K Q R B N; e.g. Nf3, exd5, O-O, e8=Q).
  Translate other languages (German S/L/T/D, French C/F/T/D/R, Spanish C/A/T/D/R, figurines).
- alternatives: up to 4 other plausible readings in English SAN when any character is ambiguous
  (common confusions: 1/7, 3/8, 5/6, 4/9, a/d, c/e, b/h/6, g/9/q). Empty list if certain.
- legibility: "clear", "unclear", or "illegible" (crossed out, smudged, empty but clearly a move was played).

Rules:
- If a cell has a crossed-out move and a replacement, use the replacement.
- Do not invent moves after the last written move. Do not skip cells: if a move is unreadable, still emit it as illegible.
- Ignore clock times, draw-offer marks (=) next to moves, and scribbles outside the move cells.
- Fill in header fields if visible (players, event, date, round, result such as 1-0, 0-1, 1/2-1/2); otherwise empty string.`;

export const READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["white", "black", "event", "date", "round", "result", "language", "plies"],
  properties: {
    white: { type: "string" },
    black: { type: "string" },
    event: { type: "string" },
    date: { type: "string" },
    round: { type: "string" },
    result: { type: "string" },
    language: { type: "string", description: "Language/notation of the scoresheet, e.g. English, German" },
    plies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["move_number", "side", "as_written", "san_guess", "alternatives", "legibility"],
        properties: {
          move_number: { type: "integer" },
          side: { type: "string", enum: ["white", "black"] },
          as_written: { type: "string" },
          san_guess: { type: "string" },
          alternatives: { type: "array", items: { type: "string" } },
          legibility: { type: "string", enum: ["clear", "unclear", "illegible"] },
        },
      },
    },
  },
} as const;

