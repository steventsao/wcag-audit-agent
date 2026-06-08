// wcag-template.ts — the canonical WCAG 2.2 A/AA success-criteria template + the 11 live-UI rule areas.
//
// SINGLE SOURCE OF TRUTH for the WCAG audit surface. Pure data + types, no logic, no runtime imports —
// it tree-shakes into the wrangler bundle and is consumed by:
//   • src/agents/wcag-agent.ts  — WcagAgent.buildRollup folds the coordinator's CriterionFinding[] onto
//                                  WCAG_22_AA, grouped by RULE_AREAS (consumes evidence, never re-measures).
//   • src/ui.ts                 — the live report renders the rule-area sidebar + per-SC rows from the
//                                  pushed rollup (report.wcag.areas), so NO 55-SC table is duplicated in HTML.
//
// PROVENANCE: WCAG 2.2 Recommendation (w3.org/TR/WCAG22). Confirmed counts —
// Level A = 31, Level AA = 24, total = 55. `4.1.1 Parsing` is intentionally ABSENT (removed/obsolete in
// 2.2). The 6 in-scope 2.2 additions are PRESENT: 2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8 (the 3 AAA
// additions 2.4.12/2.4.13/3.3.9 are excluded with the rest of AAA). PDF-specific applicability +
// evidence-source + the contrast/reading-order "always pending human review" defaults follow
// the WCAG 2.2 standard's PDF techniques guidance.

export type WcagLevel = 'A' | 'AA';

/** Which producer can yield evidence for a criterion on a PDF (closed enum the rollup keys on). */
export type EvidenceSource =
  | 'validator-verapdf-pac'
  | 'contrast-facet'
  | 'byte-probe-structure'
  | 'reading-order-vlm'
  | 'alt-text-vlm'
  | 'metadata'
  | 'human-only'
  | 'n/a-static-pdf';

/** How decidable a criterion is for a PDF (machine fact vs machine pre-assessment vs human judgment). */
export type MachineDecidability = 'machine-decidable' | 'machine-pre-assessable' | 'human-only';

/** One WCAG 2.2 success criterion, annotated for PDF accessibility auditing. */
export interface WcagSc {
  /** SC number, e.g. "1.4.3". */
  sc: string;
  /** Exact SC name, e.g. "Contrast (Minimum)". */
  name: string;
  level: WcagLevel;
  /** POUR principle. */
  principle: 'Perceivable' | 'Operable' | 'Understandable' | 'Robust';
  /** Guideline number + name, e.g. "1.4 Distinguishable". */
  guideline: string;
  /** Whether this SC meaningfully applies to a static PDF (many time-based/scripted SCs do not). */
  pdfApplicable: boolean;
  /** One-line reason for the pdfApplicable judgment. */
  pdfReason: string;
  /** The producer that can yield evidence for this SC on a PDF. */
  evidenceSource: EvidenceSource;
  machineDecidability: MachineDecidability;
  /** One sentence: what a PDF auditor checks for this SC. */
  checkNote: string;
}

/**
 * The complete WCAG 2.2 Level A + AA template (55 SCs: 31 A, 24 AA). Verbatim from the validated
 * research output. Do NOT re-add 4.1.1 Parsing (removed in 2.2). Order: all Level A, then all Level AA.
 */
