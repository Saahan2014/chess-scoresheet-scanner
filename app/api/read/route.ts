import { NextResponse } from "next/server";
import { decodeGame, type RawPly } from "@/lib/decoder";
import { MissingKeyError, readSheet, TimeoutError, verifyMoves, type VerifyQuestion } from "@/lib/openai-read";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_IMAGES = 4;
const MAX_VERIFY = 12;
// Time budget, kept well inside maxDuration so the user always gets an answer.
const READ_TIMEOUT_MS = 170_000;
const VERIFY_TIMEOUT_MS = 50_000;
const SKIP_VERIFY_AFTER_MS = 120_000; // if the first read was slow, skip the second look

export async function POST(req: Request) {
  let images: string[];
  try {
    const body = await req.json();
    images = Array.isArray(body?.images) ? body.images : [];
  } catch {
    return NextResponse.json({ error: "Send JSON with an images array." }, { status: 400 });
  }
  images = images.filter((s) => typeof s === "string" && /^data:image\/(png|jpe?g|webp);base64,/.test(s));
  if (images.length === 0) return NextResponse.json({ error: "No image received. Add a photo, screenshot or PDF." }, { status: 400 });
  if (images.length > MAX_IMAGES) images = images.slice(0, MAX_IMAGES);

  const started = Date.now();
  try {
    const sheet = await readSheet(images, READ_TIMEOUT_MS);
    if (sheet.plies.length === 0) {
      return NextResponse.json(
        { error: "No moves found. Make sure the scoresheet fills most of the picture and is in focus." },
        { status: 422 },
      );
    }

    // Decode with chess rules, then ask the model to look again at the moves we're unsure about.
    const first = decodeGame(sheet.plies, { language: sheet.language });
    const doubtful = first.plies
      .filter((p) => p.status === "unsure" || (p.status === "fixed" && p.cost > 0.45))
      .slice(0, MAX_VERIFY);

    let raw: RawPly[] = sheet.plies;
    let verified = 0;
    if (doubtful.length > 0 && Date.now() - started < SKIP_VERIFY_AFTER_MS) {
      const questions: VerifyQuestion[] = doubtful.map((p) => ({
        ply: p.index,
        label: `${p.moveNumber}${p.color === "w" ? "." : "..."} (${p.color === "w" ? "White" : "Black"}'s move ${p.moveNumber})`,
        asWritten: p.asWritten,
        legal: p.legal,
      }));
      try {
        const choices = await verifyMoves(images, questions, VERIFY_TIMEOUT_MS);
        raw = sheet.plies.map((p) => ({ ...p, alternatives: [...(p.alternatives ?? [])] }));
        for (const c of choices) {
          const q = questions.find((x) => x.ply === c.ply);
          if (!q || !q.legal.includes(c.move)) continue;
          const ply = raw[c.ply];
          if (c.confident) {
            ply.alternatives = [ply.sanGuess ?? "", ...(ply.alternatives ?? [])].filter(Boolean);
            ply.sanGuess = c.move;
            if (ply.legibility === "illegible") ply.legibility = "unclear";
          } else {
            ply.alternatives = [c.move, ...(ply.alternatives ?? [])];
          }
          verified++;
        }
      } catch (e) {
        console.warn("verify pass failed", e);
      }
    }

    return NextResponse.json({
      white: sheet.white,
      black: sheet.black,
      event: sheet.event,
      date: sheet.date,
      round: sheet.round,
      result: sheet.result,
      language: sheet.language,
      model: sheet.model,
      plies: raw,
      verified,
    });
  } catch (e) {
    if (e instanceof MissingKeyError) {
      return NextResponse.json(
        { error: "The OpenAI API key isn't set up yet. Add OPENAI_API_KEY in Vercel → Settings → Environment Variables, then redeploy." },
        { status: 503 },
      );
    }
    if (e instanceof TimeoutError) {
      return NextResponse.json(
        { error: "OpenAI took too long to read this sheet. Try again, or crop the photo to just the move columns." },
        { status: 504 },
      );
    }
    const message = e instanceof Error ? e.message : "Reading failed";
    console.error("read failed", e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
