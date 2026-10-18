"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SiteHeader from "./SiteHeader";
import { deleteExample, importJsonl, listExamples, type TrainingExample } from "@/lib/training-store";
import { downloadBlob } from "@/lib/board-png";

const MIN_EXAMPLES = 10;
const JOB_KEY = "scoresheet-train-job";
const PW_KEY = "scoresheet-train-pw";

interface JobStatus {
  id: string;
  status: string;
  fineTunedModel: string | null;
  error: string | null;
  trainedTokens?: number | null;
  events: Array<{ message: string; at: number }>;
}

function readLocal(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable; the page still works for this visit
  }
}

export default function TrainPage() {
  const [examples, setExamples] = useState<TrainingExample[] | null>(null);
  const [password, setPassword] = useState("");
  const [rememberPw, setRememberPw] = useState(false);
  const [access, setAccess] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [jobId, setJobId] = useState("");
  const [copied, setCopied] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setExamples(await listExamples());
    } catch {
      setExamples([]);
      setError("This browser blocked local storage, so saved sheets can't be shown. Try another browser or turn off private browsing.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const pw = readLocal(PW_KEY);
    if (pw) {
      setPassword(pw);
      setRememberPw(true);
    }
    setJobId(readLocal(JOB_KEY));
  }, [refresh]);

  const headers = useCallback(
    (extra: Record<string, string> = {}) => ({ "x-train-password": password, ...extra }),
    [password],
  );

  const call = useCallback(
    async (url: string, init: RequestInit = {}) => {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status}).`);
      return data;
    },
    [],
  );

  const savePassword = () => writeLocal(PW_KEY, rememberPw ? password : null);

  const checkAccess = async () => {
    setError(null);
    setBusy("Checking your OpenAI account…");
    try {
      savePassword();
      const data = await call("/api/train?action=check", { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: "{}" });
      setAccess({ ok: true, message: `Your OpenAI account can train models. Training will use ${data.baseModel}.` });
    } catch (e) {
      setAccess({ ok: false, message: e instanceof Error ? e.message : "Check failed." });
    } finally {
      setBusy(null);
    }
  };

  const startTraining = async () => {
    if (!examples || examples.length < MIN_EXAMPLES) return;
    setError(null);
    savePassword();
    try {
      const enc = new TextEncoder();
      const parts = examples.map((e) => e.line.trim() + "\n");
      const bytes = parts.reduce((n, p) => n + enc.encode(p).length, 0);
      setBusy("Starting upload…");
      const { uploadId } = await call("/api/train?action=start", {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ bytes }),
      });
      const partIds: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        setBusy(`Uploading sheet ${i + 1} of ${parts.length}…`);
        const { partId } = await call("/api/train?action=part", {
          method: "POST",
          headers: headers({ "Content-Type": "text/plain", "x-upload-id": uploadId }),
          body: parts[i],
        });
        partIds.push(partId);
      }
      setBusy("Starting training…");
      const started = await call("/api/train?action=finish", {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ uploadId, partIds }),
      });
      setJobId(started.jobId);
      writeLocal(JOB_KEY, started.jobId);
      setJob({ id: started.jobId, status: started.status, fineTunedModel: null, error: null, events: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Training couldn't start.");
    } finally {
      setBusy(null);
    }
  };

  // follow the job until it finishes
  useEffect(() => {
    if (!jobId || !password) return;
    let stop = false;
    const poll = async () => {
      try {
        const data: JobStatus = await call(`/api/train?job=${encodeURIComponent(jobId)}`, { headers: headers() });
        if (stop) return;
        setJob(data);
        if (["succeeded", "failed", "cancelled"].includes(data.status)) return;
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Couldn't check training status.");
        return;
      }
      if (!stop) timer = setTimeout(poll, 20_000);
    };
    let timer = setTimeout(poll, 500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId, password, call, headers]);

  const onImport = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    let added = 0;
    for (const f of Array.from(files)) added += await importJsonl(await f.text(), f.name.replace(/\.jsonl$/i, ""));
    await refresh();
    if (added === 0) setError("Those files didn't contain any training sheets.");
  };

  const exportAll = () => {
    if (!examples?.length) return;
    const text = examples.map((e) => e.line.trim()).join("\n") + "\n";
    downloadBlob(new Blob([text], { type: "application/jsonl" }), `scoresheet-training-${examples.length}.jsonl`);
  };

  const remove = async (id: string) => {
    await deleteExample(id);
    refresh();
  };

  const copyModel = async () => {
    if (!job?.fineTunedModel) return;
    await navigator.clipboard.writeText(job.fineTunedModel);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const count = examples?.length ?? 0;
  const finished = job && ["succeeded", "failed", "cancelled"].includes(job.status);

  return (
    <div className="page">
      <SiteHeader current="train" />
      <main className="tool-page">
        <section>
          <h1>Train the AI on messy handwriting</h1>
          <p className="lede">
            Every scoresheet you correct and save teaches by example: the handwriting as written, and the legal moves it really
            meant. Train on {MIN_EXAMPLES} or more and the AI learns those scrawls, then the chess-rule checker cleans up whatever is
            left.
          </p>
        </section>

        <section className="panel" aria-labelledby="sheets-h">
          <h2 id="sheets-h">Your training sheets</h2>
          {examples === null ? (
            <p className="muted">Loading…</p>
          ) : count === 0 ? (
            <p>
              None yet. Scan a sheet on the <a href="/">Scan</a> page, fix any yellow moves, then click <strong>Save for training</strong>.
              The messiest sheets teach the most.
            </p>
          ) : (
            <>
              <p>
                <strong>{count}</strong> saved in this browser.{" "}
                {count < MIN_EXAMPLES
                  ? `Save ${MIN_EXAMPLES - count} more to train. 50 or more gives clearly better results.`
                  : count < 50
                    ? "Enough to train. 50 or more gives clearly better results."
                    : "A solid training set."}
              </p>
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (count / 50) * 100)}%` }} />
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Game</th>
                      <th scope="col" className="num-cell">
                        Half-moves
                      </th>
                      <th scope="col">Saved</th>
                      <th scope="col">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {examples.map((e) => (
                      <tr key={e.id}>
                        <td>{e.title}</td>
                        <td className="num-cell">{e.plies}</td>
                        <td>{new Date(e.savedAt).toLocaleDateString()}</td>
                        <td className="num-cell">
                          <button className="link" onClick={() => remove(e.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="row-actions">
            <button className="btn" onClick={() => importInput.current?.click()}>
              Import .jsonl files
            </button>
            {count > 0 && (
              <button className="btn btn-quiet" onClick={exportAll}>
                Download all as one file
              </button>
            )}
            <input
              ref={importInput}
              type="file"
              accept=".jsonl,application/jsonl,application/json,text/plain"
              multiple
              hidden
              onChange={(e) => {
                onImport(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <p className="muted">Sheets are stored only in this browser until you start training. Use the download to move them to another device.</p>
        </section>

        <section className="panel" aria-labelledby="train-h">
          <h2 id="train-h">Train</h2>
          <ol className="steps">
            <li>
              In Vercel, add an environment variable <span className="code-chip">TRAIN_PASSWORD</span> with any password you choose,
              then redeploy. This stops visitors to your site from spending your OpenAI credit.
            </li>
            <li>Enter that password here and check that your OpenAI account can train models.</li>
            <li>Start training. OpenAI charges for training by the amount of data; a few dozen sheets usually costs a few dollars.</li>
          </ol>
          <div className="row-actions">
            <label className="field grow" style={{ maxWidth: 320 }}>
              <span>Training password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <label className="check" style={{ alignSelf: "flex-end", marginBottom: 8 }}>
              <input type="checkbox" checked={rememberPw} onChange={(e) => setRememberPw(e.target.checked)} />
              <span>Remember on this device</span>
            </label>
          </div>
          <div className="row-actions">
            <button className="btn" onClick={checkAccess} disabled={!password || Boolean(busy)}>
              Check OpenAI access
            </button>
            <button
              className="btn btn-primary"
              onClick={startTraining}
              disabled={!password || count < MIN_EXAMPLES || Boolean(busy) || (Boolean(job) && !finished)}
            >
              Start training on {count} sheet{count === 1 ? "" : "s"}
            </button>
          </div>
          {busy && <p aria-live="polite">{busy}</p>}
          {access && (
            <p className={access.ok ? "status-ok" : "status-bad"} role="status">
              {access.message}
            </p>
          )}
          {access && !access.ok && (
            <p className="muted">
              Without fine-tuning access, you can still download your sheets as one file and keep them; they&apos;ll work with any
              training service that accepts OpenAI-format data. The chess-rule checker keeps improving readings either way.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        {(job || jobId) && (
          <section className="panel" aria-labelledby="job-h" aria-live="polite">
            <h2 id="job-h">Training progress</h2>
            {!job ? (
              <p className="muted">{password ? "Checking…" : "Enter your training password above to see progress."}</p>
            ) : (
              <>
                <p>
                  Status: <strong>{statusLabel(job.status)}</strong>
                  {job.trainedTokens ? ` · ${job.trainedTokens.toLocaleString()} tokens trained` : ""}
                </p>
                {job.status === "succeeded" && job.fineTunedModel && (
                  <>
                    <p>Your trained model is ready:</p>
                    <div className="row-actions">
                      <span className="code-chip">{job.fineTunedModel}</span>
                      <button className="btn" onClick={copyModel}>
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <ol className="steps">
                      <li>
                        In Vercel, open your project, then <strong>Settings → Environment Variables</strong>.
                      </li>
                      <li>
                        Add <span className="code-chip">OPENAI_MODEL</span> with the model name above as its value, and save.
                      </li>
                      <li>
                        Go to <strong>Deployments</strong>, open the menu on the latest one and choose <strong>Redeploy</strong>. From
                        then on, every scan uses your trained model.
                      </li>
                    </ol>
                  </>
                )}
                {job.error && <p className="status-bad">{job.error}</p>}
                {job.events.length > 0 && (
                  <ul className="mistakes">
                    {job.events.map((ev, i) => (
                      <li key={i}>
                        {new Date(ev.at * 1000).toLocaleTimeString()} — {ev.message}
                      </li>
                    ))}
                  </ul>
                )}
                {!finished && <p className="muted">Training usually takes 20 minutes to a few hours. You can close this page and come back.</p>}
              </>
            )}
            {finished && (
              <button
                className="btn btn-quiet"
                onClick={() => {
                  writeLocal(JOB_KEY, null);
                  setJobId("");
                  setJob(null);
                }}
              >
                Clear
              </button>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function statusLabel(s: string) {
  return (
    {
      validating_files: "Checking your data",
      queued: "Waiting in line at OpenAI",
      running: "Training",
      succeeded: "Done",
      failed: "Failed",
      cancelled: "Cancelled",
    }[s] ?? s
  );
}