export const WCAG_22_AA: WcagSc[] = [
  // ───────────────────────── Level A (31) ─────────────────────────
  { sc: '1.1.1', name: 'Non-text Content', level: 'A', principle: 'Perceivable', guideline: '1.1 Text Alternatives', pdfApplicable: true, pdfReason: 'Figures/images in a PDF need alt text; decorative content must be marked as artifact.', evidenceSource: 'alt-text-vlm', machineDecidability: 'machine-pre-assessable', checkNote: 'Check every Figure tag has non-empty /Alt and that decorative images are artifacted, then judge alt-text quality.' },
  { sc: '1.2.1', name: 'Audio-only and Video-only (Prerecorded)', level: 'A', principle: 'Perceivable', guideline: '1.2 Time-based Media', pdfApplicable: false, pdfReason: 'Static PDFs rarely embed prerecorded audio/video-only media; only applies to multimedia-rich PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If embedded media exists, confirm a text or audio alternative; otherwise N/A for static documents.' },
  { sc: '1.2.2', name: 'Captions (Prerecorded)', level: 'A', principle: 'Perceivable', guideline: '1.2 Time-based Media', pdfApplicable: false, pdfReason: 'Captions apply only to embedded prerecorded video, uncommon in audited PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If a synchronized video is embedded, verify captions exist; otherwise N/A.' },
  { sc: '1.2.3', name: 'Audio Description or Media Alternative (Prerecorded)', level: 'A', principle: 'Perceivable', guideline: '1.2 Time-based Media', pdfApplicable: false, pdfReason: 'Requires embedded prerecorded video; not present in typical static PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If embedded video exists, verify audio description or full text alternative; otherwise N/A.' },
  { sc: '1.3.1', name: 'Info and Relationships', level: 'A', principle: 'Perceivable', guideline: '1.3 Adaptable', pdfApplicable: true, pdfReason: 'Core PDF/UA criterion: tag structure must encode headings, lists, tables (TH/TD), and reading relationships.', evidenceSource: 'validator-verapdf-pac', machineDecidability: 'machine-pre-assessable', checkNote: 'Check the tag tree expresses structure (H1-H6, L/LI, Table/TR/TH/TD, scope) that matches the visual layout.' },
  { sc: '1.3.2', name: 'Meaningful Sequence', level: 'A', principle: 'Perceivable', guideline: '1.3 Adaptable', pdfApplicable: true, pdfReason: 'Logical reading order in the tag tree must match the intended reading sequence of the page.', evidenceSource: 'reading-order-vlm', machineDecidability: 'machine-pre-assessable', checkNote: 'Compare the structure-tree reading order against VLM-recovered visual order; agreement is evidence, divergence escalates to human.' },
  { sc: '1.3.3', name: 'Sensory Characteristics', level: 'A', principle: 'Perceivable', guideline: '1.3 Adaptable', pdfApplicable: true, pdfReason: "Instructions in body text must not rely solely on shape, size, or position ('see the box at right').", evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Read for instructions that depend only on sensory cues; requires human semantic judgment of the prose.' },
  { sc: '1.4.1', name: 'Use of Color', level: 'A', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: true, pdfReason: 'Color must not be the sole means of conveying info (e.g., red=required, colored links with no underline).', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Inspect whether any meaning (links, status, required fields) is carried by color alone without a secondary cue.' },
  { sc: '1.4.2', name: 'Audio Control', level: 'A', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: false, pdfReason: 'Auto-playing audio >3s is essentially never present in a static PDF.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If auto-playing audio is embedded, confirm a pause/stop/volume control; otherwise N/A.' },
  { sc: '2.1.1', name: 'Keyboard', level: 'A', principle: 'Operable', guideline: '2.1 Keyboard Accessible', pdfApplicable: true, pdfReason: 'Applies when the PDF has interactive form fields or link annotations that must be keyboard-operable.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'For PDFs with AcroForm fields/links, verify they are reachable and operable via Tab/keyboard; static-content-only is trivially met.' },
  { sc: '2.1.2', name: 'No Keyboard Trap', level: 'A', principle: 'Operable', guideline: '2.1 Keyboard Accessible', pdfApplicable: false, pdfReason: 'Keyboard traps arise in scripted/interactive content; static and simple-form PDFs do not trap focus.', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Only relevant for PDFs with scripting/embedded media; confirm focus can always move away.' },
  { sc: '2.1.4', name: 'Character Key Shortcuts', level: 'A', principle: 'Operable', guideline: '2.1 Keyboard Accessible', pdfApplicable: false, pdfReason: 'Single-character shortcuts require document JavaScript, virtually never used in audited PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If document JS defines single-key shortcuts, verify remap/disable; otherwise N/A.' },
  { sc: '2.2.1', name: 'Timing Adjustable', level: 'A', principle: 'Operable', guideline: '2.2 Enough Time', pdfApplicable: false, pdfReason: 'Time limits require scripting; not applicable to static documents.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only if document JS imposes a time limit; otherwise N/A.' },
  { sc: '2.2.2', name: 'Pause, Stop, Hide', level: 'A', principle: 'Operable', guideline: '2.2 Enough Time', pdfApplicable: false, pdfReason: 'Moving/blinking/auto-updating content needs scripting or media; absent in static PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If animated/auto-updating content is embedded, confirm a pause/stop/hide mechanism; otherwise N/A.' },
  { sc: '2.3.1', name: 'Three Flashes or Below Threshold', level: 'A', principle: 'Operable', guideline: '2.3 Seizures and Physical Reactions', pdfApplicable: false, pdfReason: 'Flashing requires animation/media; a static PDF cannot flash.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If embedded video/animation flashes, verify it stays under threshold; otherwise N/A.' },
  { sc: '2.4.1', name: 'Bypass Blocks', level: 'A', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: true, pdfReason: 'Met in PDFs primarily via correct heading structure and bookmarks for navigating past repeated blocks.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'Check the document provides headings and (for long docs) bookmarks/outline that let users skip repeated content.' },
  { sc: '2.4.2', name: 'Page Titled', level: 'A', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: true, pdfReason: 'PDF must have a non-empty document /Title in metadata and DisplayDocTitle set in ViewerPreferences.', evidenceSource: 'metadata', machineDecidability: 'machine-decidable', checkNote: 'Byte-probe the /Title (XMP/DocInfo) is meaningful and that ViewerPreferences /DisplayDocTitle is true.' },
  { sc: '2.4.3', name: 'Focus Order', level: 'A', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: true, pdfReason: 'Tab order of form fields/annotations must follow logical (structure) order, set via /Tabs = /S.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: "Verify each page's /Tabs is /S (use structure order) and that field/annotation tab sequence is logical." },
  { sc: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: true, pdfReason: 'Link annotations need a tagged Link with accessible text; purpose must be clear from link text or context.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: "Check Link annotations are tagged with associated text and that link text is descriptive (flag bare URLs / 'click here')." },
  { sc: '2.5.1', name: 'Pointer Gestures', level: 'A', principle: 'Operable', guideline: '2.5 Input Modalities', pdfApplicable: false, pdfReason: 'Multipoint/path-based gestures require interactive scripted content; not applicable to static PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted interactive PDFs; otherwise N/A.' },
  { sc: '2.5.2', name: 'Pointer Cancellation', level: 'A', principle: 'Operable', guideline: '2.5 Input Modalities', pdfApplicable: false, pdfReason: 'Down-event activation behavior requires scripting; static/simple-form PDFs do not trigger on down-event.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted interactive PDFs; otherwise N/A.' },
  { sc: '2.5.3', name: 'Label in Name', level: 'A', principle: 'Operable', guideline: '2.5 Input Modalities', pdfApplicable: true, pdfReason: 'For form fields, the accessible name (TU/tagged label) must contain the visible label text.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: "For PDFs with form fields, check each field's accessible name includes its visible label; N/A if no fields." },
  { sc: '2.5.4', name: 'Motion Actuation', level: 'A', principle: 'Operable', guideline: '2.5 Input Modalities', pdfApplicable: false, pdfReason: 'Device-motion actuation does not exist in PDF documents.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Not applicable to PDFs; N/A.' },
  { sc: '3.1.1', name: 'Language of Page', level: 'A', principle: 'Understandable', guideline: '3.1 Readable', pdfApplicable: true, pdfReason: 'The document catalog must declare a default natural language via /Lang.', evidenceSource: 'metadata', machineDecidability: 'machine-decidable', checkNote: 'Byte-probe the catalog /Lang is present and a valid BCP-47 tag matching the document primary language.' },
  { sc: '3.2.1', name: 'On Focus', level: 'A', principle: 'Understandable', guideline: '3.2 Predictable', pdfApplicable: false, pdfReason: 'Context changes on focus require scripting; not applicable to static or simple-form PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted PDFs where focusing a field changes context; otherwise N/A.' },
  { sc: '3.2.2', name: 'On Input', level: 'A', principle: 'Understandable', guideline: '3.2 Predictable', pdfApplicable: false, pdfReason: 'Context changes on input require scripting; not applicable to static or simple-form PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted PDFs where changing a field triggers a context change; otherwise N/A.' },
  { sc: '3.2.6', name: 'Consistent Help', level: 'A', principle: 'Understandable', guideline: '3.2 Predictable', pdfApplicable: false, pdfReason: 'Targets help mechanisms repeated across a set of web pages; not meaningful for a single PDF.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Generally N/A to PDFs (no multi-page-set help affordance); applies only to web flows.' },
  { sc: '3.3.1', name: 'Error Identification', level: 'A', principle: 'Understandable', guideline: '3.3 Input Assistance', pdfApplicable: false, pdfReason: 'Requires interactive form validation via scripting; only applies to scripted AcroForm PDFs.', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Only for PDFs with validated form input; confirm errors are identified in text; otherwise N/A.' },
  { sc: '3.3.2', name: 'Labels or Instructions', level: 'A', principle: 'Understandable', guideline: '3.3 Input Assistance', pdfApplicable: true, pdfReason: 'Form fields must have programmatic labels (TU tooltip / tagged label) and any needed instructions.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'For PDFs with form fields, verify each has a /TU or tagged label; N/A if the document has no fields.' },
  { sc: '3.3.7', name: 'Redundant Entry', level: 'A', principle: 'Understandable', guideline: '3.3 Input Assistance', pdfApplicable: false, pdfReason: 'Auto-populate/avoid-re-entry behavior requires scripted multi-step forms; rare in PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only for scripted multi-step PDF forms; otherwise N/A.' },
  { sc: '4.1.2', name: 'Name, Role, Value', level: 'A', principle: 'Robust', guideline: '4.1 Compatible', pdfApplicable: true, pdfReason: 'Form fields and interactive controls must expose correct role/name/value/state via tags and field dictionaries.', evidenceSource: 'validator-verapdf-pac', machineDecidability: 'machine-pre-assessable', checkNote: 'For interactive PDFs, verify each control exposes a programmatic name, role (Form/field type), and current value/state.' },
  // ───────────────────────── Level AA (24) ─────────────────────────
  { sc: '1.2.4', name: 'Captions (Live)', level: 'AA', principle: 'Perceivable', guideline: '1.2 Time-based Media', pdfApplicable: false, pdfReason: 'Live media cannot exist in a static PDF.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Not applicable to PDFs; N/A.' },
  { sc: '1.2.5', name: 'Audio Description (Prerecorded)', level: 'AA', principle: 'Perceivable', guideline: '1.2 Time-based Media', pdfApplicable: false, pdfReason: 'Requires embedded prerecorded video; uncommon in audited PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'If embedded video exists, verify audio description track; otherwise N/A.' },
  { sc: '1.3.4', name: 'Orientation', level: 'AA', principle: 'Perceivable', guideline: '1.3 Adaptable', pdfApplicable: false, pdfReason: 'PDFs are not locked to an orientation by the document; viewer handles rotation.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Not applicable to PDFs (no orientation lock at document level); N/A.' },
  { sc: '1.3.5', name: 'Identify Input Purpose', level: 'AA', principle: 'Perceivable', guideline: '1.3 Adaptable', pdfApplicable: true, pdfReason: 'Collecting user-info fields should expose purpose; PDF support is limited but applies when fields collect personal data.', evidenceSource: 'byte-probe-structure', machineDecidability: 'human-only', checkNote: 'For PDFs with personal-data form fields, check fields are labeled with identifiable purpose; N/A if no such fields.' },
  { sc: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: true, pdfReason: 'Text must meet 4.5:1 (3:1 large); pure-WCAG criterion outside PDF/UA, resolved by pixel/layer analysis.', evidenceSource: 'contrast-facet', machineDecidability: 'machine-pre-assessable', checkNote: 'Layerize text vs background, compute worst-case contrast under each glyph footprint against 4.5:1 / 3:1-large thresholds.' },
  { sc: '1.4.4', name: 'Resize Text', level: 'AA', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: true, pdfReason: 'Text must remain usable when zoomed to 200%; depends on real selectable text vs scanned raster.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'Confirm the PDF contains real (reflowable/selectable) text rather than images of text so viewer zoom preserves legibility.' },
  { sc: '1.4.5', name: 'Images of Text', level: 'AA', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: true, pdfReason: 'Text should be real text, not rasterized images of text (the defining failure of scanned PDFs).', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'Detect image-only / scanned pages where body text is a raster rather than encoded glyphs.' },
  { sc: '1.4.10', name: 'Reflow', level: 'AA', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: true, pdfReason: "Reflow without 2D scrolling depends on a correct tag tree enabling the viewer's Liquid/reflow mode.", evidenceSource: 'validator-verapdf-pac', machineDecidability: 'machine-pre-assessable', checkNote: 'Verify the document is tagged so reflow view presents single-column content without horizontal scrolling.' },
  { sc: '1.4.11', name: 'Non-text Contrast', level: 'AA', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: true, pdfReason: 'UI components / meaningful graphics need 3:1 contrast; pure-WCAG, resolved by pixel analysis.', evidenceSource: 'contrast-facet', machineDecidability: 'machine-pre-assessable', checkNote: 'Pixel-measure form-field borders, focus indicators, and meaningful graphic boundaries against the 3:1 threshold.' },
  { sc: '1.4.12', name: 'Text Spacing', level: 'AA', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: false, pdfReason: 'Users cannot override text spacing in fixed-layout PDFs the way they can in HTML/CSS.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Generally N/A to fixed-layout PDFs (no user spacing override surface); applies to reflowable HTML.' },
  { sc: '1.4.13', name: 'Content on Hover or Focus', level: 'AA', principle: 'Perceivable', guideline: '1.4 Distinguishable', pdfApplicable: false, pdfReason: 'Hover/focus-triggered content (tooltips/popovers) requires scripting; not present in static PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted PDFs with hover/focus popups; otherwise N/A.' },
  { sc: '2.4.5', name: 'Multiple Ways', level: 'AA', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: true, pdfReason: 'For longer PDFs, multiple navigation paths (bookmarks/outline + ToC) should exist.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'For multi-page documents, check for bookmarks/outline and/or a linked table of contents; single-page docs may be exempt.' },
  { sc: '2.4.6', name: 'Headings and Labels', level: 'AA', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: true, pdfReason: 'Headings and form-field labels must be present and descriptive of topic/purpose.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'Verify heading tags exist and labels are descriptive; presence is machine-checkable, descriptiveness needs human judgment.' },
  { sc: '2.4.7', name: 'Focus Visible', level: 'AA', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: true, pdfReason: 'Applies to interactive PDFs with form fields/links; keyboard focus indication is largely viewer-provided.', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'For interactive PDFs, confirm focus is visible when tabbing through fields/links; N/A for static documents.' },
  { sc: '2.4.11', name: 'Focus Not Obscured (Minimum)', level: 'AA', principle: 'Operable', guideline: '2.4 Navigable', pdfApplicable: false, pdfReason: 'Sticky/overlapping content obscuring focus is a scripted-UI concern; not applicable to static PDFs. (New in 2.2.)', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted PDFs with overlapping layers; otherwise N/A.' },
  { sc: '2.5.7', name: 'Dragging Movements', level: 'AA', principle: 'Operable', guideline: '2.5 Input Modalities', pdfApplicable: false, pdfReason: 'Drag operations require interactive scripted content; not applicable to static PDFs. (New in 2.2.)', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted interactive PDFs with drag UI; otherwise N/A.' },
  { sc: '2.5.8', name: 'Target Size (Minimum)', level: 'AA', principle: 'Operable', guideline: '2.5 Input Modalities', pdfApplicable: true, pdfReason: 'Interactive targets (form fields, link annotations) should meet 24x24 CSS px equivalent. (New in 2.2.)', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'For PDFs with form fields/links, measure annotation rects against the 24x24 minimum; N/A if no interactive targets.' },
  { sc: '3.1.2', name: 'Language of Parts', level: 'AA', principle: 'Understandable', guideline: '3.1 Readable', pdfApplicable: true, pdfReason: 'Passages in a different language must carry a /Lang on the relevant structure element.', evidenceSource: 'byte-probe-structure', machineDecidability: 'machine-pre-assessable', checkNote: 'Check that foreign-language passages have a /Lang attribute on their structure element; detection of foreign text may need human review.' },
  { sc: '3.2.3', name: 'Consistent Navigation', level: 'AA', principle: 'Understandable', guideline: '3.2 Predictable', pdfApplicable: true, pdfReason: 'Repeated navigational elements (headers/footers/page nav) should appear in a consistent relative order across pages.', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Inspect that running headers/footers and repeated nav keep a consistent order across pages; human judgment.' },
  { sc: '3.2.4', name: 'Consistent Identification', level: 'AA', principle: 'Understandable', guideline: '3.2 Predictable', pdfApplicable: true, pdfReason: 'Components with the same function should be identified consistently (e.g., repeated icons/labels).', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Check that recurring functional elements use consistent labels/alt text throughout; human judgment.' },
  { sc: '3.3.3', name: 'Error Suggestion', level: 'AA', principle: 'Understandable', guideline: '3.3 Input Assistance', pdfApplicable: false, pdfReason: 'Requires scripted form validation that suggests corrections; only scripted AcroForm PDFs.', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Only for validated PDF forms; confirm correction suggestions are provided; otherwise N/A.' },
  { sc: '3.3.4', name: 'Error Prevention (Legal, Financial, Data)', level: 'AA', principle: 'Understandable', guideline: '3.3 Input Assistance', pdfApplicable: false, pdfReason: 'Reversible/checked/confirmed submissions require scripted transactional forms; rare in audited PDFs.', evidenceSource: 'human-only', machineDecidability: 'human-only', checkNote: 'Only for transactional PDF forms; confirm review/confirm/reverse mechanism; otherwise N/A.' },
  { sc: '3.3.8', name: 'Accessible Authentication (Minimum)', level: 'AA', principle: 'Understandable', guideline: '3.3 Input Assistance', pdfApplicable: false, pdfReason: 'Authentication flows do not exist within a static PDF document. (New in 2.2.)', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Not applicable to PDFs (no auth step inside the document); N/A.' },
  { sc: '4.1.3', name: 'Status Messages', level: 'AA', principle: 'Robust', guideline: '4.1 Compatible', pdfApplicable: false, pdfReason: 'Programmatic status messages require scripted dynamic content; not present in static PDFs.', evidenceSource: 'n/a-static-pdf', machineDecidability: 'human-only', checkNote: 'Only relevant to scripted PDFs that surface dynamic status; otherwise N/A.' },
];

/** The 11 live-UI rule areas (the demo's sidebar). Each groups one or more SCs under a review lens. */
export type RuleAreaId =
  | 'checklist'
  | 'reading-order'
  | 'color-contrast'
  | 'table-semantics'
  | 'links'
  | 'non-text-artifact'
  | 'headings-metadata'
  | 'keyboard-focus-order'
  | 'use-of-color'
  | 'forms'
  | 'tag-structure';

export interface RuleArea {
  id: RuleAreaId;
  label: string;
  scRefs: string[];
  primaryStandard: 'pdfua' | 'wcag';
  evidenceSource: EvidenceSource;
  defaultStatus: 'pending' | 'pending-human-review';
}

/** The rule-area groupings rendered as the left sidebar + per-rule evidence views. */
export const RULE_AREAS: RuleArea[] = [
  { id: 'checklist', label: 'Compliance Checklist', scRefs: ['1.1.1', '1.3.1', '1.3.2', '1.4.3', '2.4.2', '3.1.1', '4.1.2'], primaryStandard: 'pdfua', evidenceSource: 'validator-verapdf-pac', defaultStatus: 'pending' },
  { id: 'reading-order', label: 'Reading Order', scRefs: ['1.3.2', '2.4.3'], primaryStandard: 'wcag', evidenceSource: 'reading-order-vlm', defaultStatus: 'pending-human-review' },
  { id: 'color-contrast', label: 'Color Contrast', scRefs: ['1.4.3'], primaryStandard: 'wcag', evidenceSource: 'contrast-facet', defaultStatus: 'pending-human-review' },
  { id: 'table-semantics', label: 'Table Semantics', scRefs: ['1.3.1'], primaryStandard: 'pdfua', evidenceSource: 'byte-probe-structure', defaultStatus: 'pending' },
  { id: 'links', label: 'Links', scRefs: ['2.4.4', '4.1.2'], primaryStandard: 'wcag', evidenceSource: 'byte-probe-structure', defaultStatus: 'pending' },
  { id: 'non-text-artifact', label: 'Non-text / Artifact Marking', scRefs: ['1.1.1'], primaryStandard: 'wcag', evidenceSource: 'alt-text-vlm', defaultStatus: 'pending-human-review' },
  { id: 'headings-metadata', label: 'Headings & Metadata', scRefs: ['2.4.2', '2.4.6', '3.1.1'], primaryStandard: 'wcag', evidenceSource: 'metadata', defaultStatus: 'pending' },
  { id: 'keyboard-focus-order', label: 'Keyboard / Focus Order', scRefs: ['2.1.1', '2.4.3'], primaryStandard: 'wcag', evidenceSource: 'byte-probe-structure', defaultStatus: 'pending' },
  { id: 'use-of-color', label: 'Use of Color', scRefs: ['1.4.1', '1.4.11'], primaryStandard: 'wcag', evidenceSource: 'human-only', defaultStatus: 'pending-human-review' },
  { id: 'forms', label: 'Forms', scRefs: ['3.3.2', '4.1.2'], primaryStandard: 'wcag', evidenceSource: 'byte-probe-structure', defaultStatus: 'pending' },
  { id: 'tag-structure', label: 'Tag Structure (PDF/UA)', scRefs: ['1.3.1', '1.3.2'], primaryStandard: 'pdfua', evidenceSource: 'validator-verapdf-pac', defaultStatus: 'pending' },
];

/** O(1) SC lookup by code (e.g. "1.4.3") for the rollup. */
export const SC_BY_CODE: Map<string, WcagSc> = new Map(WCAG_22_AA.map((sc) => [sc.sc, sc]));

/**
 * The template SCs the coordinator's deterministic audit currently produces a CriterionFinding for
 * (runAudit → criterion111/131/132/143/242/412). Every OTHER pdfApplicable SC maps to a human-only
 * escalation this build (the rollup marks it cannot_tell + needs_human rather than guessing).
 */
export const MACHINE_BACKED_SC: Set<string> = new Set(['1.1.1', '1.3.1', '1.3.2', '1.4.3', '2.4.2', '4.1.2']);
