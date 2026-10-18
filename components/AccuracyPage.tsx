"use client";

import { useRef, useState } from "react";
import SiteHeader from "./SiteHeader";
import { decodeGame, type RawPly } from "@/lib/decoder";
import { cleanUpScan, pagesToPayload } from "@/lib/image-prep";
import { fetchRow, HSSSD_ROWS, scoreSheet, truthFromLabels, type SheetScore } from "@/lib/hsssd";
import { downloadBlob } from "@/lib/board-png";

interface Result {
  index: number;
  state: "running" | "done" | "skipped" | "error";
  note?: string;
  score?: SheetScore;
  seconds?: number;
  model?: string;
}

const SIZES = [3, 5, 10, 20];
const PARALLEL = 2;

export default function AccuracyPage() {
  const [size, setSize] = useState(5);
  const [cleanUp, setCleanUp] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  const update = (index: number, patch: Partial<Result>) =>
    setResults((rs) => rs.map((r) => (r.index === index ? { ...r, ...patch } : r)));

  async function testSheet(index: number): Promise<boolean> {
    setResults((rs) => [...rs, { index, state: "running", note: "Loading sheet…" }]);
    const t0 = Date.now();
    try {
      const row = await fetchRow(index);
      const truth = truthFromLabels(row.labels);
      if (!truth) {
        update(index, { state: "skipped", note: "This sheet's answer key isn't a clean legal game, so it can't be scored." });
        return false;
      }
      update(index, { note: "Downloading image…" });
      const blob = await (await fetch(row.imageUrl)).blob();
      const scale = Math.min(1, 2400 / Math.max(row.width, row.height));
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: Math.round(row.width * scale),
        resizeHeight: Math.round(row.height * scale),
        resizeQuality: "high",
      });
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      const images = pagesToPayload([cleanUp ? cleanUpScan(canvas) : canvas]);

      update(index, { note: "Reading handwriting…" });
      const res = await fetch("/api/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status}).`);
      const raw: RawPly[] = data.plies ?? [];
      const decoded = decodeGame(raw, { language: data.language || "German" }).plies;
      const score = scoreSheet(truth, raw, decoded);
      update(index, { state: "done", note: undefined, score, seconds: Math.round((Date.now() - t0) / 1000), model: data.model });
      return true;
    } catch (e) {
      update(index, { state: "error", note: e instanceof Error ? e.message : "Failed." });
      return false;
    }
  }

  const run = async () => {
    stopRef.current = false;
    setRunning(true);
    setResults([]);
    // random sheets, never the same one twice in a run
    const order = Array.from({ length: HSSSD_ROWS }, (_, i) => i).sort(() => Math.random() - 0.5);
    let next = 0;
    let scored = 0;
    const worker = async () => {
      while (!stopRef.current && scored < size && next < order.length) {
        const idx = order[next++];
        if (await testSheet(idx)) scored++;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setRunning(false);
  };

  const done = results.filter((r) => r.state === "done" && r.score);
  const total = done.reduce((n, r) => n + r.score!.total, 0);
  const aiOnly = done.reduce((n, r) => n + r.score!.aiOnly, 0);
  const withRules = done.reduce((n, r) => n + r.score!.withRules, 0);
  const perfect = done.filter((r) => r.score!.withRules === r.score!.total).length;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "–");

  const downloadCsv = () => {
    const lines = ["sheet,moves,ai_only_correct,with_rules_correct,seconds,model,first_mistakes"];
    for (const r of done) {
      const m = r.score!.mistakes.slice(0, 5).map((x) => `${x.label} ${x.truth}->${x.got}`).join("; ");
      lines.push([r.index, r.score!.total, r.score!.aiOnly, r.score!.withRules, r.seconds, r.model, `"${m}"`].join(","));
    }
    downloadBlob(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }), `accuracy-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  return (
    <div className="page">
      <SiteHeader current="accuracy" />
      <main className="tool-page">
        <section>
          <h1>How well does it read messy handwriting?</h1>
          <p className="lede">
            This test reads real tournament scoresheets from the public HSSSD dataset (228 sheets, mostly German notation, often
            hurried and messy) and compares every move with the known answer. Run it before and after training to see whether
            training helped.
          </p>
        </section>

        <section className="panel" aria-labelledby="run-h">
          <h2 id="run-h">Run the test</h2>
          <div className="row-actions">
            <label className="field" style={{ minWidth: 180 }}>
              <span>Number of sheets</span>
              <select value={size} onChange={(e) => setSize(Number(e.target.value))} disabled={running}>
                {SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} sheets
                  </option>
                ))}
              </select>
            </label>
            <label className="check" style={{ alignSelf: "flex-end", marginBottom: 8 }}>
              <input type="checkbox" checked={cleanUp} onChange={(e) => setCleanUp(e.target.checked)} disabled={running} />
              <span>Clean up scan first</span>
            </label>
          </div>
          <div className="row-actions">
            {!running ? (
              <button className="btn btn-primary" onClick={run}>
                Run test on {size} random sheets
              </button>
            ) : (
              <button className="btn" onClick={() => (stopRef.current = true)}>
                Stop after current sheets
              </button>
            )}
            {done.length > 0 && !running && (
              <button className="btn btn-quiet" onClick={downloadCsv}>
                Download results (CSV)
              </button>
            )}
          </div>
          <p className="muted">
            Each sheet takes about 20–60 seconds and uses a little of your OpenAI credit, like a normal scan. The dataset is used
            only for testing; nothing from it is stored or trained on.
          </p>
        </section>

        {results.length > 0 && (
          <section className="panel" aria-labelledby="res-h" aria-live="polite">
            <h2 id="res-h">Results</h2>
            {done.length > 0 && (
              <div className="big-stats">
                <div>
                  <strong>{pct(withRules, total)}</strong>
                  <span>moves correct, with the chess-rule checker</span>
                </div>
                <div>
                  <strong>{pct(aiOnly, total)}</strong>
                  <span>moves correct from the AI alone</span>
                </div>
                <div>
                  <strong>
                    {perfect}/{done.length}
                  </strong>
                  <span>sheets read perfectly</span>
                </div>
              </div>
            )}
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Sheet</th>
                    <th scope="col" className="num-cell">
                      Moves
                    </th>
                    <th scope="col" className="num-cell">
                      AI alone
                    </th>
                    <th scope="col" className="num-cell">
                      With rules
                    </th>
                    <th scope="col">Wrong moves (should be → was read as)</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.index}>
                      <td>#{r.index + 1}</td>
                      {r.score ? (
                        <>
                          <td className="num-cell">{r.score.total}</td>
                          <td className="num-cell">{pct(r.score.aiOnly, r.score.total)}</td>
                          <td className="num-cell">
                            <strong>{pct(r.score.withRules, r.score.total)}</strong>
                          </td>
                          <td>
                            {r.score.mistakes.length === 0 ? (
                              <span className="status-ok">None</span>
                            ) : (
                              <ul className="mistakes">
                                {r.score.mistakes.slice(0, 4).map((m, i) => (
                                  <li key={i}>
                                    {m.label} {m.truth} → {m.got}
                                  </li>
                                ))}
                                {r.score.mistakes.length > 4 && <li>and {r.score.mistakes.length - 4} more</li>}
                              </ul>
                            )}
                          </td>
                        </>
                      ) : (
                        <td colSpan={4} className={r.state === "error" ? "status-bad" : "muted"}>
                          {r.state === "skipped" ? "Skipped: " : ""}
                          {r.note}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Once one move is wrong, the chess-rule checker may pick different moves after it, so one misread can cost several
              moves. Fix it on the Scan page and the rest snap back.
            </p>
          </section>
        )}

        <p className="muted">
          Dataset: HSSSD by Benjamin Kost, from huggingface.co/datasets/BenjaminKost/HSSSD.
        </p>
      </main>
    </div>
  );
}
