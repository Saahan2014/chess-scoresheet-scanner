#!/usr/bin/env node
// Train an OpenAI vision model on your own scoresheets.
//
// 1. On the website, after checking a game's moves, click "Save as training example".
//    Put the downloaded .jsonl files in one folder (aim for 10+; 50+ is much better).
// 2. Run:  OPENAI_API_KEY=sk-... npm run fine-tune -- ./training
// 3. When the job finishes, set OPENAI_MODEL in Vercel to the model id it prints, and redeploy.
//
// Optional: FT_BASE_MODEL picks the model to fine-tune (must support vision fine-tuning).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const key = process.env.OPENAI_API_KEY;
const base = process.env.FT_BASE_MODEL || "gpt-4.1-2025-04-14";
if (!dir || !key) {
  console.error("Usage: OPENAI_API_KEY=sk-... npm run fine-tune -- <folder-with-jsonl-files>");
  process.exit(1);
}

const lines = readdirSync(dir)
  .filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()));
if (lines.length < 10) {
  console.error(`Found ${lines.length} examples. OpenAI needs at least 10 to fine-tune.`);
  process.exit(1);
}
console.log(`Uploading ${lines.length} examples…`);

const api = (path, init = {}) =>
  fetch(`https://api.openai.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) },
  }).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error?.message || r.statusText);
    return body;
  });

const form = new FormData();
form.append("purpose", "fine-tune");
form.append("file", new Blob([lines.join("\n") + "\n"], { type: "application/jsonl" }), "scoresheets.jsonl");
const file = await api("/files", { method: "POST", body: form });

const job = await api("/fine_tuning/jobs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ training_file: file.id, model: base, suffix: "scoresheet" }),
});
console.log(`Fine-tuning job ${job.id} started on ${base}. Checking every minute…`);

for (;;) {
  await new Promise((r) => setTimeout(r, 60_000));
  const j = await api(`/fine_tuning/jobs/${job.id}`);
  console.log(new Date().toLocaleTimeString(), j.status);
  if (j.status === "succeeded") {
    console.log(`\nDone! Set OPENAI_MODEL=${j.fine_tuned_model} in Vercel and redeploy.`);
    break;
  }
  if (j.status === "failed" || j.status === "cancelled") {
    console.error(j.error?.message || "Job did not finish.");
    process.exit(1);
  }
}
