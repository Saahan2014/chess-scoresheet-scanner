# Scoresheet Scanner

Turn a handwritten chess scoresheet into a game: take a photo, scan a PDF or paste a screenshot, and get every position as a PNG, plus the PGN.

## How it reads bad handwriting

1. **Image cleanup (in your browser).** Phone photos get shadow removal and contrast boosting so faint pencil stands out. PDFs from scanner apps are rendered page by page. Screenshots are sent as they are.
2. **AI reading.** An OpenAI vision model transcribes each move exactly as written, gives its best guess in standard notation, and lists other possible readings when a character is ambiguous (1/7, 3/8, 5/6, g/9, a/d, c/e …). It understands German, French, Spanish, Dutch, Italian and Russian piece letters and figurines.
3. **Chess-rule decoding.** A search over the whole game finds the sequence of *legal* moves that best matches the handwriting, using costs tuned to common handwriting confusions. A scrawled `Bc7` that isn't legal becomes `Bc4`, a smudged-out move is filled in by what the next moves require, and `Nd7` becomes `Nbd7` when two knights could go there.
4. **Second look.** Moves that are still doubtful go back to the model with the list of legal moves in that position, so it can look at the cell again and choose.
5. **You review.** Corrected moves are underlined in red, unsure ones are highlighted in yellow. Click any move to pick a different legal move; everything after it is rechecked.

## Training it on your handwriting

The decoding above works without any training. To make the AI itself better at a particular person's (or club's) handwriting, fine-tune it:

1. Read a sheet, fix any mistakes, then click **Save as training example**. Each click downloads one `.jsonl` file.
2. Collect at least 10 (50+ works much better) in a folder, e.g. `training/`.
3. Run `OPENAI_API_KEY=sk-... npm run fine-tune -- ./training`. It uploads the examples, starts an OpenAI vision fine-tuning job and prints the new model id when finished.
4. In Vercel, set `OPENAI_MODEL` to that id and redeploy.

## Setup

Environment variables (Vercel → Project → Settings → Environment Variables):

| Name | Required | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Your OpenAI API key |
| `OPENAI_MODEL` | no | Model that reads the sheets. Defaults to `gpt-6.1-sol` and falls back to other models automatically if that one isn't available on your account. |

Run locally:

```bash
npm install
cp .env.example .env.local   # then add your key
npm run dev
```

Tests for the move decoder: `npm test`.

## Credits

Chess pieces: "cburnett" set by Colin M.L. Burnett, CC BY-SA 3.0.
