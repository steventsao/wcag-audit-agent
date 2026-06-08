// ui.ts — the LIVE WCAG accessibility report. Phases across the top (Audit source PDF · Create HTML ·
// Review PDF), a STANDARDS dropdown (WCAG 2.2 AA / PDF-UA) + rule-area sidebar on the left, and per-area
// success-criterion evidence in the main panel — driven by the LIVE A11yAgent report state, not static JSON.
//
// Data: report.wcag (the WCAG 2.2 AA rollup the WcagAgent emits — areas[] + per-SC verdicts + summary),
// report.pipeline.audit, report.gate, report.events. The UI polls /v2/audit-status so the MCP resource is
// self-contained (no external module import or host CSP surprise); Run → /v2/audit-a11y; Approve/Reject →
// /v2/audit-decide. Served at GET /ui?id= and /app, AND as the ui:// MCP App resource (mcp.ts) — in an
// MCP host it reads the docId from the host tool result (structuredContent) postMessage.
//
// FOOT-GUN: the <script> below uses ZERO backticks/template
// literals and ZERO ${} — string concatenation only — because an inner backtick would close this outer
// html=`...` template (surfacing as a misleading "Unexpected token" at module load). Keep it that way.

export const UI_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WCAG Audit Agent · accessibility report</title>
<style>
  :root{ --ink:#1f2430;--mut:#6b7280;--line:#e7e3da;--bg:#eef2f6;--paper:#fff;--head:#17324d;--teal:#0f4f6f;
         --pass:#15803d;--passbg:#dcfce7;--fail:#b42318;--failbg:#fee2e2;--warn:#b45309;--warnbg:#fef3c7;
         --na:#6b7280;--nabg:#eef2f6;--accent:#0f4f6f;--sel:#0f4f6f;--th:#f3f6f9; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
  /* ── header: title + phase tabs ── */
  .app-header{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;
    background:var(--paper);border-bottom:1px solid var(--line);padding:13px 22px}
  .title-block .product{margin:0;color:var(--teal);font-weight:800;font-size:12px;letter-spacing:.3px}
  .title-block h1{margin:1px 0 0;font-size:19px;color:var(--head)}
  .facet-tabs{display:flex;gap:6px;flex-wrap:wrap}
  .facet-tabs button{display:flex;align-items:center;gap:8px;background:#f6f8fa;border:1px solid var(--line);
    color:var(--mut);border-radius:8px;padding:7px 13px;font:inherit;cursor:pointer}
  .facet-tabs button.selected{background:var(--paper);color:var(--head);border-color:#bcd3e0;box-shadow:0 1px 0 #cfe0ec inset;font-weight:700}
  .facet-tabs button:disabled{opacity:.55;cursor:default}
  .facet-step{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;
    background:#dde6ec;color:#3f5a6d;font-size:11px;font-weight:800}
  .facet-tabs button.selected .facet-step{background:var(--sel);color:#fff}
  .facet-tabs button.done .facet-step{background:var(--pass);color:#fff}
  /* ── connection / controls strip ── */
  .controls{display:flex;gap:9px;align-items:center;flex-wrap:wrap;background:#0f2233;color:#cfe0ec;padding:8px 22px}
  .controls input{background:#0a1722;border:1px solid #244157;color:#dce7ef;padding:5px 9px;border-radius:6px;font:inherit}
  .controls input.pdf{flex:0 1 320px;min-width:150px} .controls .grow{flex:1}
  .controls button{background:#37c0e8;border:0;color:#04222e;font-weight:700;padding:6px 13px;border-radius:6px;cursor:pointer}
  #conn{font-size:11px;color:#7d96a8} #conn b{color:#37c0e8}
  /* ── shell: sidebar + view ── */
  .app-shell{display:grid;grid-template-columns:248px minmax(0,1fr);gap:0;align-items:start}
  @media(max-width:820px){.app-shell{grid-template-columns:1fr}}
  .rule-sidebar{border-right:1px solid var(--line);background:var(--paper);min-height:80vh;padding:16px 14px}
  .side-section-title{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--mut);font-weight:700}
  .standards-control{margin:7px 0 4px}
  .standards-select{width:100%;font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:#fafcfd;color:var(--head);font-weight:700}
  .standards-control p{margin:6px 0 2px;color:var(--mut);font-size:12px}
  .rule-nav{display:flex;flex-direction:column;gap:7px;margin-top:14px}
  .rule-nav button{text-align:left;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:9px 11px;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:3px}
  .rule-nav button.selected{border-color:var(--sel);box-shadow:0 0 0 1px var(--sel) inset}
  .rule-nav-label{font-weight:700;color:var(--head)}
  .rule-nav-ref{font-size:11.5px;color:var(--mut)}
  .view-shell{padding:18px 22px}
  .coverage-panel{background:var(--paper);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 40px -30px rgba(15,34,51,.4);overflow:hidden}
  .toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);background:#fafcfd}
  .toolbar span{font-weight:800;color:var(--head)} .toolbar code{font-size:11.5px;color:var(--mut)}
  .coverage-summary{padding:12px 16px;border-bottom:1px solid var(--line)}
  .coverage-summary strong{display:block;color:var(--head)} .coverage-summary span{color:var(--mut);font-size:12.5px}
  .summary-grid{display:flex;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
  .summary-card{background:#fafcfd;border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-width:78px}
  .summary-card b{display:block;font-size:18px;color:var(--head)} .summary-card span{color:var(--mut);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}
  table{border-collapse:collapse;width:100%;font-size:13px} th,td{border-bottom:1px solid var(--line);padding:9px 16px;text-align:left;vertical-align:top}
  th{background:var(--th);color:#20364d;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  tr.click{cursor:pointer} tr.click:hover{background:#f6f9fb}
  .st{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
  .st.pass,.st.passed{background:var(--passbg);color:var(--pass)} .st.fail,.st.failed{background:var(--failbg);color:var(--fail)}
  .st.review,.st.pending-human-review,.st.cannot_tell,.st.human{background:var(--warnbg);color:var(--warn)}
  .st.na,.st.not_present,.st.deferred{background:var(--nabg);color:var(--na)} .st.draft{background:#e8f1fb;color:#1f6f9e}
  .scname{color:var(--mut);font-weight:400} .src{font-size:11px;color:var(--mut)}
  .rationale{color:var(--mut);font-size:12.5px;margin:2px 0 0}
  .gate{font-size:12px;font-weight:800;padding:4px 12px;border-radius:999px}
  .gate.pending_review{background:var(--warnbg);color:var(--warn)} .gate.finalized{background:var(--passbg);color:var(--pass)}
  .gate.rejected{background:var(--failbg);color:var(--fail)} .gate.open{background:var(--nabg);color:var(--na)}
  .acts{display:flex;gap:9px;padding:12px 16px;border-top:1px solid var(--line)}
  .acts button{font:inherit;font-weight:700;padding:8px 15px;border-radius:8px;cursor:pointer;border:1px solid}
  .ap{background:var(--passbg);border-color:#a7dcbf;color:var(--pass)} .rj{background:var(--failbg);border-color:#e6b3a9;color:var(--fail)}
  .empty{color:var(--mut);padding:34px 16px;text-align:center}
  .note{color:var(--mut);font-size:12.5px;padding:0 16px 14px}
  .stream{margin:14px 0 30px;background:#0f2233;border-radius:12px;padding:13px 16px;color:#cfe0ec}
  .stream h4{margin:0 0 9px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#7d96a8}
  .ev{font-size:12px;border-left:2px solid #2a4259;padding:2px 0 2px 10px;margin:0 0 6px} .ev b{color:#dce7ef;font-weight:600} .ev .d{color:#8ba6bb;display:block;font-size:11px}
  .ev.human b{color:#ffe1a3} .ev.done b{color:#bff0d4}
</style></head>
<body>
  <header class="app-header">
    <div class="title-block">
      <p class="product">WCAG audit · rule review</p>
      <h1>PDF Accessibility Evidence</h1>
    </div>
    <div class="facet-tabs" id="phases"></div>
  </header>
  <div class="controls">
    <span id="conn">idle</span>
    <span class="grow"></span>
    <input id="doc" placeholder="docId" style="width:130px"/>
    <input id="pdf" class="pdf" placeholder="public pdf url" value="https://arxiv.org/pdf/1411.1784"/>
    <button id="run">Audit ▸</button>
  </div>
  <div class="app-shell">
    <aside class="rule-sidebar">
      <span class="side-section-title">Standards</span>
      <div class="standards-control">
        <select class="standards-select" id="std" aria-label="Standards">
          <option value="wcag">WCAG 2.2 AA</option>
          <option value="pdfua">PDF/UA</option>
        </select>
        <p id="stdsum">Evidence grouped by applicable WCAG success criteria.</p>
      </div>
      <nav class="rule-nav" id="nav"></nav>
    </aside>
    <section class="view-shell">
      <div id="view"><div class="coverage-panel"><div class="empty">Enter a docId or hit Audit to load a live WCAG report.</div></div></div>
      <div class="stream"><h4>Event stream</h4><div id="events"><span style="color:#7d96a8">—</span></div></div>
    </section>
  </div>
<script>
  // Injected by the worker at serve time (see serveUiHtml in index.ts / the MCP resource handler). When the
  // page is loaded same-origin (GET /app, /ui) the placeholder stays and we fall back to location.origin.
  var ORIGIN = "__WORKER_ORIGIN__"; if(ORIGIN.indexOf("__")===0){ ORIGIN = location.origin; }
  var qs = new URLSearchParams(location.search);
  var id = qs.get("id") || "";
  var docEl = document.getElementById("doc"); docEl.value = id;
  var mode = "idle";
  var activeStandard = "wcag";
  var activeArea = "checklist";
  var activePhase = "audit";
  var lastReport = null;

  var PHASES = [["audit","1","Audit source PDF"],["create-html","2","Create HTML"],["review-pdf","3","Review PDF"]];
  var STD_SUMMARY = { wcag: "Evidence grouped by applicable WCAG success criteria.", pdfua: "Structure tree, artifacting, metadata, and validator-oriented checks." };

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];}); }
  function setConn(t){ document.getElementById("conn").innerHTML = t; }
  function stClass(s){ return String(s==null?"":s).toLowerCase().replace(/[^a-z_-]+/g,"-"); }
  function stLabel(s){ if(s==="pending-human-review") return "review"; if(s==="not_present") return "n/a"; if(s==="cannot_tell") return "needs human"; return String(s==null?"":s).replace(/_/g," "); }

  function reportOf(d){ if(!d) return null; return d.report || d; }
  function areasFor(r){
    var all = (r && r.wcag && r.wcag.areas) ? r.wcag.areas : [];
    if(activeStandard==="pdfua") return all.filter(function(a){ return a.primaryStandard==="pdfua"; });
    return all;
  }

  function renderPhases(r){
    var steps = {}; (r && r.steps ? r.steps : []).forEach(function(s){ steps[s.step]=s.status; });
    var pipe = r && r.pipeline ? r.pipeline : {};
    var done = { "audit": steps.audit==="done" || !!pipe.audit,
                 "create-html": steps["create-html"]==="done" || steps.remediate==="done" || !!pipe.html,
                 "review-pdf": steps["review-pdf"]==="done" || steps.compare==="done" || !!pipe.comparison };
    var html = "";
    PHASES.forEach(function(p){
      var cls = (activePhase===p[0]?"selected":"") + (done[p[0]]?" done":"");
      html += "<button class=\\""+cls+"\\" data-phase=\\""+p[0]+"\\"><span class=\\"facet-step\\">"+p[1]+"</span><span>"+p[2]+"</span></button>";
    });
    document.getElementById("phases").innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll("#phases button"), function(b){
      b.onclick = function(){ activePhase = b.getAttribute("data-phase"); render(lastReport); };
    });
  }

  function renderNav(r){
    document.getElementById("std").value = activeStandard;
    document.getElementById("stdsum").textContent = STD_SUMMARY[activeStandard] || "";
    var areas = areasFor(r);
    var stdLabel = activeStandard==="pdfua" ? "PDF/UA" : "WCAG 2.2 AA";
    var html = "<button class=\\""+(activeArea==="checklist"?"selected":"")+"\\" data-area=\\"checklist\\">"+
      "<span class=\\"rule-nav-label\\">Checklist</span><span class=\\"rule-nav-ref\\">"+esc(stdLabel)+"</span></button>";
    areas.forEach(function(a){
      html += "<button class=\\""+(activeArea===a.id?"selected":"")+"\\" data-area=\\""+esc(a.id)+"\\">"+
        "<span class=\\"rule-nav-label\\">"+esc(a.label)+"</span>"+
        "<span class=\\"rule-nav-ref\\">"+esc((a.verdicts||[]).map(function(v){return v.sc;}).join(" / ")||"—")+"</span>"+
        "<span class=\\"st "+stClass(a.status)+"\\">"+esc(stLabel(a.status))+"</span></button>";
    });
    document.getElementById("nav").innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll("#nav button"), function(b){
      b.onclick = function(){ activeArea = b.getAttribute("data-area"); render(lastReport); };
    });
  }

  function gatePill(gate){ return "<span class=\\"gate "+esc(gate)+"\\">"+esc(String(gate).replace("_"," "))+"</span>"; }

  function summaryGrid(w){
    if(!w || !w.summary) return "";
    var s = w.summary;
    function card(l,v){ return "<div class=\\"summary-card\\"><b>"+esc(v)+"</b><span>"+esc(l)+"</span></div>"; }
    return "<div class=\\"summary-grid\\">"+card("Total",s.total)+card("Pass",s.passed)+card("Fail",s.failed)+card("Need human",s.needsHuman)+card("N/A",s.notApplicable)+"</div>";
  }

  function phaseCards(cards){
    if(!cards || !cards.length) return "";
    return "<div class=\\"summary-grid\\">"+cards.map(function(c){
      return "<div class=\\"summary-card\\"><b>"+esc(c.value)+"</b><span>"+esc(c.label)+"</span></div>";
    }).join("")+"</div>";
  }

  function phaseRows(rows){
    if(!rows || !rows.length) return "<div class=\\"empty\\">No phase evidence yet.</div>";
    return "<table><thead><tr><th>Area</th><th>Refs</th><th>Status</th><th>Evidence</th></tr></thead><tbody>"+rows.map(function(row){
      return "<tr><td><b>"+esc(row.area)+"</b>"+(row.rationale?"<div class=\\"rationale\\">"+esc(row.rationale)+"</div>":"")+"</td>"+
        "<td class=\\"src\\">"+esc((row.refs||[]).join(" / ")||"—")+"</td>"+
        "<td><span class=\\"st "+stClass(row.status)+"\\">"+esc(stLabel(row.status))+"</span><div class=\\"src\\">"+esc(row.source||"")+"</div></td>"+
        "<td>"+esc(row.evidence||"")+"</td></tr>";
    }).join("")+"</tbody></table>";
  }

  function viewCreateHtml(r){
    var h = r && r.pipeline ? r.pipeline.html : null;
    if(!h){
      return panel("Create HTML", "Shadow HTML", "Create the accessible browser alternate.",
        "This phase will emit cited content-layer rows, semantic HTML, and the tag plan after the full pipeline runs.",
        "<div class=\\"empty\\">No Create HTML evidence yet. Run the full workflow to create the HTML draft.</div>");
    }
    var copy = h.html ? "<div class=\\"acts\\"><button class=\\"ap\\" id=\\"copyhtml\\">Copy HTML</button></div>" : "";
    return panelRaw("Create HTML "+gatePill(h.status||"draft"), "Shadow HTML",
      "Cited content layer and semantic HTML draft.",
      h.note || "Accessible alternate generated from audit evidence. Human review is required before attestation.",
      phaseCards(h.summaryCards)+phaseRows(h.rows)+copy);
  }

  function viewReviewPdf(r, gate){
    var c = r && r.pipeline ? r.pipeline.comparison : null;
    if(!c){
      return panel("Review PDF", "PDF/UA", "Review emitted candidate PDF and attestation evidence.",
        "This phase validates a supplied or generated fixed PDF. Without a V2, it records the blocker and keeps the human gate explicit.",
        "<div class=\\"empty\\">No Review PDF evidence yet.</div>");
    }
    var rows = [
      { area:"Validation delta", refs:["WCAG structural criteria"], status:c.validation_delta.after==null?"deferred":"passed", source:"machine", evidence:c.validation_delta.note },
      { area:"Visual parity", refs:["export snapshot"], status:c.visual_parity==="deferred"?"deferred":"passed", source:"deferred", evidence:"Pixel parity: "+c.visual_parity }
    ];
    var body = phaseRows(rows) + (gate==="pending_review" ? "<div class=\\"acts\\"><button class=\\"ap\\" id=\\"ap\\">✓ Approve · attest</button><button class=\\"rj\\" id=\\"rj\\">✕ Reject</button></div>" : "");
    return panelRaw("Review PDF "+gatePill(gate), "PDF/UA",
      "Validate the emitted candidate and resolve the human gate.",
      "A fixed PDF must be re-audited before any remediated PDF claim. The HTML alternate remains a draft until attested.",
      body);
  }

  function viewChecklist(r, gate){
    var w = r.wcag;
    var stdLabel = activeStandard==="pdfua" ? "PDF/UA" : "WCAG 2.2 AA";
    if(activePhase==="create-html") return viewCreateHtml(r);
    if(activePhase==="review-pdf") return viewReviewPdf(r, gate);
    if(!w || !w.areas || !w.areas.length){
      return panel("Audit source PDF", stdLabel, "Run the audit to populate the WCAG 2.2 AA rollup.",
        "Each rule area maps applicable success criteria to machine evidence; a machine PASS is a pre-assessment until the human gate is signed off.",
        "<div class=\\"empty\\">No audit yet — hit Audit ▸.</div>");
    }
    var areas = areasFor(r);
    var rows = "";
    areas.forEach(function(a){
      rows += "<tr class=\\"click\\" data-area=\\""+esc(a.id)+"\\"><td><b>"+esc(a.label)+"</b></td>"+
        "<td>"+esc((a.verdicts||[]).map(function(v){return v.sc;}).join(" / ")||"—")+"</td>"+
        "<td><span class=\\"st "+stClass(a.status)+"\\">"+esc(stLabel(a.status))+"</span></td></tr>";
    });
    var body = summaryGrid(w) +
      "<table><thead><tr><th>Rule area</th><th>Success criteria</th><th>Status</th></tr></thead><tbody>"+rows+"</tbody></table>" +
      (gate==="pending_review" ? "<div class=\\"acts\\"><button class=\\"ap\\" id=\\"ap\\">✓ Approve · attest</button><button class=\\"rj\\" id=\\"rj\\">✕ Reject</button></div>" : "");
    return panelRaw("Audit source PDF "+gatePill(gate), stdLabel,
      "Audit the received source PDF against "+esc(stdLabel)+".",
      "Each row maps applicable success criteria to machine evidence. A machine PASS is a pre-assessment; attestation flips only at the human gate.",
      body);
  }

  function viewArea(r, gate){
    var w = r.wcag; if(!w) return viewChecklist(r, gate);
    var area = (w.areas||[]).filter(function(a){return a.id===activeArea;})[0];
    if(!area) return viewChecklist(r, gate);
    var rows = "";
    (area.verdicts||[]).forEach(function(v){
      rows += "<tr><td><b>"+esc(v.sc)+"</b> <span class=\\"scname\\">"+esc(v.name)+"</span><div class=\\"rationale\\">"+esc(v.rationale||"")+"</div></td>"+
        "<td><span class=\\"st "+stClass(v.verdict)+"\\">"+esc(stLabel(v.verdict))+"</span>"+(v.needs_human?" <span class=\\"st human\\">needs human</span>":"")+"</td>"+
        "<td class=\\"src\\">"+esc(v.source==="machine" ? ("machine"+(v.via?(" · "+v.via):"")) : "human review")+"</td></tr>";
    });
    var body = "<table><thead><tr><th>Success criterion</th><th>Verdict</th><th>Source</th></tr></thead><tbody>"+rows+"</tbody></table>";
    return panelRaw(esc(area.label), (area.primaryStandard==="pdfua"?"PDF/UA":"WCAG 2.2 AA"),
      "Per-criterion evidence for "+esc(area.label)+".",
      "Machine verdicts are pre-assessments; human-only criteria escalate to the attestation gate.", body);
  }

  function panel(title, code, sumT, sumC, body){ return panelRaw(esc(title), esc(code), sumT, sumC, body); }
  function panelRaw(titleHtml, code, sumT, sumC, body){
    return "<div class=\\"coverage-panel\\"><div class=\\"toolbar\\"><span>"+titleHtml+"</span><code>"+esc(code)+"</code></div>"+
      "<div class=\\"coverage-summary\\"><strong>"+esc(sumT)+"</strong><span>"+esc(sumC)+"</span></div>"+body+"</div>";
  }

  function renderEvents(r){
    var ev = (r && r.events) ? r.events : [];
    document.getElementById("events").innerHTML = ev.length ? ev.slice().reverse().map(function(e){
      var cls = (e.event && e.event.indexOf("human")===0) ? "human" : ((e.event && e.event.indexOf(".done")>0) ? "done" : "");
      return "<div class=\\"ev "+cls+"\\"><b>"+esc(e.event)+"</b>"+(e.detail?"<span class=\\"d\\">"+esc(e.detail)+"</span>":"")+"</div>";
    }).join("") : "<span style=\\"color:#7d96a8\\">no events yet</span>";
  }

  function render(d){
    var r = reportOf(d); if(!r) return; lastReport = r;
    var gate = r.gate || "open";
    renderPhases(r); renderNav(r);
    var html = (activeArea==="checklist") ? viewChecklist(r, gate) : viewArea(r, gate);
    document.getElementById("view").innerHTML = html;
    var ap = document.getElementById("ap"), rj = document.getElementById("rj");
    if(ap) ap.onclick = function(){ decide("approve"); };
    if(rj) rj.onclick = function(){ decide("reject"); };
    var copyHtml = document.getElementById("copyhtml");
    if(copyHtml) copyHtml.onclick = function(){
      var h = lastReport && lastReport.pipeline ? lastReport.pipeline.html : null;
      if(h && h.html && navigator.clipboard) navigator.clipboard.writeText(h.html);
    };
    Array.prototype.forEach.call(document.querySelectorAll("tr.click"), function(tr){
      tr.onclick = function(){ activeArea = tr.getAttribute("data-area"); render(lastReport); };
    });
    renderEvents(r);
  }

  function decide(dec){
    var d = docEl.value || id; if(!d) return;
    fetch(ORIGIN+"/v2/audit-decide",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:d,decision:dec})})
      .then(function(x){return x.json();}).then(function(j){ render(j); }).catch(function(){});
  }
  function poll(){
    var d = docEl.value || id; if(!d) return;
    fetch(ORIGIN+"/v2/audit-status?id="+encodeURIComponent(d)).then(function(x){return x.json();})
      .then(function(j){ if(mode!=="live"){ mode="polling"; setConn("mode: <b>polling</b>"); } render(j); }).catch(function(){});
  }
  var pt = null;
  function startPolling(){ if(pt) return; poll(); pt = setInterval(poll, 1800); }
  function connectLive(d){ if(!d) return; startPolling(); }
  function start(d){ if(!d) return; id=d; docEl.value=d; history.replaceState(null,"","?id="+encodeURIComponent(d)); poll(); connectLive(d); }

  document.getElementById("run").onclick = function(){
    var pdf = document.getElementById("pdf").value, d = docEl.value || ("run-"+Date.now());
    docEl.value = d; id = d; history.replaceState(null,"","?id="+encodeURIComponent(d));
    setConn("auditing…");
    fetch(ORIGIN+"/v2/remediate-wf",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pdf_url:pdf,id:d})})
      .then(function(x){return x.json();}).then(function(j){ render(j); connectLive(d); }).catch(function(){ setConn("error"); });
  };
  document.getElementById("std").onchange = function(e){ activeStandard = e.target.value; activeArea = "checklist"; render(lastReport); };

  // MCP App host bridge: the host delivers the tool result (structuredContent) via postMessage. SECURITY
  // (review P2): never render the posted payload — an embedder that frames /ui could otherwise spoof an
  // "all passed / finalized" report in the trusted chrome — and never let an unsolicited message re-point
  // an already-bound viewer. Require our OWN report-summary shape, bind the docId only on first delivery,
  // and ALWAYS fetch authoritative state from the worker (start→poll / poll hit ORIGIN), never trust e.data.
  window.addEventListener("message", function(e){
    var p = e.data; if(!p || typeof p!=="object") return;
    var sc = p.structuredContent || (p.result && p.result.structuredContent) || (p.toolResult && p.toolResult.structuredContent) || (p.params && p.params.structuredContent);
    if(!sc || typeof sc!=="object" || typeof sc.id!=="string") return;
    if(!("gate" in sc) && !("wcag" in sc) && !("criteria" in sc)) return; // must look like our report summary
    if(!id) start(sc.id);               // bind once (first host delivery); no forced re-redirect afterward
    else if(sc.id===id) poll();         // same doc → refresh from the authoritative worker, not from sc
  });

  renderPhases(null); renderNav(null); setConn(id?"connecting…":"idle");
  if(id) start(id);
</script>
</body></html>`;
