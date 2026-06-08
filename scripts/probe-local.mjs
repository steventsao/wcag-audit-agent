// Validate the deterministic probe against real PDFs (node, no Worker, no model).
import { readFileSync } from 'node:fs';
import { probePdf } from '../src/probe.mjs';

const files = process.argv.slice(2);
for (const f of files) {
  const bytes = new Uint8Array(readFileSync(f));
  const r = await probePdf(bytes);
  console.log(`\n=== ${f} ===`);
  console.log(`openable=${r.openable} tagged=${r.tagged} lang=${r.lang} title=${JSON.stringify(r.title)} pages=${r.pageCount} score=${r.score}`);
  console.log(`figures=${r.figures} (alt:${r.figuresWithAlt})  tables=${r.tables} (TH:${r.tablesWithTH})`);
  console.log(`verdicts=${JSON.stringify(r.verdicts)}`);
  console.log(`structCounts=${JSON.stringify(r.structCounts)}`);
  console.log(`findings (${(r.findings || []).length}):`);
  for (const x of r.findings || []) console.log(`  [${x.severity}] ${x.criterion}: ${x.finding}`);
}
