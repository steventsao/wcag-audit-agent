// probe.mjs — deterministic PDF accessibility audit via pdf-lib.
// This is the layer single-shot vision-on-pixels got 0% on: tagging, table
// headers, alt-text PRESENCE, language, title. All read from the bytes — no
// rendering, no model. Runs in node (validation) AND in the CF Worker (bundled).
import * as pdfLibNS from 'pdf-lib';
const pdfLib = pdfLibNS.default ?? pdfLibNS;
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFBool } = pdfLib;

const nameVal = (o) => (o instanceof PDFName ? o.asString().replace(/^\//, '') : null);
const strVal = (o) => {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  return null;
};
const boolVal = (o) => (o instanceof PDFBool ? o.asBoolean() : false);

function dictLookup(ctx, dict, key) {
  try { return dict.lookup(PDFName.of(key)); } catch { return undefined; }
}

// Walk the StructTreeRoot, counting roles and checking Figure /Alt + Table /TH.
function walkStruct(ctx, node, acc, depth = 0) {
  if (depth > 200 || node == null) return;
  let obj = node;
  try { obj = ctx.lookup(node); } catch { /* already resolved */ }
  if (obj instanceof PDFArray) {
    for (const el of obj.asArray()) walkStruct(ctx, el, acc, depth + 1);
    return;
  }
  if (!(obj instanceof PDFDict)) return; // PDFNumber = MCID leaf
  const s = nameVal(dictLookup(ctx, obj, 'S'));
  if (s) {
    acc.counts[s] = (acc.counts[s] || 0) + 1;
    if (s === 'Figure') {
      acc.figures++;
      const alt = strVal(dictLookup(ctx, obj, 'Alt')) || strVal(dictLookup(ctx, obj, 'ActualText'));
      if (alt && alt.trim()) acc.figuresWithAlt++;
    }
    if (s === 'Table') {
      acc.tables++;
      if (subtreeHasRole(ctx, obj, 'TH', 0)) acc.tablesWithTH++;
    }
  }
  const k = dictLookup(ctx, obj, 'K');
  if (k !== undefined) walkStruct(ctx, k, acc, depth + 1);
}

function subtreeHasRole(ctx, node, role, depth) {
  if (depth > 60 || node == null) return false;
  let obj = node;
  try { obj = ctx.lookup(node); } catch {}
  if (obj instanceof PDFArray) return obj.asArray().some((el) => subtreeHasRole(ctx, el, role, depth + 1));
  if (!(obj instanceof PDFDict)) return false;
  if (nameVal(dictLookup(ctx, obj, 'S')) === role) return true;
  const k = dictLookup(ctx, obj, 'K');
  return k === undefined ? false : subtreeHasRole(ctx, k, role, depth + 1);
}

export async function probePdf(bytes) {
  let doc, encrypted = false;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    encrypted = !!doc.isEncrypted;
  } catch (e) {
    return { error: `parse_failed: ${String(e).slice(0, 200)}`, openable: false, findings: [
      { criterion: 'structural', severity: 'error', standard: ['PDF/UA 7.1'], finding: 'PDF failed to parse / may be corrupt or encrypted.', impact: 'Assistive tech cannot open the document at all.', fix: 'Repair/normalize the PDF (qpdf) or re-export from source.' }] };
  }

  const ctx = doc.context;
  const catalog = doc.catalog;
  const lang = strVal(dictLookup(ctx, catalog, 'Lang'));
  const markInfo = dictLookup(ctx, catalog, 'MarkInfo');
  const marked = markInfo instanceof PDFDict ? boolVal(dictLookup(ctx, markInfo, 'Marked')) : false;
  const structRoot = dictLookup(ctx, catalog, 'StructTreeRoot');
  const hasStructRoot = structRoot instanceof PDFDict;
  const tagged = hasStructRoot && marked;
  const title = (() => { try { return doc.getTitle() || null; } catch { return null; } })();
  const vp = dictLookup(ctx, catalog, 'ViewerPreferences');
  const displayDocTitle = vp instanceof PDFDict ? boolVal(dictLookup(ctx, vp, 'DisplayDocTitle')) : false;
  const pageCount = doc.getPageCount();

  const acc = { counts: {}, figures: 0, figuresWithAlt: 0, tables: 0, tablesWithTH: 0 };
  if (hasStructRoot) {
    const k = dictLookup(ctx, structRoot, 'K');
    if (k !== undefined) walkStruct(ctx, k, acc);
  }

  // ---- findings + per-criterion verdicts -----------------------------------
  const findings = [];
  const F = (criterion, severity, std, finding, impact, fix) =>
    findings.push({ criterion, severity, standard: std, finding, impact, fix });

  if (!tagged) F('semantic_tagging', 'error', ['PDF/UA 7.1', 'WCAG 1.3.1'],
    hasStructRoot ? 'Has a structure tree but MarkInfo/Marked is not true — content is not marked.' : 'PDF is untagged (no StructTreeRoot).',
    'A screen reader gets no structure — it reads a visual-order jumble or nothing.',
    'Add a tagged structure tree (StructTreeRoot + Marked true) with correct roles.');
  if (!lang) F('semantic_tagging', 'error', ['PDF/UA 7.2', 'WCAG 3.1.1'],
    'No document /Lang set.', 'Screen readers may use the wrong pronunciation/voice.', 'Set the document language (e.g. /Lang (en-US)).');
  if (!title) F('semantic_tagging', 'error', ['PDF/UA 7.1', 'WCAG 2.4.2'],
    'No document title in metadata.', 'The window/tab shows the filename, not a meaningful title.', 'Set a Title in document properties.');
  else if (!displayDocTitle) F('semantic_tagging', 'warning', ['PDF/UA 7.1'],
    'Title set but DisplayDocTitle is not enabled.', 'Viewers show the filename instead of the title.', 'Enable ViewerPreferences /DisplayDocTitle true.');
  if (encrypted) F('structural', 'warning', ['PDF/UA 7.1'],
    'PDF is encrypted.', 'Encryption can block assistive-tech content extraction.', 'Allow accessibility extraction in permissions, or remove encryption.');

  const figsNoAlt = acc.figures - acc.figuresWithAlt;
  if (acc.figures > 0 && figsNoAlt > 0) F('alt_text', 'error', ['PDF/UA 7.3', 'WCAG 1.1.1'],
    `${figsNoAlt} of ${acc.figures} tagged figures have no alt text (/Alt).`,
    'Those images are announced as "graphic" or skipped — meaning lost.', 'Add meaningful /Alt to informative figures; mark decorative ones as Artifact.');
  const tblNoTH = acc.tables - acc.tablesWithTH;
  if (acc.tables > 0 && tblNoTH > 0) F('table_structure', 'error', ['PDF/UA 7.5', 'WCAG 1.3.1'],
    `${tblNoTH} of ${acc.tables} tables have no header cells (TH).`,
    'Cells are read with no header context — data becomes meaningless.', 'Tag the header row/column as TH and associate scope.');

  // verdicts (passed/failed/not_present/cannot_tell) — deterministic where bytes decide
  const verdict = (present, ok) => (!present ? 'not_present' : ok ? 'passed' : 'failed');
  const verdicts = {
    semantic_tagging: tagged && lang && title ? 'passed' : 'failed',
    alt_text_quality: verdict(acc.figures > 0, figsNoAlt === 0), // presence-level; quality needs vision
    table_structure: verdict(acc.tables > 0, tblNoTH === 0),
    // reading order correctness needs vision/diff — agent fills this; deterministic = cannot_tell
    logical_reading_order: tagged ? 'cannot_tell' : 'failed',
  };

  const score = Math.max(0, 100 - findings.reduce((n, f) => n + (f.severity === 'error' ? 18 : 6), 0));
  return {
    openable: true, encrypted, tagged, hasStructRoot, marked, lang: lang || null, title, displayDocTitle, pageCount,
    structCounts: acc.counts, figures: acc.figures, figuresWithAlt: acc.figuresWithAlt,
    tables: acc.tables, tablesWithTH: acc.tablesWithTH,
    verdicts, findings, score,
  };
}
