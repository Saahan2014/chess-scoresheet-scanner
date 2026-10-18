// Copies the PDF.js worker into /public so scanned PDFs can be opened in the browser.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const src = "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs";
if (existsSync(src)) {
  mkdirSync("public", { recursive: true });
  copyFileSync(src, "public/pdf.worker.min.mjs");
}
