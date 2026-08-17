import type { VerifyReport } from "./types.ts";

export function buildConclusion(report: VerifyReport): string {
  const lines: string[] = [];
  const { xml, db } = report;

  if (xml?.status === "ok") {
    lines.push("Use the XML as the default data source.");
  } else if (xml?.status === "parse_error") {
    lines.push(`Failed to parse the XML: ${xml.error ?? "unknown error"}`);
  } else if (xml?.status === "not_found") {
    lines.push("XML file not found. Pass the correct path with --xml.");
  }

  if (xml?.status === "ok") {
    const lowIsrc = xml.isrcCoverage.ratio < 0.5;
    if (lowIsrc) {
      lines.push(
        `ISRC coverage is only ${(xml.isrcCoverage.ratio * 100).toFixed(1)}%, so matching will ` +
          "rely mainly on normalized Artist+Title (the ISRC strategy will rarely fire)."
      );
    }
    const zeroTrackIntelligent = xml.intelligentSample.filter(p => p.trackIdCount === 0).length;
    if (xml.playlistCount.intelligent > 0) {
      lines.push(
        `${xml.playlistCount.intelligent} suspected intelligent playlist(s) ` +
          `(${zeroTrackIntelligent} with no member tracks). Syncing these needs separate handling.`
      );
    }
  }

  if (db?.status === "encrypted") {
    lines.push("The DB is SQLCipher-encrypted and unreadable by this tool (XML is the practical choice).");
  } else if (db?.status === "not_found") {
    lines.push("DB file not found. That is expected when working from an XML export.");
  } else if (db?.status === "ok") {
    lines.push(`The DB was readable (${db.tableNames?.length ?? 0} tables detected).`);
  }

  return lines.join("\n");
}

export function renderJson(report: VerifyReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderMarkdown(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push("# rekordbox-spotify-sync verify report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Conclusion");
  lines.push("");
  lines.push(report.conclusion);
  lines.push("");

  const xml = report.xml;
  if (xml) {
    lines.push("## XML");
    lines.push("");
    lines.push(`- Path: \`${xml.path}\``);
    lines.push(`- Status: ${xml.status}${xml.error ? ` (${xml.error})` : ""}`);
    if (xml.status === "ok") {
      lines.push(`- Tracks: ${xml.trackCount}`);
      lines.push(
        `- Playlists: ${xml.playlistCount.total} ` +
          `(normal ${xml.playlistCount.normal} / suspected intelligent ${xml.playlistCount.intelligent})`
      );
      lines.push(`- Max folder depth: ${xml.folderDepth.max}`);
      if (xml.folderDepth.sampleStructure.length > 0) {
        lines.push(`- Example folder structure: ${xml.folderDepth.sampleStructure.slice(0, 3).join(", ")}`);
      }
      lines.push(
        `- ISRC coverage: ${xml.isrcCoverage.withIsrc} / ${xml.isrcCoverage.total} ` +
          `(${(xml.isrcCoverage.ratio * 100).toFixed(1)}%)`
      );
      lines.push("");
      lines.push("### Metadata coverage");
      lines.push("");
      lines.push("| field | coverage |");
      lines.push("|---|---|");
      for (const [k, v] of Object.entries(xml.metadataCoverage)) {
        lines.push(`| ${k} | ${(v * 100).toFixed(1)}% |`);
      }
      if (xml.intelligentSample.length > 0) {
        lines.push("");
        lines.push("### Intelligent playlist samples");
        lines.push("");
        lines.push("| name | path | trackIds |");
        lines.push("|---|---|---|");
        for (const p of xml.intelligentSample) {
          const pathStr = p.path.length === 0 ? "/" : p.path.join(" > ");
          const status = p.trackIdCount === 0 ? "0 (not expanded)" : `${p.trackIdCount} (expanded)`;
          lines.push(`| ${p.name} | ${pathStr} | ${status} |`);
        }
      }
    }
    lines.push("");
  }

  const db = report.db;
  if (db) {
    lines.push("## DB");
    lines.push("");
    lines.push(`- Path: \`${db.path}\``);
    lines.push(`- Status: ${db.status}${db.error ? ` (${db.error})` : ""}`);
    if (db.status === "encrypted") {
      lines.push("");
      lines.push("Note: the rekordbox 6+ master.db is SQLCipher-encrypted and cannot be opened with bun:sqlite.");
      lines.push("This tool works from the XML export instead.");
    }
    if (db.tableNames && db.tableNames.length > 0) {
      lines.push(`- Tables detected: ${db.tableNames.slice(0, 10).join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
