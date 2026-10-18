"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import CameraCapture from "./CameraCapture";
import { decodeGame, normalizeResult, toPgn, type DecodeResult, type DecodedPly, type RawPly } from "@/lib/decoder";
import {
  canvasToPage,
  captureScreenFrame,
  cleanUpScan,
  fileToPages,
  pagesToPayload,
  rotateCanvas,
  type PageImage,
} from "@/lib/image-prep";
import { canvasToBlob, downloadBlob, renderBoard, THEMES } from "@/lib/board-png";
import { buildTrainingExample, type HeaderInfo } from "@/lib/training";
import { SAMPLE } from "@/lib/sample";

type Phase = "idle" | "reading" | "done";
type ThemeName = keyof typeof THEMES;

const SIZES = [
  { label: "Small · 480 px", value: 480 },
  { label: "Medium · 800 px", value: 800 },
  { label: "Large · 1200 px", value: 1200 },
  { label: "Print · 2000 px", value: 2000 },
];

const EMPTY_HEADERS: HeaderInfo = { white: "", black: "", event: "", date: "", round: "", result: "", language: "" };

export default function ScoresheetApp() {
  const [pages, setPages] = useState<PageImage[]>([]);
  const [cleanUp, setCleanUp] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const [raw, setRaw] = useState<RawPly[] | null>(null);
  const [headers, setHeaders] = useState<HeaderInfo>(EMPTY_HEADERS);
  const [modelInfo, setModelInfo] = useState<{ model: string; verified: number } | null>(null);
  const [sentImages, setSentImages] = useState<string[]>([]);
  const [pinned, setPinned] = useState<Record<number, string>>({});
  const [decoded, setDecoded] = useState<DecodeResult | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [cur, setCur] = useState(-1); // -1 = starting position

  const [size, setSize] = useState(800);
  const [theme, setTheme] = useState<ThemeName>("club");
  const [flip, setFlip] = useState(false);
  const [coords, setCoords] = useState(true);
  const [caption, setCaption] = useState(true);

  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const boardCanvas = useRef<HTMLCanvasElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // screen capture only exists in desktop browsers; check after mount so server and client HTML match
  const [canCaptureScreen, setCanCaptureScreen] = useState(false);
  useEffect(() => {
    const touch = window.matchMedia("(pointer: coarse)").matches;
    setCanCaptureScreen(!touch && Boolean(navigator.mediaDevices?.getDisplayMedia));
  }, []);

  // ---------- adding pages ----------
  const addFiles = useCallback(async (files: File[] | FileList, source: PageImage["source"] = "photo") => {
    setError(null);
    const list = Array.from(files);
    if (list.length === 0) return;
    try {
      const added: PageImage[] = [];
      for (const f of list) added.push(...(await fileToPages(f, source)));
      setPages((p) => [...p, ...added].slice(0, 4));
      if (added.every((a) => a.source === "screenshot" || a.source === "pdf")) setCleanUp(false);
      else setCleanUp(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open that file.");
    }
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        addFiles(files, "screenshot");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) files.push(new File([await item.getType(type)], "Pasted screenshot.png", { type }));
      }
      if (files.length) addFiles(files, "screenshot");
      else setError("There's no image on your clipboard. Take a screenshot first, then paste.");
    } catch {
      setError("Your browser blocked clipboard access. Press Ctrl+V (or ⌘V) on this page instead.");
    }
  };

  const captureScreen = async () => {
    setError(null);
    try {
      const canvas = await captureScreenFrame();
      setPages((p) => [...p, canvasToPage(canvas, "screenshot", "Screen capture")].slice(0, 4));
      setCleanUp(false);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) setError("Screen capture didn't work in this browser. Take a screenshot and paste it instead.");
    }
  };

  const openCamera = () => {
    const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    if (touch) cameraInput.current?.click(); // phones: native camera app, best quality
    else setCameraOpen(true);
  };

  const rotatePage = (id: string) =>
    setPages((p) => p.map((pg) => (pg.id === id ? { ...pg, canvas: rotateCanvas(pg.canvas, 1) } : pg)));
  const removePage = (id: string) => setPages((p) => p.filter((pg) => pg.id !== id));
  const movePage = (id: string, dir: -1 | 1) =>
    setPages((p) => {
      const i = p.findIndex((pg) => pg.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.length) return p;
      const copy = [...p];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  // ---------- reading ----------
  useEffect(() => {
    if (phase !== "reading") return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  const read = async () => {
    if (pages.length === 0) return;
    setError(null);
    setNotice(null);
    setPhase("reading");
    setElapsed(0);
    try {
      const canvases = pages.map((p) => (cleanUp ? cleanUpScan(p.canvas) : p.canvas));
      const images = pagesToPayload(canvases);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 290_000);
      let res: Response;
      try {
        res = await fetch("/api/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images }),
          signal: controller.signal,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError")
          throw new Error("Reading took too long and was stopped. Try again, or crop the photo to just the move columns.");
        throw new Error("Couldn't reach the server. Check your internet connection and try again.");
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json().catch(() => ({
        error:
          res.status === 504
            ? "The server ran out of time reading this sheet. Try again, or crop the photo to just the move columns."
            : `Server error (${res.status}). Try again in a moment.`,
      }));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status}).`);
      setSentImages(images);
      loadReading(data, { model: data.model, verified: data.verified ?? 0 });
    } catch (e) {
      setPhase("idle");
      setError(e instanceof Error ? e.message : "Reading failed. Try again.");
    }
  };

  const loadReading = (
    data: { plies: RawPly[] } & Partial<HeaderInfo>,
    info: { model: string; verified: number } | null,
  ) => {
    setRaw(data.plies);
    setHeaders({
      white: data.white ?? "",
      black: data.black ?? "",
      event: data.event ?? "",
      date: data.date ?? "",
      round: data.round ?? "",
      result: data.result ?? "",
      language: data.language ?? "",
    });
    setModelInfo(info);
    setPinned({});
    setDecoded(null);
    setPhase("done");
  };

  const trySample = () => {
    setSentImages([]);
    setPages([]);
    setError(null);
    loadReading(SAMPLE, null);
  };

  // decode whenever the reading or the user's corrections change
  useEffect(() => {
    if (!raw) return;
    setDecoding(true);
    const t = setTimeout(() => {
      const result = decodeGame(raw, { language: headers.language, pinned });
      setDecoded(result);
      setDecoding(false);
      setCur((c) => (c >= result.plies.length ? result.plies.length - 1 : c));
    }, 20);
    return () => clearTimeout(t);
    // headers.language only matters for the initial decode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, pinned]);

  // jump to the final position on a fresh result
  const firstDecode = useRef(true);
  useEffect(() => {
    if (!decoded) {
      firstDecode.current = true;
      return;
    }
    if (firstDecode.current) {
      firstDecode.current = false;
      setCur(decoded.plies.length - 1);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }, [decoded]);

  const plies = decoded?.plies ?? [];
  const current: DecodedPly | null = cur >= 0 ? plies[cur] ?? null : null;
  const fen = current?.fenAfter ?? new Chess().fen();
  const inCheck = useMemo(() => {
    try {
      return new Chess(fen).inCheck();
    } catch {
      return false;
    }
  }, [fen]);

  const counts = useMemo(() => {
    const c = { read: 0, fixed: 0, unsure: 0, set: 0 };
    for (const p of plies) c[p.status]++;
    return c;
  }, [plies]);

  const nextToCheck = useMemo(() => {
    const after = plies.findIndex((p, i) => i > cur && p.status === "unsure");
    return after >= 0 ? after : plies.findIndex((p) => p.status === "unsure");
  }, [plies, cur]);

  // ---------- keyboard navigation ----------
  useEffect(() => {
    if (phase !== "done") return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") setCur((c) => Math.max(-1, c - 1));
      else if (e.key === "ArrowRight") setCur((c) => Math.min(plies.length - 1, c + 1));
      else if (e.key === "Home") setCur(-1);
      else if (e.key === "End") setCur(plies.length - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, plies.length]);

  // ---------- board image ----------
  const captionLines = useMemo(() => {
    if (!caption) return [];
    const names = [headers.white, headers.black].every(Boolean) ? `${headers.white} – ${headers.black}` : headers.white || headers.black;
    const where = [headers.event, headers.date].filter(Boolean).join(", ");
    const pos = current
      ? `Position after ${current.moveNumber}${current.color === "w" ? "." : "..."} ${current.san}`
      : "Starting position";
    return [names || pos, names ? [pos, where].filter(Boolean).join("  —  ") : where].filter(Boolean);
  }, [caption, headers, current]);

  const renderOpts = useMemo(
    () => ({
      fen,
      flip,
      coordinates: coords,
      lastMove: current ? { from: current.from, to: current.to } : null,
      theme,
      caption: captionLines,
      inCheck,
    }),
    [fen, flip, coords, current, theme, captionLines, inCheck],
  );

  useEffect(() => {
    if (phase !== "done" || !boardCanvas.current) return;
    renderBoard(boardCanvas.current, { ...renderOpts, size: 640 });
  }, [renderOpts, phase]);

  const fileBase = () => {
    const names = [headers.white, headers.black].filter(Boolean).join("-vs-") || "game";
    const pos = current ? `move-${current.moveNumber}${current.color === "w" ? "w" : "b"}` : "start";
    return `${names}-${pos}`.replace(/[^\w.-]+/g, "_").slice(0, 80);
  };

  const makePng = async () => {
    const c = document.createElement("canvas");
    await renderBoard(c, { ...renderOpts, size });
    return canvasToBlob(c);
  };

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2600);
  };

  const downloadPng = async () => {
    downloadBlob(await makePng(), `${fileBase()}.png`);
    flash("PNG downloaded");
  };

  const copyPng = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": makePng() })]);
      flash("Image copied");
    } catch {
      setError("This browser can't copy images. Use Download PNG instead.");
    }
  };

  const downloadAllPngs = async () => {
    // one PNG per move, downloaded one after another
    const total = plies.length + 1;
    if (!confirm(`Download ${total} PNG files, one for every position?`)) return;
    for (let i = -1; i < plies.length; i++) {
      const p = i >= 0 ? plies[i] : null;
      const c = document.createElement("canvas");
      await renderBoard(c, {
        ...renderOpts,
        size,
        fen: p?.fenAfter ?? new Chess().fen(),
        lastMove: p ? { from: p.from, to: p.to } : null,
        inCheck: p ? p.san.includes("+") || p.san.includes("#") : false,
        caption: caption
          ? [captionLines[0], p ? `Position after ${p.moveNumber}${p.color === "w" ? "." : "..."} ${p.san}` : "Starting position"]
          : [],
      });
      const name = p ? `${String(i + 1).padStart(3, "0")}-${p.moveNumber}${p.color}-${p.san}` : "000-start";
      downloadBlob(await canvasToBlob(c), `${name.replace(/[^\w.-]+/g, "_")}.png`);
      await new Promise((r) => setTimeout(r, 180));
    }
  };

  const pgn = useMemo(() => (decoded ? toPgn(plies, headers) : ""), [decoded, plies, headers]);

  const downloadPgn = () => {
    downloadBlob(new Blob([pgn], { type: "application/x-chess-pgn" }), `${fileBase().replace(/-(move-\w+|start)$/, "")}.pgn`);
  };
  const copyPgn = async () => {
    await navigator.clipboard.writeText(pgn);
    flash("PGN copied");
  };

  const saveTraining = () => {
    if (!sentImages.length || !decoded) return;
    const line = buildTrainingExample(sentImages, plies, headers);
    downloadBlob(new Blob([line], { type: "application/jsonl" }), `training-${Date.now()}.jsonl`);
    flash("Training example saved");
  };

  const pick = (index: number, san: string) => {
    setPinned((p) => ({ ...p, [index]: san }));
    setCur(index);
  };
  const unpin = (index: number) =>
    setPinned((p) => {
      const copy = { ...p };
      delete copy[index];
      return copy;
    });

  const startOver = () => {
    setPhase("idle");
    setRaw(null);
    setDecoded(null);
    setPages([]);
    setPinned({});
    setError(null);
    setCur(-1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ---------- render ----------
  const rows = useMemo(() => {
    const r: Array<{ n: number; w?: DecodedPly; b?: DecodedPly }> = [];
    for (const p of plies) {
      let row = r.find((x) => x.n === p.moveNumber);
      if (!row) {
        row = { n: p.moveNumber };
        r.push(row);
      }
      row[p.color] = p;
    }
    return r;
  }, [plies]);

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
            <rect x="1" y="1" width="26" height="26" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
            <rect x="1" y="1" width="13" height="13" fill="currentColor" />
            <rect x="14" y="14" width="13" height="13" fill="currentColor" />
          </svg>
          <span>Scoresheet Scanner</span>
        </div>
        {phase === "done" && (
          <button className="btn btn-quiet" onClick={startOver}>
            Scan another sheet
          </button>
        )}
      </header>

      {phase !== "done" && (
        <main className="intake">
          <section className="intake-copy">
            <h1>
              Snap a scoresheet.
              <br />
              Get the PGN.
            </h1>
            <p className="lede">
              Photograph, scan or screenshot a handwritten chess scoresheet. The moves are read by AI, then checked
              against the rules of chess so scrawled moves get fixed. You get the game as a PGN for any chess app or site.
            </p>

            <div className="actions" role="group" aria-label="Add a scoresheet">
              <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
                Upload photo or PDF
              </button>
              <button className="btn" onClick={openCamera}>
                Scan with camera
              </button>
              <button className="btn" onClick={pasteFromClipboard}>
                Paste screenshot
              </button>
              {canCaptureScreen && (
                <button className="btn" onClick={captureScreen}>
                  Capture screen
                </button>
              )}
            </div>
            <p className="hint">
              Tip: press <kbd>Ctrl</kbd>+<kbd>V</kbd> (<kbd>⌘</kbd>+<kbd>V</kbd> on Mac) anywhere on this page to paste a
              screenshot. Two-page sheets: add both pages.
            </p>
            <button className="link" onClick={trySample}>
              No sheet handy? Try a sample game
            </button>

            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf,.pdf,.heic,.heif"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files, "camera");
                e.target.value = "";
              }}
            />
          </section>

          <section
            className={`sheet-drop ${dragging ? "is-dragging" : ""} ${pages.length ? "has-pages" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            aria-label="Scoresheet drop area"
          >
            {pages.length === 0 ? (
              <BlankSheet onClick={() => fileInput.current?.click()} />
            ) : (
              <div className="queue">
                <ol className="thumbs">
                  {pages.map((p, i) => (
                    <li key={p.id} className="thumb">
                      <Thumb page={p} cleaned={cleanUp} reading={phase === "reading"} />
                      <div className="thumb-bar">
                        <span className="thumb-name">
                          Page {i + 1}
                          <small>{p.source === "pdf" ? "PDF scan" : p.source === "screenshot" ? "Screenshot" : "Photo"}</small>
                        </span>
                        <span className="thumb-tools">
                          {pages.length > 1 && (
                            <button className="icon-btn" onClick={() => movePage(p.id, -1)} disabled={i === 0} aria-label="Move page earlier">
                              ↑
                            </button>
                          )}
                          <button className="icon-btn" onClick={() => rotatePage(p.id)} aria-label="Rotate page" disabled={phase === "reading"}>
                            ⟳
                          </button>
                          <button className="icon-btn" onClick={() => removePage(p.id)} aria-label="Remove page" disabled={phase === "reading"}>
                            ✕
                          </button>
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>

                <div className="queue-controls">
                  <label className="check">
                    <input type="checkbox" checked={cleanUp} onChange={(e) => setCleanUp(e.target.checked)} disabled={phase === "reading"} />
                    <span>
                      Clean up scan
                      <small>Removes shadows and boosts faint pencil. Best for phone photos.</small>
                    </span>
                  </label>
                  {pages.length < 4 && phase !== "reading" && (
                    <button className="btn btn-quiet" onClick={() => fileInput.current?.click()}>
                      Add a page
                    </button>
                  )}
                  <button className="btn btn-primary btn-wide" onClick={read} disabled={phase === "reading"}>
                    {phase === "reading" ? readingLabel(elapsed) : "Read scoresheet"}
                  </button>
                  {phase === "reading" && (
                    <p className="hint">
                      Usually under a minute; long games can take up to 3. {elapsed}s so far.
                    </p>
                  )}
                </div>
              </div>
            )}
          </section>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </main>
      )}

      {phase === "done" && (
        <main className="results" ref={resultsRef}>
          <section className="sheet" aria-label="Moves">
            <div className="sheet-head">
              <HeaderField label="White" value={headers.white} onChange={(v) => setHeaders({ ...headers, white: v })} />
              <HeaderField label="Black" value={headers.black} onChange={(v) => setHeaders({ ...headers, black: v })} />
              <HeaderField label="Event" value={headers.event} onChange={(v) => setHeaders({ ...headers, event: v })} />
              <HeaderField label="Date" value={headers.date} onChange={(v) => setHeaders({ ...headers, date: v })} />
              <label className="field">
                <span>Result</span>
                <select value={normalizeResult(headers.result)} onChange={(e) => setHeaders({ ...headers, result: e.target.value })}>
                  <option value="*">Unknown</option>
                  <option value="1-0">1–0</option>
                  <option value="0-1">0–1</option>
                  <option value="1/2-1/2">½–½</option>
                </select>
              </label>
            </div>

            <div className="summary" aria-live="polite">
              {decoding && !decoded ? (
                <span>Checking moves against the rules…</span>
              ) : (
                <>
                  <span>
                    <strong>{plies.length}</strong> half-moves
                  </span>
                  {counts.fixed > 0 && (
                    <span className="tag tag-fixed">
                      <strong>{counts.fixed}</strong> fixed by chess rules
                    </span>
                  )}
                  {counts.unsure > 0 && (
                    <span className="tag tag-unsure">
                      <strong>{counts.unsure}</strong> to check
                    </span>
                  )}
                  {counts.set > 0 && (
                    <span className="tag tag-set">
                      <strong>{counts.set}</strong> set by you
                    </span>
                  )}
                  {nextToCheck >= 0 && (
                    <button className="link" onClick={() => setCur(nextToCheck)}>
                      Show next move to check
                    </button>
                  )}
                </>
              )}
            </div>
            {decoded && decoded.leftover > 0 && (
              <p className="warn">
                {decoded.leftover} written move{decoded.leftover > 1 ? "s" : ""} came after the game was already over (checkmate or
                stalemate). Check the moves highlighted in yellow — an earlier misreading may have ended the game too soon.
              </p>
            )}

            <table className="moves">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col">White</th>
                  <th scope="col">Black</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.n}>
                    <th scope="row" className="num">
                      {row.n}
                    </th>
                    {(["w", "b"] as const).map((side) => {
                      const p = row[side];
                      if (!p) return <td key={side} />;
                      return (
                        <td key={side}>
                          <button
                            className={`cell cell-${p.status} ${p.index === cur ? "is-current" : ""}`}
                            onClick={() => setCur(p.index)}
                            aria-current={p.index === cur}
                            aria-label={`${row.n}${side === "w" ? "." : "..."} ${p.san}${p.status === "unsure" ? ", needs checking" : p.status === "fixed" ? ", corrected" : ""}`}
                          >
                            <span className="san">{p.san}</span>
                            {showWritten(p) && <span className="written">{p.asWritten || "?"}</span>}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="legend">
              <span className="legend-item legend-fixed">Red underline: corrected to the only legal match</span>
              <span className="legend-item legend-unsure">Yellow: unsure, please check</span>
              <span className="legend-item">Handwriting shows what was read from the sheet</span>
            </p>
          </section>

          <aside className="board-panel">
            <div className="board-wrap">
              <canvas ref={boardCanvas} className="board-canvas" aria-label={`Board ${current ? `after ${current.san}` : "at the start"}`} />
            </div>
            <div className="nav" role="group" aria-label="Move through the game">
              <button className="btn" onClick={() => setCur(-1)} aria-label="Start">
                ⏮
              </button>
              <button className="btn" onClick={() => setCur((c) => Math.max(-1, c - 1))} aria-label="Previous move">
                ◀
              </button>
              <span className="nav-pos">
                {current ? `${current.moveNumber}${current.color === "w" ? "." : "..."} ${current.san}` : "Start"}
              </span>
              <button className="btn" onClick={() => setCur((c) => Math.min(plies.length - 1, c + 1))} aria-label="Next move">
                ▶
              </button>
              <button className="btn" onClick={() => setCur(plies.length - 1)} aria-label="Final position">
                ⏭
              </button>
            </div>
            <input
              className="scrub"
              type="range"
              min={-1}
              max={Math.max(-1, plies.length - 1)}
              value={cur}
              onChange={(e) => setCur(Number(e.target.value))}
              aria-label="Position in game"
            />

            {current && (
              <MoveEditor
                key={`${current.index}-${current.san}`}
                ply={current}
                pinned={pinned[current.index]}
                onPick={(san) => pick(current.index, san)}
                onUnpin={() => unpin(current.index)}
              />
            )}

            <div className="export">
              <h2>Game (PGN)</h2>
              <textarea className="pgn-text" readOnly value={pgn} aria-label="PGN of the game" onFocus={(e) => e.currentTarget.select()} />
              <div className="export-actions">
                <button className="btn btn-primary" onClick={downloadPgn}>
                  Download PGN
                </button>
                <button className="btn" onClick={copyPgn}>
                  Copy PGN
                </button>
                <a className="btn btn-quiet" href={`https://lichess.org/analysis/standard/${fen.replace(/ /g, "_")}`} target="_blank" rel="noreferrer">
                  Open position in Lichess
                </a>
              </div>

              <h2>Board picture (PNG)</h2>
              <div className="export-grid">
                <label className="field">
                  <span>Size</span>
                  <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
                    {SIZES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Board colors</span>
                  <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeName)}>
                    <option value="club">Club green</option>
                    <option value="wood">Wood</option>
                    <option value="ink">Blue ink</option>
                    <option value="print">Print (grey)</option>
                  </select>
                </label>
              </div>
              <div className="toggles">
                <label className="check">
                  <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
                  <span>Black at bottom</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={coords} onChange={(e) => setCoords(e.target.checked)} />
                  <span>Coordinates</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={caption} onChange={(e) => setCaption(e.target.checked)} />
                  <span>Caption</span>
                </label>
              </div>
              <div className="export-actions">
                <button className="btn" onClick={downloadPng}>
                  Download PNG
                </button>
                <button className="btn" onClick={copyPng}>
                  Copy image
                </button>
                <button className="btn btn-quiet" onClick={downloadAllPngs}>
                  Download every position
                </button>
              </div>

              {sentImages.length > 0 && (
                <div className="train">
                  <h2>Teach it your handwriting</h2>
                  <p>
                    Once every move is right, save this sheet as a training example. With 10 or more, you can fine-tune the AI on
                    your own handwriting (see the README).
                  </p>
                  <button className="btn" onClick={saveTraining} disabled={counts.unsure > 0} title={counts.unsure > 0 ? "Check the yellow moves first" : undefined}>
                    Save as training example
                  </button>
                  {counts.unsure > 0 && <small>Check the yellow moves first.</small>}
                </div>
              )}
              {modelInfo && (
                <p className="meta-note">
                  Read by {modelInfo.model}
                  {modelInfo.verified > 0 ? `, ${modelInfo.verified} move${modelInfo.verified > 1 ? "s" : ""} double-checked` : ""}.
                </p>
              )}
            </div>
          </aside>
          {error && (
            <p className="error error-floating" role="alert" onClick={() => setError(null)}>
              {error}
            </p>
          )}
        </main>
      )}

      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}

      {cameraOpen && (
        <CameraCapture
          onClose={() => setCameraOpen(false)}
          onCapture={(c) => {
            setPages((p) => [...p, canvasToPage(c, "camera", "Camera scan")].slice(0, 4));
            setCleanUp(true);
            setCameraOpen(false);
          }}
        />
      )}

      <footer className="foot">
        Pieces by Colin M.L. Burnett (CC BY-SA 3.0). Images are sent to OpenAI for reading and aren&apos;t stored by this site.
      </footer>
    </div>
  );
}

const SAMPLE_ROWS: Array<[string, string]> = [
  ["e4", "c5"],
  ["Nf3", "d6"],
  ["d4", "cxd4"],
  ["Nxd4", "Nf6"],
  ["Nc3", "a6"],
  ["Be3", "e5"],
  ["Nb3", "Be6"],
  ["f3", "Be7"],
  ["Qd2", "O-O"],
  ["O-O-O", "Nbd7"],
];

/** Empty state: a blank scoresheet that doubles as the drop target. */
function BlankSheet({ onClick }: { onClick: () => void }) {
  return (
    <button className="blank" onClick={onClick} aria-label="Choose a scoresheet photo, screenshot or PDF">
      <span className="blank-head" aria-hidden="true">
        <span>
          White <i>A. Player</i>
        </span>
        <span>
          Black <i>B. Player</i>
        </span>
      </span>
      <span className="blank-grid" aria-hidden="true">
        {SAMPLE_ROWS.map(([w, b], i) => (
          <span className="blank-row" key={i} style={{ opacity: 1 - i * 0.085 }}>
            <span className="blank-num">{i + 1}</span>
            <span className="blank-move" style={{ transform: `rotate(${((i * 7) % 5) - 2}deg)` }}>
              {w}
            </span>
            <span className="blank-move" style={{ transform: `rotate(${((i * 3) % 5) - 2}deg)` }}>
              {b}
            </span>
          </span>
        ))}
      </span>
      <span className="blank-cta">
        <strong>Drop your scoresheet here</strong>
        <span>Photo, screenshot or scanned PDF</span>
      </span>
    </button>
  );
}

function readingLabel(seconds: number) {
  if (seconds < 45) return "Reading handwriting…";
  if (seconds < 100) return "Still reading — long games take longer…";
  return "Checking unclear moves…";
}

function showWritten(p: DecodedPly) {
  const a = (p.asWritten || "").replace(/[+#!?\s]/g, "");
  const b = p.san.replace(/[+#]/g, "");
  return p.status !== "read" || (a !== "" && a !== b);
}

function HeaderField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="—" />
    </label>
  );
}

function Thumb({ page, cleaned, reading }: { page: PageImage; cleaned: boolean; reading: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const src = cleaned ? cleanUpScan(shrink(page.canvas, 900)) : page.canvas;
    const scale = Math.min(1, 900 / Math.max(src.width, src.height));
    c.width = Math.round(src.width * scale);
    c.height = Math.round(src.height * scale);
    c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  }, [page, cleaned]);
  return (
    <div className={`thumb-img ${reading ? "is-reading" : ""}`}>
      <canvas ref={ref} />
      {reading && <span className="scanline" aria-hidden="true" />}
    </div>
  );
}

function shrink(src: HTMLCanvasElement, max: number) {
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  if (scale === 1) return src;
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function MoveEditor({
  ply,
  pinned,
  onPick,
  onUnpin,
}: {
  ply: DecodedPly;
  pinned?: string;
  onPick: (san: string) => void;
  onUnpin: () => void;
}) {
  const label = `${ply.moveNumber}${ply.color === "w" ? "." : "..."}`;
  const others = ply.suggestions.filter((s) => s !== ply.san).slice(0, 4);
  const message =
    ply.status === "read"
      ? "Read clearly."
      : ply.status === "fixed"
        ? `The sheet says “${ply.asWritten}”, which isn't legal here. ${ply.san} is the closest legal move.`
        : ply.status === "set"
          ? "You set this move."
          : ply.asWritten
            ? `“${ply.asWritten}” could be more than one legal move. Pick the right one.`
            : "This move couldn't be read. Pick the right one.";

  return (
    <div className={`editor editor-${ply.status}`}>
      <div className="editor-head">
        <span className="editor-move">
          {label} <strong>{ply.san}</strong>
        </span>
        {ply.asWritten && <span className="written big">{ply.asWritten}</span>}
      </div>
      <p>{message}</p>
      {others.length > 0 && (
        <div className="chips" role="group" aria-label="Other likely moves">
          {others.map((s) => (
            <button key={s} className="chip" onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="editor-row">
        <label className="field grow">
          <span>Any legal move</span>
          <select value={ply.san} onChange={(e) => onPick(e.target.value)}>
            {ply.legal.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {pinned ? (
          <button className="btn btn-quiet" onClick={onUnpin}>
            Undo my change
          </button>
        ) : (
          ply.status !== "read" && (
            <button className="btn btn-quiet" onClick={() => onPick(ply.san)}>
              Confirm {ply.san}
            </button>
          )
        )}
      </div>
      <small className="editor-note">Changing a move rechecks every move after it.</small>
    </div>
  );
}
