import { describe, expect, test } from "bun:test";
import { parseTitle, splitArtists } from "../../src/matcher/normalize.ts";
import { artistScore, descriptorScore, scoreCandidate } from "../../src/matcher/score.ts";
import type { EnrichedTrack, SpotifyTrack } from "../../src/types.ts";

function rb(title: string, artist: string, durationMs = 200_000): EnrichedTrack {
  return { id: "1", title, artist, durationMs };
}

function sp(name: string, artists: string[], duration_ms = 200_000): SpotifyTrack {
  return {
    uri: "spotify:track:X",
    id: "X",
    name,
    artists: artists.map((n) => ({ name: n })),
    album: { name: "album" },
    duration_ms,
  };
}

describe("parseTitle", () => {
  test("reads a version qualifier in either spelling", () => {
    expect(parseTitle("Copper Lake (Aurora Pike Remix)")).toEqual({ base: "copper lake", descriptor: "aurora pike remix" });
    expect(parseTitle("Copper Lake - Aurora Pike Remix")).toEqual({ base: "copper lake", descriptor: "aurora pike remix" });
  });

  test("treats an original mix as no qualifier at all", () => {
    expect(parseTitle("Slow Meridian - Original Mix").descriptor).toBe("");
    expect(parseTitle("Slow Meridian (Original Mix)").descriptor).toBe("");
    expect(parseTitle("Slow Meridian").base).toBe("slow meridian");
  });

  test("drops collaboration markers Spotify keeps in the title", () => {
    expect(parseTitle("Paper Tigers (with Vela Sound)").base).toBe("paper tigers");
    expect(parseTitle("Amber Lines (feat. Vela Sound)").base).toBe("amber lines");
    expect(parseTitle("Quiet Signal (feat. Vela Sound & Lumen Fox)").base).toBe("quiet signal");
  });

  test("keeps a title that merely contains a qualifier word", () => {
    expect(parseTitle("Live Forever").base).toBe("live forever");
    expect(parseTitle("Original Sin").base).toBe("original sin");
  });
});

describe("splitArtists", () => {
  test("splits a rekordbox artist field into individual names", () => {
    expect(splitArtists("Nova Kestrel, Vela Sound")).toContain("nova kestrel");
    expect(splitArtists("Nova Kestrel, Vela Sound")).toContain("vela sound");
    expect(splitArtists("Mint Harrow vs Cobalt Hare")).toContain("cobalt hare");
  });

  test("keeps the undivided name too, so ampersand acts do not get shredded", () => {
    // "Salt & Steel" is one artist; splitting must not lose the real name.
    expect(splitArtists("Salt & Steel")).toContain("salt & steel");
  });
});

describe("artistScore", () => {
  test("one shared credit is enough, wherever it appears in the list", () => {
    expect(artistScore("Nova Kestrel, Vela Sound", sp("Paper Tigers", ["Nova Kestrel"]))).toBe(1);
    expect(artistScore("Vela Sound, Aurora Pike", sp("Driftwood", ["Aurora Pike"]))).toBe(1);
    expect(artistScore("Vela Sound, Lumen Fox, Ridge Sparrow", sp("Quiet Signal", ["Ridge Sparrow"]))).toBe(1);
  });

  test("unrelated artists score low", () => {
    expect(artistScore("Nova Kestrel", sp("Paper Tigers", ["Sable Quinn"]))).toBeLessThan(0.5);
  });
});

describe("descriptorScore", () => {
  test("a remix is not the plain recording", () => {
    expect(descriptorScore("", "sable quinn remix")).toBe(0);
    expect(descriptorScore("kilter remix", "")).toBe(0);
  });

  test("a different cut of the same recording is only mildly penalized", () => {
    expect(descriptorScore("", "radio edit")).toBeGreaterThan(0.5);
    expect(descriptorScore("", "extended mix")).toBeGreaterThan(0.5);
  });

  test("one remix does not stand in for another", () => {
    expect(descriptorScore("aurora pike remix", "flosstradamus remix")).toBeLessThan(0.6);
    expect(descriptorScore("aurora pike remix", "aurora pike remix")).toBe(1);
  });
});

describe("scoreCandidate — the cases that were failing", () => {
  test("matches a multi-artist track to its single-artist Spotify listing", () => {
    expect(scoreCandidate(rb("Paper Tigers", "Nova Kestrel, Vela Sound"), sp("Paper Tigers (with Vela Sound)", ["Nova Kestrel", "Vela Sound"])))
      .toBeGreaterThanOrEqual(0.99);
  });

  test("matches across the dash/parenthesis spelling divide", () => {
    expect(scoreCandidate(rb("Slow Meridian", "Mint Harrow"), sp("Slow Meridian - Original Mix", ["Mint Harrow"])))
      .toBeGreaterThanOrEqual(0.99);
  });

  test("keeps a remix and its original apart", () => {
    const plain = sp("Copper Lake", ["Mint Harrow"]);
    const remix = sp("Copper Lake - Aurora Pike Remix", ["Mint Harrow"]);

    const wantsRemix = rb("Copper Lake (Aurora Pike Remix)", "Mint Harrow, Cobalt Hare");
    expect(scoreCandidate(wantsRemix, remix)).toBeGreaterThan(scoreCandidate(wantsRemix, plain));

    const wantsPlain = rb("Copper Lake", "Mint Harrow, Cobalt Hare");
    expect(scoreCandidate(wantsPlain, plain)).toBeGreaterThan(scoreCandidate(wantsPlain, remix));
  });

  test("peels stacked qualifiers, not just the last one", () => {
    // "(Aurora Pike Remix) (Original Mix)" left the remix name stuck in the base.
    expect(parseTitle("Copper Lake (Aurora Pike Remix) (Original Mix)")).toEqual({
      base: "copper lake",
      descriptor: "aurora pike remix",
    });
    expect(scoreCandidate(
      rb("Copper Lake (Aurora Pike Remix) (Original Mix)", "Mint Harrow, Cobalt Hare"),
      sp("Copper Lake (Aurora Pike Remix)", ["Mint Harrow"]),
    )).toBeGreaterThanOrEqual(0.99);
  });

  test("accepts a remix credited to the artist the track is filed under", () => {
    // A DJ filing "Glass Harbour" under Cobalt Hare means the Cobalt Hare remix.
    expect(scoreCandidate(rb("Glass Harbour", "Cobalt Hare"), sp("GLASS HARBOUR - COBALT HARE REMIX", ["Cobalt Hare", "Lumen Fox"])))
      .toBeGreaterThanOrEqual(0.85);
  });

  test("still prefers the untouched original when Spotify has one", () => {
    const wanted = rb("Copper Lake", "Mint Harrow, Cobalt Hare");
    expect(scoreCandidate(wanted, sp("Copper Lake", ["Mint Harrow"])))
      .toBeGreaterThan(scoreCandidate(wanted, sp("Copper Lake - Aurora Pike Remix", ["Mint Harrow"])));
  });

  test("treats a bonus-track suffix as the same recording", () => {
    expect(scoreCandidate(rb("Half Light", "Ridge Sparrow"), sp("Half Light - Bonus Track", ["Ridge Sparrow"])))
      .toBeGreaterThanOrEqual(0.85);
  });

  test("refuses a remix when the plain recording was asked for", () => {
    // Previously scored ~0.90 and matched, handing back the wrong recording.
    expect(scoreCandidate(rb("Neon Ferns", "Tessellate"), sp("Neon Ferns - Sable Quinn Remix", ["Tessellate", "Sable Quinn"])))
      .toBeLessThan(0.85);
  });
});
