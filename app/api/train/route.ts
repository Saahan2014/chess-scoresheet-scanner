// Starts and tracks OpenAI fine-tuning jobs on your corrected scoresheets.
// Protected by TRAIN_PASSWORD so visitors to your site can't spend your OpenAI credit.
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

const OPENAI = "https://api.openai.com/v1";
/** The model OpenAI lets you fine-tune with images. Override with FT_BASE_MODEL. */
const BASE_MODEL = process.env.FT_BASE_MODEL || "gpt-4o-2024-08-06";

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function checkPassword(req: Request): NextResponse | null {
  const expected = process.env.TRAIN_PASSWORD;
  if (!expected) {
    return fail("Training is locked. Add TRAIN_PASSWORD in Vercel → Settings → Environment Variables, then redeploy.", 503);
  }
  const given = req.headers.get("x-train-password") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return fail("Wrong training password.", 401);
  if (!process.env.OPENAI_API_KEY) return fail("OPENAI_API_KEY isn't set in Vercel.", 503);
  return null;
}

async function openai(path: string, init: RequestInit = {}) {
  const res = await fetch(`${OPENAI}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...(init.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg: string = data?.error?.message ?? res.statusText;
    const noAccess = res.status === 403 || /fine-?tun\w* (is )?not (available|enabled)|not allowed|does not have access|permission/i.test(msg);
    const err = new Error(
      noAccess
        ? `Your OpenAI account can't use fine-tuning (OpenAI says: ${msg}). OpenAI has closed fine-tuning to new accounts.`
        : msg,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return data;
}

/** JSON actions: check, start, finish. */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const action = new URL(req.url).searchParams.get("action");

  try {
    // Upload one training example as a part of the file (raw text body keeps each request small).
    if (action === "part") {
      const uploadId = req.headers.get("x-upload-id");
      if (!uploadId) return fail("Missing upload id.");
      const text = await req.text();
      const form = new FormData();
      form.append("data", new Blob([text], { type: "text/plain" }), "part.jsonl");
      const part = await openai(`/uploads/${uploadId}/parts`, { method: "POST", body: form });
      return NextResponse.json({ partId: part.id });
    }

    const body = await req.json().catch(() => ({}));

    if (action === "check") {
      // Listing jobs is the cheapest way to find out whether fine-tuning is open to this account.
      await openai("/fine_tuning/jobs?limit=1");
      return NextResponse.json({ ok: true, baseModel: BASE_MODEL });
    }

    if (action === "start") {
      const bytes = Number(body.bytes);
      if (!Number.isFinite(bytes) || bytes <= 0) return fail("Nothing to upload.");
      const upload = await openai("/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "fine-tune", filename: "scoresheets.jsonl", bytes, mime_type: "text/jsonl" }),
      });
      return NextResponse.json({ uploadId: upload.id });
    }

    if (action === "finish") {
      const { uploadId, partIds } = body as { uploadId?: string; partIds?: string[] };
      if (!uploadId || !Array.isArray(partIds) || partIds.length === 0) return fail("Missing upload parts.");
      const done = await openai(`/uploads/${uploadId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ part_ids: partIds }),
      });
      const fileId = done?.file?.id;
      if (!fileId) return fail("OpenAI didn't finish receiving the file. Try again.", 502);
      const job = await openai("/fine_tuning/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ training_file: fileId, model: BASE_MODEL, suffix: "scoresheet" }),
      });
      return NextResponse.json({ jobId: job.id, status: job.status, baseModel: BASE_MODEL });
    }

    return fail("Unknown action.");
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message || "OpenAI request failed.", err.status && err.status < 500 ? err.status : 502);
  }
}

/** Job status: /api/train?job=ftjob-... (or no job to list recent ones). */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const jobId = new URL(req.url).searchParams.get("job");
  try {
    if (!jobId) {
      const list = await openai("/fine_tuning/jobs?limit=5");
      return NextResponse.json({
        jobs: (list.data ?? []).map((j: Record<string, unknown>) => ({
          id: j.id,
          status: j.status,
          model: j.model,
          fineTunedModel: j.fine_tuned_model,
          createdAt: j.created_at,
        })),
      });
    }
    const job = await openai(`/fine_tuning/jobs/${encodeURIComponent(jobId)}`);
    const events = await openai(`/fine_tuning/jobs/${encodeURIComponent(jobId)}/events?limit=6`).catch(() => ({ data: [] }));
    return NextResponse.json({
      id: job.id,
      status: job.status,
      fineTunedModel: job.fine_tuned_model,
      error: job.error?.message ?? null,
      trainedTokens: job.trained_tokens,
      events: (events.data ?? []).map((ev: { message: string; created_at: number }) => ({ message: ev.message, at: ev.created_at })),
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message || "OpenAI request failed.", err.status && err.status < 500 ? err.status : 502);
  }
}
