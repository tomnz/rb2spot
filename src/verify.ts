import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRekordboxXml } from "./readers/xml.ts";
import { probeRekordboxDb } from "./readers/db-probe.ts";
import { buildConclusion, renderJson, renderMarkdown } from "./report.ts";
import type { VerifyReport } from "./types.ts";

export type VerifyOptions = {
  xmlPath?: string;
  dbPath?: string;
  skipXml?: boolean;
  skipDb?: boolean;
  outDir: string;
  ignorePlaylists?: string[];
  includePlaylists?: string[];
};

export type VerifyExecution = {
  report: VerifyReport;
  outputPaths: { md: string; json: string };
};

export async function runVerify(opts: VerifyOptions): Promise<VerifyExecution> {
  const xml = !opts.skipXml && opts.xmlPath
    ? await readRekordboxXml(opts.xmlPath, {
        ignorePlaylists: opts.ignorePlaylists,
        includePlaylists: opts.includePlaylists,
      })
    : null;
  const db = !opts.skipDb && opts.dbPath
    ? await probeRekordboxDb(opts.dbPath)
    : null;

  const base = {
    generatedAt: new Date().toISOString(),
    xml,
    db,
  };
  const report: VerifyReport = {
    ...base,
    conclusion: buildConclusion({ ...base, conclusion: "" }),
  };

  mkdirSync(opts.outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[-:T.Z+]/g, "").slice(0, 14);
  const mdPath = join(opts.outDir, `verify_${stamp}.md`);
  const jsonPath = join(opts.outDir, `verify_${stamp}.json`);
  writeFileSync(mdPath, renderMarkdown(report), "utf-8");
  writeFileSync(jsonPath, renderJson(report), "utf-8");

  return { report, outputPaths: { md: mdPath, json: jsonPath } };
}
