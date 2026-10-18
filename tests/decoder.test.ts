import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeGame, toPgn, type RawPly } from "../lib/decoder";
import { cleanReading, handDistance } from "../lib/notation";

// Opera Game, Morphy vs Duke of Brunswick & Count Isouard, Paris 1858
const TRUE_MOVES =
  "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(
    " ",
  );

const plain = (moves: string[]): RawPly[] => moves.map((m) => ({ asWritten: m, sanGuess: m }));

test("clean sheet decodes exactly", () => {
  const r = decodeGame(plain(TRUE_MOVES));
  assert.deepEqual(r.plies.map((p) => p.san), TRUE_MOVES);
  assert.ok(r.plies.every((p) => p.status === "read"));
  assert.equal(r.plies.at(-1)!.san, "Rd8#");
});

test("sloppy handwriting is repaired by chess rules", () => {
  // the kind of mistakes a vision model makes on bad handwriting
  const garbled = [
    "e4", "e5", "Nf3", "d6", "d4", "Bq4", // q for g
    "de5", // capture written short
    "Bf3", // missing x
    "Qf3", "dxe5",
    "Bc7", // 4 misread as 7 (Bc7 isn't legal)
    "Nf6", "Qb8", // 3 misread as 8
    "Qe7", "Nc3", "c6", "Bg5", "b5", "Nb5", "cb5", "Bb5+", "Nd7", // ambiguous knight → must be Nbd7
    "0-0-0", "Rd8", "Rd7", "Rd7", "Rd1", "Qe6", "Bd7", "Nd7", "Qb8", "Nb8", "Rd8",
  ];
  const r = decodeGame(plain(garbled));
  assert.deepEqual(r.plies.map((p) => p.san), TRUE_MOVES);
  const fixed = r.plies.filter((p) => p.status !== "read").map((p) => p.index);
  assert.ok(fixed.includes(5) && fixed.includes(10) && fixed.includes(12));
});

test("foreign notation and illegible cells", () => {
  const german = TRUE_MOVES.map((m) => m.replace(/^N/, "S").replace(/^B/, "L").replace(/^R/, "T").replace(/^Q/, "D"));
  const raw: RawPly[] = german.map((m) => ({ asWritten: m }));
  raw[7] = { asWritten: "", legibility: "illegible" }; // Bxf3 smudged out
  const r = decodeGame(raw, { language: "German" });
  assert.equal(r.plies[7].status, "unsure");
  // the following moves (Qxf3 is only legal after Bxf3) pin it down
  assert.deepEqual(r.plies.map((p) => p.san), TRUE_MOVES);
});

test("pinned corrections override the reading", () => {
  const r = decodeGame(plain(["e4", "e5", "Nf3"]), { pinned: { 2: "Nc3" } });
  assert.equal(r.plies[2].san, "Nc3");
  assert.equal(r.plies[2].status, "set");
});

test("helpers", () => {
  assert.equal(cleanReading("0-0-0"), "O-O-O");
  assert.equal(cleanReading("12. Nf3+!"), "Nf3");
  assert.ok(handDistance("Bq4", "Bg4") < 0.5);
  const pgn = toPgn(decodeGame(plain(TRUE_MOVES)).plies, { white: "Morphy", result: "1-0" });
  assert.match(pgn, /17\. Rd8# 1-0/);
});
