export type Track = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  isrc?: string;
  genre?: string;
  bpm?: number;
  key?: string;
};

export type Playlist = {
  name: string;
  path: string[];
  isIntelligent: boolean;
  trackIds: string[];
  rawNodeType?: string;
};

export type XmlVerifyResult = {
  path: string;
  status: "ok" | "parse_error" | "not_found";
  error?: string;
  playlistCount: { total: number; normal: number; intelligent: number };
  trackCount: number;
  intelligentSample: Array<{
    name: string;
    path: string[];
    trackIdCount: number;
  }>;
  isrcCoverage: { withIsrc: number; total: number; ratio: number };
  metadataCoverage: Record<keyof Track, number>;
  folderDepth: { max: number; sampleStructure: string[] };
};

export type DbVerifyResult = {
  path: string;
  status: "ok" | "encrypted" | "not_found" | "corrupted" | "permission_denied";
  error?: string;
  tableNames?: string[];
};

export type VerifyReport = {
  generatedAt: string;
  xml: XmlVerifyResult | null;
  db: DbVerifyResult | null;
  conclusion: string;
};

// === M1: Spotify =========================================================

export type SpotifyToken = {
  access_token: string;
  refresh_token: string;
  expires_at: number;   // Unix ms
  scope: string;
};

export type SpotifyTrack = {
  uri: string;
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string };
  duration_ms: number;
  external_ids?: { isrc?: string };
};

export type SpotifyPlaylistSummary = {
  id: string;
  name: string;
  owner: { id: string };
  snapshot_id: string;
  /** Track count, as the API reports it. */
  items?: { total: number };
  /** Alternate spelling of the same count, seen in some payloads. */
  tracks?: { total: number };
};

// === M1: Matching ========================================================

export type EnrichedTrack = Track & {
  spotifyUriFromLocation?: string;
  isrcFromId3?: string;
  resolvedFilePath?: string;
};

export type MatchStrategy = "uri" | "isrc" | "exact" | "fuzzy" | "duration" | "unmatched";

export type MatchResult = {
  rekordboxTrackId: string;
  spotifyUri: string | null;
  strategy: MatchStrategy;
  confidence: number;
  searchedQueries?: string[];
  candidatesConsidered?: number;
};

// === M1: Sync ============================================================

export type SyncOptions = {
  dryRun: boolean;
  outDir: string;
};

/** What a sync did, or would do, to one playlist. */
export type PlaylistChange = {
  name: string;
  action: "create" | "update" | "noop" | "unfollow" | "orphan";
  /** Track descriptions gained and lost, resolved to names where possible. */
  added: string[];
  removed: string[];
};

export type SyncSummary = {
  generatedAt: string;
  totalTracks: number;
  matched: number;
  unmatched: number;
  playlistsCreated: number;
  playlistsUpdated: number;
  playlistsUnfollowed: number;
  playlistsNoop: number;
  matchByStrategy: Record<MatchStrategy, number>;
  /** Per-playlist detail, so a dry run can show a diff rather than counts. */
  changes: PlaylistChange[];
};
