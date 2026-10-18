import type { RawPly } from "./decoder";

// A messy reading of Morphy's Opera Game (Paris, 1858), as a vision model might
// return it from a hurried scoresheet. Used by "Try a sample game".
const READ: Array<[string, string?, string[]?, RawPly["legibility"]?]> = [
  ["e4"], ["e5"], ["Nf3"], ["d6"], ["d4"], ["Bq4", "Bq4", ["Bg4"], "unclear"],
  ["de5", "de5"], ["Bf3", "Bf3"], ["Qf3"], ["dxe5"], ["Bc7", "Bc7", ["Bc1"], "unclear"], ["Nf6"],
  ["Qb8", "Qb8", ["Qb3", "Qd8"], "unclear"], ["Qe7"], ["Nc3"], ["c6"], ["Bg5"], ["b5"],
  ["Nb5", "Nb5"], ["cb5", "cb5"], ["Bb5+"], ["Nd7", "Nd7"], ["0-0-0", "O-O-O"], ["Rd8"],
  ["Rd7", "Rd7"], ["Rd7", "Rd7"], ["Rd1"], ["Qe6"], ["", "", [], "illegible"], ["Nd7", "Nd7"],
  ["Qb8+"], ["Nb8", "Nb8"], ["Rd8#"],
];

export const SAMPLE = {
  white: "Paul Morphy",
  black: "Duke Karl / Count Isouard",
  event: "Paris Opera",
  date: "1858",
  round: "",
  result: "1-0",
  language: "English",
  plies: READ.map(([asWritten, sanGuess, alternatives, legibility]) => ({
    asWritten,
    sanGuess: sanGuess ?? asWritten,
    alternatives: alternatives ?? [],
    legibility: legibility ?? "clear",
  })) as RawPly[],
};
