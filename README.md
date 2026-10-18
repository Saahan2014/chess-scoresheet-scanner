# Scoresheet Scanner

Turn a handwritten chess scoresheet into a game: take a photo, scan a PDF or paste a screenshot, and get every position as a PNG, plus the PGN.

## How it reads bad handwriting

1. **Image cleanup (in your browser).** Phone photos get shadow removal and contrast boosting so faint pencil stands out. PDFs from scanner apps are rendered page by page. Screenshots are sent as they are.
2. **AI reading.** An OpenAI vision model transcribes each move exactly as written, gives its best guess in standard notation, and lists other possible readings when a character is ambiguous (1/7, 3/8, 5/6, g/9, a/d, c/e …). It understands German, French, Spanish, Dutch, Italian and Russian piece letters and figurines.
3. **Chess-rule decoding.** A search over the whole game finds the sequence of *legal* moves that best matches the handwriting, using costs tuned to common handwriting confusions. A scrawled `Bc7` that isn't legal becomes `Bc4`, a smudged-out move is filled in by what the next moves require, and `Nd7` becomes `Nbd7` when two knights could go there.
4. **Second look.** Moves that are still doubtful go back to the model with the list of legal moves in that position, so it can look at the cell again and choose.
5. **You review.** Corrected moves are underlined in red, unsure ones are highlighted in yellow. Click any move to pick a different legal move; everything after it is rechecked.

## Training it on messy handwriting

The chess-rule decoding works without any training. To make the AI itself better at reading messy handwriting, train it on sheets you've corrected:

1. On the **Scan** page, read a sheet, fix any yellow moves, then click **Save for training**. Sheets are kept in your browser.
2. In Vercel, add an environment variable `TRAIN_PASSWORD` (any password you choose) and redeploy. It stops visitors from spending your OpenAI credit.
3. On the **Train** page, enter the password, click **Check OpenAI access**, then **Start training** (10 sheets minimum; 50+ is much better).
4. When training finishes, the page shows your new model's name. Set `OPENAI_MODEL` to it in Vercel and redeploy.

Training uses OpenAI fine-tuning on `gpt-4o-2024-08-06`, the model OpenAI can train on images. OpenAI has closed fine-tuning to new accounts, so the Check button tells you whether yours can use it.

## Measuring accuracy

The **Accuracy test** page reads random sheets from the public [HSSSD dataset](https://huggingface.co/datasets/BenjaminKost/HSSSD) (228 real tournament scoresheets) and reports how many moves were read correctly, with and without the chess-rule checker. Run it before and after training to compare.

## Setup

Environment variables (Vercel → Project → Settings → Environment Variables):

| Name | Required | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Your OpenAI API key |
| `OPENAI_MODEL` | no | Model that reads the sheets. Defaults to `gpt-6.1-sol` and falls back to other models automatically if that one isn't available on your account. Set it to your trained model's name after training. |
| `TRAIN_PASSWORD` | for training | Password for the Train page |
| `FT_BASE_MODEL` | no | Model to fine-tune. Defaults to `gpt-4o-2024-08-06` |

Run locally:

```bash
npm install
cp .env.example .env.local   # then add your key
npm run dev
```

Tests for the move decoder: `npm test`.

## Credits

Chess pieces: "cburnett" set by Colin M.L. Burnett, CC BY-SA 3.0.
