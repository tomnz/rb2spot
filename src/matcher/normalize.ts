const SUFFIX_PATTERNS = [
  /\s*\([^)]*(?:original|extended|radio|club|outdoor|indoor|long|short|edit|mix|version|remix)[^)]*\)\s*$/i,
];

const FEAT_PATTERN = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i;

const COUNTRY_CODE_PATTERN = /\s*\(([A-Z]{2,3})\)\s*$/;

function fullWidthToHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
}

/**
 * Words that mark a version qualifier rather than part of the title.
 * Spotify writes these after a dash ("Copper Lake - Aurora Pike Remix"), rekordbox
 * in parentheses ("Copper Lake (Aurora Pike Remix)"); both must reduce to the same
 * base title plus the same descriptor, or the two spellings never match.
 */
const DESCRIPTOR_WORDS =
  "original|extended|radio|club|outdoor|indoor|long|short|edit|mix|version|remix|dub|instrumental|acoustic|live|bootleg|rework|vip|remaster(?:ed)?|bonus|mono|stereo|demo|reprise|mashup|flip";

const PAREN_DESCRIPTOR = new RegExp(`\\s*[([]([^)\\]]*(?:${DESCRIPTOR_WORDS})[^)\\]]*)[)\\]]\\s*$`, "i");
const DASH_DESCRIPTOR = new RegExp(`\\s+-\\s+([^-]*(?:${DESCRIPTOR_WORDS})[^-]*)$`, "i");

/** Collaboration markers Spotify keeps in the title but rekordbox puts in the artist field. */
const COLLAB_IN_TITLE = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]\s*/gi;

/** "Original mix" means "not a remix", i.e. the same thing as no descriptor at all. */
const PLAIN_DESCRIPTOR = /^original(\s+mix)?$/i;

/** Separators rekordbox uses to cram several artists into one field. */
const ARTIST_SEPARATORS =
  /\s*(?:,|&|\+|\/|\||\bvs\.?\b|\bversus\b|\bx\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/gi;

export type ParsedTitle = {
  /** The title with version and collaboration qualifiers removed. */
  base: string;
  /** The version qualifier, canonicalized; empty for an original/plain track. */
  descriptor: string;
};

/** Split a title into its base and version descriptor, in either spelling. */
export function parseTitle(input: string): ParsedTitle {
  let s = fullWidthToHalfWidth(input ?? "").toLowerCase();
  s = s.replace(/[–—]/g, "-");
  s = s.replace(COLLAB_IN_TITLE, " ");
  s = s.replace(FEAT_PATTERN, "");

  const tidy = (v: string) => v.replace(/\s+/g, " ").trim();

  // Titles stack qualifiers — "Copper Lake (Aurora Pike Remix) (Original Mix)" is
  // common in DJ libraries. Peeling only the last one leaves the remix name
  // stuck in the base title, where it can never match Spotify's spelling.
  const found: string[] = [];
  for (let i = 0; i < 4; i++) {
    const paren = s.match(PAREN_DESCRIPTOR);
    if (paren) {
      found.push(paren[1]);
      s = s.replace(PAREN_DESCRIPTOR, "");
      continue;
    }
    const dash = s.match(DASH_DESCRIPTOR);
    if (dash) {
      found.push(dash[1]);
      s = s.replace(DASH_DESCRIPTOR, "");
      continue;
    }
    break;
  }

  // "Original mix" carries no information; keep whatever actually names a version.
  const meaningful = found.map(tidy).filter((d) => d && !PLAIN_DESCRIPTOR.test(d));
  return {
    base: tidy(s),
    descriptor: meaningful.join(" "),
  };
}

/** Every individual artist named in a rekordbox artist field or a Spotify credit. */
export function splitArtists(input: string): string[] {
  if (!input) return [];
  const parts = input
    .split(ARTIST_SEPARATORS)
    .map((a) => normalizeForMatching(a))
    .filter(Boolean);
  // Keep the whole string too: "Salt & Steel" is one artist, not two.
  const whole = normalizeForMatching(input);
  return whole && !parts.includes(whole) ? [...parts, whole] : parts;
}

export function normalizeForMatching(input: string): string {
  if (!input) return "";

  let s = input;
  s = fullWidthToHalfWidth(s);
  s = s.replace(COUNTRY_CODE_PATTERN, "");
  s = s.toLowerCase();

  // Remove feat/ft/featuring clauses first (they come after suffixes)
  s = s.replace(FEAT_PATTERN, "");

  // Then remove suffix patterns
  for (const pattern of SUFFIX_PATTERNS) {
    s = s.replace(pattern, "");
  }

  s = s.replace(/[–—]/g, "-");
  s = s.replace(/\s+/g, " ");
  s = s.trim();

  return s;
}
