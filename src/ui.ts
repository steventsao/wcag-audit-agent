// ui.ts — the LIVE agent session for the PDF accessibility audit. This is NOT a dashboard: it is one
// conversation thread. The A11yAgent narrates its progress AS messages (driven by report.events), its
// findings appear as soft inline cards (report.wcag), and the human can comment / ask questions inline —
// the agent replies over the same live setState broadcast (report.chat + report.thinking). State arrives
// over the cloudflare/agents WebSocket (/agents/a11y-agent/:id, cf_agent_state) with a /v2/audit-status
// poll fallback. Served at GET /ui?id= and /app, AND as the ui:// MCP App resource (mcp.ts).
//
// FOOT-GUN: the <script> below contains ZERO backticks and ZERO ${} — string concatenation with single
// quotes only — because an inner backtick would close this outer html=`...` template (surfacing as a
// misleading "Unexpected token" at module load). Keep it that way.

export const UI_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF Accessibility Report · live agent</title>
<style>
  :root{ --ink:#1f2430;--mut:#6b7280;--line:#e6e9ee;--bg:#f3f5f8;--paper:#fff;--head:#17324d;--accent:#0f4f6f;
         --pass:#15803d;--passbg:#e7f6ec;--fail:#b42318;--failbg:#fdecea;--warn:#b45309;--warnbg:#fdf3e3; }
  *{box-sizing:border-box} html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;
       display:flex;flex-direction:column;min-height:100vh}
  .top{display:flex;align-items:center;gap:14px;background:var(--paper);border-bottom:1px solid var(--line);
       padding:11px 18px;position:sticky;top:0;z-index:5}
  .brand{display:flex;flex-direction:column;line-height:1.2}
  .brand .k{font-size:10.5px;letter-spacing:.5px;color:var(--accent);font-weight:800;text-transform:uppercase}
  .brand h1{margin:1px 0 0;font-size:16px;color:var(--head)}
  .spacer{flex:1}
  .starter{display:flex;gap:7px;align-items:center}
  .starter input{width:230px;max-width:40vw;border:1px solid var(--line);border-radius:9px;padding:7px 10px;font:inherit;background:#fbfcfd}
  .starter button{border:0;background:var(--accent);color:#fff;font-weight:700;border-radius:9px;padding:8px 14px;cursor:pointer}
  .dot{font-size:11px;color:var(--mut);white-space:nowrap} .dot b{color:var(--accent)}
  @media(max-width:640px){ .brand h1{font-size:14px} .starter input{width:130px} .dot{display:none} }

  .thread{flex:1;width:100%;max-width:760px;margin:0 auto;padding:22px 16px 130px;display:flex;flex-direction:column;gap:14px}
  .row{display:flex;gap:10px;align-items:flex-start}
  .row.user{flex-direction:row-reverse}
  .av{width:28px;height:28px;border-radius:50%;flex:0 0 28px;display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:800;background:#e6eef3;color:var(--accent)}
  .row.user .av{background:var(--accent);color:#fff}
  .bub{max-width:80%;padding:10px 13px;border-radius:15px;background:var(--paper);border:1px solid var(--line);
       box-shadow:0 1px 2px rgba(16,40,60,.04);white-space:pre-wrap}
  .row.user .bub{background:var(--accent);color:#eaf4fa;border-color:var(--accent)}
  .bub .who{font-size:10.5px;color:var(--mut);font-weight:700;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px}
  .row.user .bub .who{color:#cfe6f0}
  .bub .t{font-size:12px;color:var(--mut);margin-top:3px}
  .row.think .bub{color:var(--mut);font-style:italic}

  .card{max-width:82%;background:var(--paper);border:1px solid var(--line);border-radius:15px;padding:12px 14px}
  .card .h{font-weight:800;color:var(--head);margin-bottom:8px;font-size:14px}
  .chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:8px}
  .chip{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:#eef2f6;color:var(--mut)}
  .chip.pass{background:var(--passbg);color:var(--pass)} .chip.fail{background:var(--failbg);color:var(--fail)} .chip.warn{background:var(--warnbg);color:var(--warn)}
  .flist{display:flex;flex-direction:column;gap:5px}
  .fitem{font-size:13px} .fitem b{color:var(--fail)} .fitem .sc{color:var(--mut);font-weight:600}
  .gate{display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap}
  .gate button{font:inherit;font-weight:700;border-radius:9px;padding:7px 14px;cursor:pointer;border:1px solid}
  .gate .ap{background:var(--passbg);border-color:#a7dcbf;color:var(--pass)} .gate .rj{background:var(--failbg);border-color:#e6b3a9;color:var(--fail)}
  .gatemsg{font-size:13px;color:var(--mut)}

  .composer{position:fixed;left:0;right:0;bottom:0;padding:14px 16px;
            background:linear-gradient(180deg,rgba(243,245,248,0),var(--bg) 36%)}
  .composer .inner{max-width:760px;margin:0 auto;display:flex;gap:9px;background:var(--paper);border:1px solid var(--line);
                   border-radius:16px;padding:7px 7px 7px 14px;box-shadow:0 8px 28px -18px rgba(16,40,60,.5)}
  .composer input{flex:1;border:0;outline:0;font:inherit;padding:8px 0;background:transparent}
  .composer button{border:0;background:var(--accent);color:#fff;font-weight:700;border-radius:11px;padding:9px 18px;cursor:pointer}
</style></head>
<body>
  <header class="top">
    <div class="brand"><span class="k">WCAG 2.2 AA · live agent</span><h1>PDF Accessibility Report</h1></div>
    <span class="spacer"></span>
    <div class="starter">
      <input id="pdf" placeholder="PDF URL to audit"/>
      <button id="run">Audit</button>
    </div>
    <span class="dot" id="conn">idle</span>
  </header>
  <main class="thread" id="thread"></main>
  <div class="composer"><div class="inner">
    <input id="chatin" placeholder="Type a comment or question…" aria-label="Message the agent"/>
    <button id="chatsend">Send</button>
  </div></div>
<script>
  // Injected by the worker at serve time (serveUiHtml / the MCP resource handler). Same-origin (GET /app,
  // /ui) keeps the placeholder and falls back to location.origin.
  var ORIGIN = '__WORKER_ORIGIN__'; if(ORIGIN.indexOf('__')===0){ ORIGIN = location.origin; }
  var qs = new URLSearchParams(location.search);
  var id = qs.get('id') || '';
  var lastReport = null, mode = 'idle';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function setConn(t){ document.getElementById('conn').innerHTML = t; }

  // Turn a terse event name into a one-line piece of agent narration (no raw log strings on screen).
  function humanize(ev){
    ev = String(ev||'');
    if(ev.indexOf('start')>=0) return 'Starting the audit';
    if(ev.indexOf('parse')>=0) return 'Parsing the document';
    if(ev.indexOf('row.ready')>=0 || ev.indexOf('finding')>=0) return 'Logged a finding';
    if(ev.indexOf('rollup')>=0) return 'Rolling up the WCAG criteria';
    if(ev.indexOf('done')>=0 || ev.indexOf('complete')>=0) return 'Finished a step';
    if(ev.indexOf('human')>=0) return 'Flagging this for human review';
    if(ev.indexOf('gate')>=0) return 'Updating the review gate';
    if(ev.indexOf('error')>=0 || ev.indexOf('fail')>=0) return 'Hit an issue';
    return ev.replace(/[._]+/g,' ').replace(/^./,function(c){ return c.toUpperCase(); });
  }

  // Merge the agent's event narration + the chat turns into one time-ordered thread.
  function timeline(r){
    var items = [];
    (r.events||[]).forEach(function(e){
      var detail = e.detail ? String(e.detail) : '';
      items.push({ k:'agent', at:e.at||0, text:(detail || humanize(e.event)), tag:(detail ? humanize(e.event) : '') });
    });
    (r.chat||[]).forEach(function(c){
      items.push({ k:(c.role==='user'?'user':'agent'), at:c.at||0, text:String(c.text||''), tag:'' });
    });
    items.sort(function(a,b){ return (a.at||0)-(b.at||0); });
    return items;
  }

  function bubble(it){
    var isU = it.k==='user';
    var who = isU ? 'You' : 'Agent';
    var av = isU ? 'U' : 'AI';
    var tag = it.tag ? ('<div class="t">'+esc(it.tag)+'</div>') : '';
    return '<div class="row '+it.k+'"><div class="av">'+av+'</div>'+
           '<div class="bub"><div class="who">'+who+'</div>'+esc(it.text)+tag+'</div></div>';
  }

  function findingsCard(r){
    var w = r.wcag; if(!w || !w.summary) return '';
    var s = w.summary, fails = [];
    (w.areas||[]).forEach(function(a){ (a.verdicts||[]).forEach(function(v){
      if(String(v.verdict).toLowerCase().indexOf('fail')>=0) fails.push(v);
    }); });
    var chips = '<span class="chip">'+esc(s.total)+' criteria</span>'+
                '<span class="chip pass">'+esc(s.passed)+' pass</span>'+
                '<span class="chip fail">'+esc(s.failed)+' fail</span>'+
                '<span class="chip warn">'+esc(s.needsHuman)+' needs human</span>'+
                '<span class="chip">'+esc(s.notApplicable)+' n/a</span>';
    var list = '';
    if(fails.length){
      list = '<div class="flist">'+fails.slice(0,6).map(function(v){
        return '<div class="fitem"><b>'+esc(v.sc)+'</b> <span class="sc">'+esc(v.name||'')+'</span></div>';
      }).join('')+'</div>';
    }
    return '<div class="row"><div class="av">AI</div><div class="card"><div class="h">WCAG 2.2 AA results</div>'+
           '<div class="chips">'+chips+'</div>'+list+'</div></div>';
  }

  function gateCard(r){
    var g = r.gate || 'open';
    if(g==='pending_review'){
      return '<div class="row"><div class="av">AI</div><div class="card"><div class="h">Human review needed</div>'+
        '<div class="gatemsg">A machine pass is a pre-assessment. Approve to attest, or reject to send it back.</div>'+
        '<div class="gate"><button class="ap" id="ap">Approve · attest</button><button class="rj" id="rj">Reject</button></div></div></div>';
    }
    if(g==='finalized') return bubble({ k:'agent', text:'Attested — the report is finalized.', tag:'' });
    if(g==='rejected')  return bubble({ k:'agent', text:'Rejected — sending this back for changes.', tag:'' });
    return '';
  }

  function welcome(){
    return bubble({ k:'agent', tag:'', text:'Hi — I audit PDFs for accessibility against WCAG 2.2 AA. Paste a PDF URL up top and hit Audit, or just ask me anything about a document.' });
  }

  function render(d){
    if(d){ lastReport = d.report || d; }
    var r = lastReport;
    var html = '';
    var hasThread = r && ((r.events && r.events.length) || (r.chat && r.chat.length));
    if(!hasThread){ html += welcome(); }
    else {
      html += timeline(r).map(bubble).join('');
      html += findingsCard(r);
      html += gateCard(r);
    }
    if(r && r.thinking){ html += '<div class="row think"><div class="av">AI</div><div class="bub"><div class="who">Agent</div>thinking…</div></div>'; }
    document.getElementById('thread').innerHTML = html;
    var ap = document.getElementById('ap'), rj = document.getElementById('rj');
    if(ap) ap.onclick = function(){ decide('approve'); };
    if(rj) rj.onclick = function(){ decide('reject'); };
    window.scrollTo(0, document.body.scrollHeight);
  }

  function decide(dec){
    if(!id) return;
    fetch(ORIGIN+'/v2/audit-decide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,decision:dec})})
      .then(function(x){ return x.json(); }).then(function(j){ render(j); }).catch(function(){});
  }

  function poll(){
    if(!id) return;
    fetch(ORIGIN+'/v2/audit-status?id='+encodeURIComponent(id)).then(function(x){ return x.json(); })
      .then(function(j){ if(mode!=='live'){ mode='polling'; setConn('<b>live</b>'); } render(j); }).catch(function(){});
  }
  var pt = null;
  function startPolling(){ if(pt) return; poll(); pt = setInterval(poll, 1500); }

  // Live push over the cloudflare/agents WebSocket. Best-effort: if cf_agent_state arrives we render
  // instantly and flip to "live · socket"; if the socket can't open, the poll above covers.
  var ws = null, wsDoc = null;
  function connectWS(d){
    if(!d) return;
    if(ws && wsDoc===d) return;
    if(ws){ try{ ws.close(); }catch(e){} ws = null; }
    wsDoc = d;
    try{
      var u = ORIGIN.replace(/^http/,'ws') + '/agents/a11y-agent/' + encodeURIComponent(d);
      ws = new WebSocket(u);
      ws.onmessage = function(ev){
        if(wsDoc !== id) return;
        var m; try{ m = JSON.parse(ev.data); }catch(e){ return; }
        if(m && m.type==='cf_agent_state' && m.state){ mode='live'; setConn('<b>live</b> · socket'); render({ report:m.state }); }
      };
      ws.onclose = function(){ ws = null; };
      ws.onerror = function(){ try{ ws.close(); }catch(e){} };
    }catch(e){}
  }
  function connectLive(d){ if(!d) return; startPolling(); connectWS(d); }
  function start(d){ if(!d) return; id = d; history.replaceState(null,'','?id='+encodeURIComponent(d)); poll(); connectLive(d); }

  function sendChat(){
    var inp = document.getElementById('chatin'); var t = inp.value.trim();
    if(!t) return; inp.value = '';
    if(!id){ id = 'chat-'+Date.now(); history.replaceState(null,'','?id='+encodeURIComponent(id)); connectLive(id); }
    if(!lastReport) lastReport = { events:[], chat:[] };
    lastReport.chat = (lastReport.chat||[]).concat([{ role:'user', text:t, at:Date.now() }]); lastReport.thinking = true;
    render(null);
    fetch(ORIGIN+'/v2/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,text:t})})
      .then(function(x){ return x.json(); }).then(function(j){ render(j); })
      .catch(function(){ if(lastReport){ lastReport.thinking=false; render(null); } });
  }

  function runAudit(){
    var pdf = document.getElementById('pdf').value.trim(); if(!pdf) return;
    if(!id){ id = 'run-'+Date.now(); history.replaceState(null,'','?id='+encodeURIComponent(id)); }
    setConn('auditing…');
    if(!lastReport) lastReport = { events:[], chat:[] };
    lastReport.events = (lastReport.events||[]).concat([{ at:Date.now(), event:'audit.start', detail:'Starting the audit on the PDF you gave me…' }]);
    render(null);
    fetch(ORIGIN+'/v2/remediate-wf',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pdf_url:pdf,id:id})})
      .then(function(x){ return x.json(); }).then(function(j){ render(j); connectLive(id); }).catch(function(){ setConn('error'); });
  }

  document.getElementById('run').onclick = runAudit;
  document.getElementById('pdf').addEventListener('keydown', function(e){ if(e.key==='Enter'){ runAudit(); } });
  document.getElementById('chatsend').onclick = sendChat;
  document.getElementById('chatin').addEventListener('keydown', function(e){ if(e.key==='Enter'){ sendChat(); } });

  // MCP App host bridge: the host delivers the tool result (structuredContent) via postMessage. SECURITY:
  // never render the posted payload — require our OWN report-summary shape, bind the docId only on first
  // delivery, and ALWAYS fetch authoritative state from the worker, never trust e.data.
  window.addEventListener('message', function(e){
    var p = e.data; if(!p || typeof p!=='object') return;
    var sc = p.structuredContent || (p.result && p.result.structuredContent) || (p.toolResult && p.toolResult.structuredContent) || (p.params && p.params.structuredContent);
    if(!sc || typeof sc!=='object' || typeof sc.id!=='string') return;
    if(!('gate' in sc) && !('wcag' in sc) && !('criteria' in sc)) return;
    if(!id) start(sc.id);
    else if(sc.id===id) poll();
  });

  setConn(id ? 'connecting…' : 'idle');
  render(null);
  if(id) start(id);
</script>
</body></html>`;
