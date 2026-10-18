// Browser-only helpers: turn photos, screenshots and scanned PDFs into
// clean, right-sized JPEGs for the vision model.

export interface PageImage {
  id: string;
  /** Original, full-resolution page as a canvas. */
  canvas: HTMLCanvasElement;
  source: "photo" | "screenshot" | "pdf" | "camera";
  name: string;
}

const MAX_SIDE = 2048;
let idCounter = 0;
const newId = () => `p${Date.now().toString(36)}${idCounter++}`;

export function isPdf(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Decode any image file the browser understands into a canvas. */
export async function imageFileToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(new Error("This image format can't be opened in this browser. Try a JPEG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible)."));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = "naturalWidth" in bitmap ? bitmap.naturalWidth : bitmap.width;
  const h = "naturalHeight" in bitmap ? bitmap.naturalHeight : bitmap.height;
  return drawScaled(bitmap, w, h, 3200);
}

export function drawScaled(src: CanvasImageSource, w: number, h: number, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Render the pages of a scanned PDF (first 4) to canvases. */
export async function pdfToCanvases(file: File): Promise<HTMLCanvasElement[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out: HTMLCanvasElement[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = 2400 / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
    out.push(canvas);
  }
  return out;
}

export async function fileToPages(file: File, source: PageImage["source"] = "photo"): Promise<PageImage[]> {
  if (isPdf(file)) {
    const canvases = await pdfToCanvases(file);
    return canvases.map((canvas, i) => ({ id: newId(), canvas, source: "pdf", name: `${file.name} · page ${i + 1}` }));
  }
  if (!file.type.startsWith("image/") && !/\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(file.name)) {
    throw new Error(`${file.name} isn't an image or PDF.`);
  }
  const canvas = await imageFileToCanvas(file);
  const looksLikeScreenshot = file.type === "image/png" || /screen ?shot|capture/i.test(file.name);
  return [{ id: newId(), canvas, source: looksLikeScreenshot && source === "photo" ? "screenshot" : source, name: file.name || "Pasted image" }];
}

export function canvasToPage(canvas: HTMLCanvasElement, source: PageImage["source"], name: string): PageImage {
  return { id: newId(), canvas, source, name };
}

export function rotateCanvas(src: HTMLCanvasElement, quarterTurns = 1): HTMLCanvasElement {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (turns === 0) return src;
  const c = document.createElement("canvas");
  const swap = turns % 2 === 1;
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/**
 * Scan cleanup for phone photos: removes uneven lighting and shadows by
 * dividing out a blurred copy of the background, then stretches contrast so
 * pencil and faint ballpoint stand out.
 */
export function cleanUpScan(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  // grayscale
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

  // background estimate: max-ish of a coarse grid, then blurred
  const cell = Math.max(8, Math.round(Math.max(w, h) / 48));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const vals: number[] = [];
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += 2)
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += 2) vals.push(gray[y * w + x]);
      vals.sort((a, b) => a - b);
      grid[gy * gw + gx] = vals[Math.floor(vals.length * 0.9)] ?? 255; // paper is the bright majority
    }
  }
  const blurred = boxBlur(grid, gw, gh, 2);

  // divide and collect histogram
  const norm = new Float32Array(w * h);
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1.001, Math.max(0, y / cell - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1.001, Math.max(0, x / cell - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const i00 = blurred[y0 * gw + x0];
      const i10 = blurred[y0 * gw + Math.min(gw - 1, x0 + 1)];
      const i01 = blurred[Math.min(gh - 1, y0 + 1) * gw + x0];
      const i11 = blurred[Math.min(gh - 1, y0 + 1) * gw + Math.min(gw - 1, x0 + 1)];
      const bg = (i00 * (1 - tx) + i10 * tx) * (1 - ty) + (i01 * (1 - tx) + i11 * tx) * ty;
      const v = Math.min(255, (gray[y * w + x] / Math.max(bg, 1)) * 255);
      norm[y * w + x] = v;
      hist[v | 0]++;
    }
  }
  // contrast stretch between 1st percentile and paper white
  const total = w * h;
  let acc = 0;
  let lo = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > total * 0.01) {
      lo = v;
      break;
    }
  }
  const hi = 245;
  const range = Math.max(20, hi - lo);
  for (let i = 0, j = 0; j < norm.length; i += 4, j++) {
    let v = ((norm[j] - lo) / range) * 255;
    v = 255 * Math.pow(Math.min(1, Math.max(0, v / 255)), 1.35); // darken strokes a little
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) {
          s += src[y * w + xx];
          n++;
        }
      }
      tmp[y * w + x] = s / n;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) {
          s += tmp[yy * w + x];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  return out;
}

/** Final JPEG sent to the server. Keeps each page well under Vercel's request limit. */
export function pageToDataUrl(canvas: HTMLCanvasElement, maxSide = MAX_SIDE, quality = 0.86): string {
  const c = drawScaled(canvas, canvas.width, canvas.height, maxSide);
  return c.toDataURL("image/jpeg", quality);
}

/** Shrink all pages until the total request is below ~4MB. */
export function pagesToPayload(canvases: HTMLCanvasElement[]): string[] {
  let side = MAX_SIDE;
  let quality = 0.86;
  for (let attempt = 0; attempt < 5; attempt++) {
    const urls = canvases.map((c) => pageToDataUrl(c, side, quality));
    const bytes = urls.reduce((n, u) => n + u.length, 0);
    if (bytes < 4_000_000) return urls;
    side = Math.round(side * 0.82);
    quality = Math.max(0.7, quality - 0.04);
  }
  return canvases.map((c) => pageToDataUrl(c, 1100, 0.7));
}

/** Grab one frame of a screen, window or tab the user picks (desktop browsers). */
export async function captureScreenFrame(): Promise<HTMLCanvasElement> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 300));
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d")!.drawImage(video, 0, 0);
    return c;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
