// Browser-only: keeps the sheets you've corrected, ready to train on.
// Stored in this browser (IndexedDB), so nothing is uploaded until you start training.

export interface TrainingExample {
  id: string;
  savedAt: number;
  title: string; // e.g. "Morphy – Duke, 33 moves"
  plies: number;
  line: string; // one JSONL line in OpenAI's fine-tuning format
}

const DB = "scoresheet-training";
const STORE = "examples";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open browser storage"));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function saveExample(ex: Omit<TrainingExample, "id" | "savedAt">): Promise<number> {
  const item: TrainingExample = { ...ex, id: `ex-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, savedAt: Date.now() };
  await tx("readwrite", (s) => s.put(item));
  return countExamples();
}

export async function listExamples(): Promise<TrainingExample[]> {
  const all = await tx<TrainingExample[]>("readonly", (s) => s.getAll() as IDBRequest<TrainingExample[]>);
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function countExamples(): Promise<number> {
  return tx("readonly", (s) => s.count());
}

export async function deleteExample(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** Import .jsonl files (e.g. downloaded earlier or from another device). */
export async function importJsonl(text: string, sourceName: string): Promise<number> {
  let added = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (!Array.isArray(obj?.messages)) continue;
      const answer = JSON.parse(obj.messages.at(-1)?.content ?? "{}");
      const names = [answer.white, answer.black].filter(Boolean).join(" – ");
      await saveExample({
        title: names || sourceName,
        plies: Array.isArray(answer.plies) ? answer.plies.length : 0,
        line,
      });
      added++;
    } catch {
      // skip lines that aren't training examples
    }
  }
  return added;
}
