// ui.ts — the LIVE agent session as a full-viewport app shell (no page scroll). LEFT panel: the
// conversation — the A11yAgent narrates its progress as messages (report.events) and the human comments /
// asks inline, the agent replying live (report.chat/thinking); this panel scrolls on its own. RIGHT panel:
// the report artifact that builds beside the chat (report.wcag findings + gate), scrolling independently.
// State arrives over the cloudflare/agents WebSocket (/agents/a11y-agent/:id, cf_agent_state) with a
// /v2/audit-status poll fallback. Served at GET /ui?id= and /app, AND as the ui:// MCP App resource.
//
// FOOT-GUN: the <script> below contains ZERO backticks and ZERO ${} — single-quoted string concatenation
// only — because an inner backtick would close this outer html=`...` template. Keep it that way.

export const UI_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF Accessibility Report · live agent</title>
<style>
  :root{ --ink:#1f2430;--mut:#6b7280;--line:#e6e9ee;--bg:#f3f5f8;--paper:#fff;--head:#17324d;--accent:#0f4f6f;
         --pass:#15803d;--passbg:#e7f6ec;--fail:#b42318;--failbg:#fdecea;--warn:#b45309;--warnbg:#fdf3e3; }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{height:100dvh;overflow:hidden;background:var(--bg);color:var(--ink);
       font:15px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;display:flex;flex-direction:column}

  /* header */
  .top{flex:0 0 auto;display:flex;align-items:center;gap:14px;background:var(--paper);
       border-bottom:1px solid var(--line);padding:10px 18px}
  .brand{display:flex;flex-direction:column;line-height:1.2}
  .brand .k{font-size:10.5px;letter-spacing:.5px;color:var(--accent);font-weight:800;text-transform:uppercase}
  .brand h1{margin:1px 0 0;font-size:16px;color:var(--head)}
  .spacer{flex:1}
  .starter{display:flex;gap:7px;align-items:center}
  .starter input{width:240px;max-width:38vw;border:1px solid var(--line);border-radius:9px;padding:7px 10px;font:inherit;background:#fbfcfd}
  .starter button{border:0;background:var(--accent);color:#fff;font-weight:700;border-radius:9px;padding:8px 14px;cursor:pointer}
  .dot{font-size:11px;color:var(--mut);white-space:nowrap} .dot b{color:var(--accent)}

  /* full-height shell: left conversation + right report, each its own scroll region */
  .shell{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(340px,420px) 1fr}
  .side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line);background:var(--paper)}
  .thread{flex:1 1 auto;min-height:0;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:12px}
  .composer{flex:0 0 auto;border-top:1px solid var(--line);padding:11px 12px;background:var(--paper)}
  .composer .inner{display:flex;gap:8px;background:#fbfcfd;border:1px solid var(--line);border-radius:13px;padding:5px 5px 5px 12px}
  .composer input{flex:1;border:0;outline:0;font:inherit;padding:8px 0;background:transparent}
  .composer button{border:0;background:var(--accent);color:#fff;font-weight:700;border-radius:10px;padding:9px 16px;cursor:pointer}
  .main{min-height:0;overflow-y:auto;padding:20px;background:var(--bg)}

  /* conversation bubbles */
  .row{display:flex;gap:10px;align-items:flex-start}
  .row.user{flex-direction:row-reverse}
  .av{width:26px;height:26px;border-radius:50%;flex:0 0 26px;display:flex;align-items:center;justify-content:center;
      font-size:10px;font-weight:800;background:#e6eef3;color:var(--accent)}
  .row.user .av{background:var(--accent);color:#fff}
  .bub{max-width:84%;padding:9px 12px;border-radius:14px;background:#f7f9fb;border:1px solid var(--line);white-space:pre-wrap}
  .row.user .bub{background:var(--accent);color:#eaf4fa;border-color:var(--accent)}
  .bub .who{font-size:10px;color:var(--mut);font-weight:700;margin-bottom:2px;text-transform:uppercase;letter-spacing:.3px}
  .row.user .bub .who{color:#cfe6f0}
  .bub .t{font-size:11.5px;color:var(--mut);margin-top:3px}
  .row.think .bub{color:var(--mut);font-style:italic}

  /* report artifact (right) */
  .rhead{margin-bottom:14px}
  .rh-title{font-size:12px;font-weight:800;color:var(--head);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  .chips{display:flex;gap:7px;flex-wrap:wrap}
  .chip{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:#eef2f6;color:var(--mut);text-transform:capitalize}
  .chip.pass{background:var(--passbg);color:var(--pass)} .chip.fail{background:var(--failbg);color:var(--fail)} .chip.warn{background:var(--warnbg);color:var(--warn)}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:14px;max-width:760px}
  .card .h{font-weight:800;color:var(--head);margin-bottom:9px;font-size:14px}
  .flist{display:flex;flex-direction:column;gap:6px}
  .fitem{font-size:13.5px;padding:6px 0;border-top:1px solid var(--line)} .fitem:first-child{border-top:0}
  .fitem b{color:var(--fail)} .fitem.h b{color:var(--warn)} .fitem .sc{color:var(--mut)}
  .gate{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}
  .gate button{font:inherit;font-weight:700;border-radius:9px;padding:8px 15px;cursor:pointer;border:1px solid}
  .gate .ap{background:var(--passbg);border-color:#a7dcbf;color:var(--pass)} .gate .rj{background:var(--failbg);border-color:#e6b3a9;color:var(--fail)}
  .gatemsg{font-size:13px;color:var(--mut);margin-bottom:4px}
  .empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:9px;color:var(--mut);padding:30px}
  .empty .eh{font-size:17px;font-weight:800;color:var(--head)}
  .empty .ep{max-width:400px;font-size:14px}
  .samples{display:flex;flex-direction:column;gap:8px;width:100%;max-width:360px;margin-top:6px}
  .samples .sl{font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--mut);text-align:left}
  .sample{display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;width:100%;
          border:1px solid var(--line);background:var(--paper);border-radius:11px;padding:9px 13px;cursor:pointer;
          font:inherit;transition:border-color .12s,box-shadow .12s}
  .sample:hover{border-color:var(--accent);box-shadow:0 6px 18px -10px rgba(16,40,60,.55)}
  .sample .st{font-weight:700;color:var(--head);font-size:13.5px}
  .sample .su{font-size:11.5px;color:var(--mut)}

  @media(max-width:820px){
    body{height:auto;min-height:100dvh;overflow:auto}
    .shell{grid-template-columns:1fr}
    .side{border-right:0;border-bottom:1px solid var(--line)}
    .thread{max-height:56vh}
    .starter input{width:150px}
    .dot{display:none}
  }
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

  <div class="shell">
    <aside class="side">
      <div class="thread" id="thread"></div>
      <div class="composer"><div class="inner">
        <input id="chatin" placeholder="Type a comment or question…" aria-label="Message the agent"/>
        <button id="chatsend">Send</button>
      </div></div>
    </aside>
    <main class="main" id="report"></main>
  </div>
<script>
  var ORIGIN = '__WORKER_ORIGIN__'; if(ORIGIN.indexOf('__')===0){ ORIGIN = location.origin; }
  var qs = new URLSearchParams(location.search);
  var id = qs.get('id') || '';
  var lastReport = null, mode = 'idle';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function setConn(t){ document.getElementById('conn').innerHTML = t; }

  // terse event name -> one line of agent narration (no raw log strings on screen)
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
    var tag = it.tag ? ('<div class="t">'+esc(it.tag)+'</div>') : '';
    return '<div class="row '+it.k+'"><div class="av">'+(isU?'U':'AI')+'</div>'+
           '<div class="bub"><div class="who">'+(isU?'You':'Agent')+'</div>'+esc(it.text)+tag+'</div></div>';
  }

  function welcome(){
    return bubble({ k:'agent', tag:'', text:'Hi — I audit PDFs for accessibility against WCAG 2.2 AA. Pick a sample on the right, or paste a PDF URL up top and hit Audit — then watch the report build live. Ask me anything about it here.' });
  }

  // LEFT: the conversation thread (scrolls itself)
  function renderThread(r){
    var html = '';
    var has = r && ((r.events && r.events.length) || (r.chat && r.chat.length));
    if(!has){ html += welcome(); }
    else { html += timeline(r).map(bubble).join(''); }
    if(r && r.thinking){ html += '<div class="row think"><div class="av">AI</div><div class="bub"><div class="who">Agent</div>thinking…</div></div>'; }
    var th = document.getElementById('thread');
    th.innerHTML = html;
    th.scrollTop = th.scrollHeight;
  }

  // RIGHT: the report artifact (scrolls itself)
  function reportHeader(r){
    var g = r.gate || 'open';
    var steps = (r.steps||[]).map(function(s){
      return '<span class="chip '+(s.status==='done'?'pass':'')+'">'+esc(s.step)+'</span>';
    }).join('');
    return '<div class="rhead"><div class="rh-title">Audit status</div><div class="chips">'+
           '<span class="chip '+(g==='finalized'?'pass':(g==='pending_review'?'warn':(g==='rejected'?'fail':'')))+'">'+esc(String(g).replace(/_/g,' '))+'</span>'+
           steps+'</div></div>';
  }

  function findingsCard(r){
    var w = r.wcag; if(!w || !w.summary) return '';
    var s = w.summary, fails = [], humans = [];
    (w.areas||[]).forEach(function(a){ (a.verdicts||[]).forEach(function(v){
      var vr = String(v.verdict).toLowerCase();
      if(vr.indexOf('fail')>=0) fails.push(v);
      else if(v.needs_human || vr.indexOf('human')>=0 || vr.indexOf('cannot')>=0) humans.push(v);
    }); });
    var chips = '<span class="chip">'+esc(s.total)+' criteria</span>'+
                '<span class="chip pass">'+esc(s.passed)+' pass</span>'+
                '<span class="chip fail">'+esc(s.failed)+' fail</span>'+
                '<span class="chip warn">'+esc(s.needsHuman)+' needs human</span>'+
                '<span class="chip">'+esc(s.notApplicable)+' n/a</span>';
    var rows = '';
    fails.slice(0,14).forEach(function(v){ rows += '<div class="fitem"><b>'+esc(v.sc)+'</b> <span class="sc">'+esc(v.name||'')+'</span></div>'; });
    humans.slice(0,8).forEach(function(v){ rows += '<div class="fitem h"><b>'+esc(v.sc)+'</b> <span class="sc">'+esc(v.name||'')+' · needs human</span></div>'; });
    var list = rows ? ('<div class="flist">'+rows+'</div>') : '<div class="gatemsg">No failing criteria.</div>';
    return '<div class="card"><div class="h">WCAG 2.2 AA results</div><div class="chips" style="margin-bottom:10px">'+chips+'</div>'+list+'</div>';
  }

  function gateCard(r){
    var g = r.gate || 'open';
    if(g==='pending_review'){
      return '<div class="card"><div class="h">Human review needed</div>'+
        '<div class="gatemsg">A machine pass is a pre-assessment. Approve to attest, or reject to send it back.</div>'+
        '<div class="gate"><button class="ap" id="ap">Approve · attest</button><button class="rj" id="rj">Reject</button></div></div>';
    }
    return '';
  }

  var SAMPLES = [
    { t:'Attention Is All You Need', s:'arXiv · untagged research paper', u:'https://arxiv.org/pdf/1706.03762' },
    { t:'Conditional GANs (Mirza)', s:'arXiv · figures & equations', u:'https://arxiv.org/pdf/1411.1784' },
    { t:'Sample report PDF', s:'mixed prose, tables & images', u:'https://files.catbox.moe/0aq88m.pdf' }
  ];
  function sampleBtn(x){ return '<button class="sample" data-url="'+esc(x.u)+'"><span class="st">'+esc(x.t)+'</span><span class="su">'+esc(x.s)+'</span></button>'; }
  function runSample(u){ var inp = document.getElementById('pdf'); if(inp){ inp.value = u; } runAudit(); }

  function renderReport(r){
    var el = document.getElementById('report');
    var w = r && r.wcag;
    var hasAudit = r && (w || (r.pipeline && r.pipeline.audit));
    if(!hasAudit){
      el.innerHTML = '<div class="empty"><div class="eh">Audit a PDF</div>'+
        '<div class="ep">Paste a URL up top, or start with a sample — the accessibility findings build here live as I work, and you can ask me about any of them in the chat on the left.</div>'+
        '<div class="samples"><div class="sl">One-click samples</div>'+SAMPLES.map(sampleBtn).join('')+'</div></div>';
      Array.prototype.forEach.call(el.querySelectorAll('.sample'), function(b){
        b.onclick = function(){ runSample(b.getAttribute('data-url')); };
      });
      return;
    }
    el.innerHTML = reportHeader(r) + findingsCard(r) + gateCard(r);
    var ap = document.getElementById('ap'), rj = document.getElementById('rj');
    if(ap) ap.onclick = function(){ decide('approve'); };
    if(rj) rj.onclick = function(){ decide('reject'); };
  }

  function render(d){
    if(d){ lastReport = d.report || d; }
    renderThread(lastReport);
    renderReport(lastReport);
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

  // MCP App host bridge: bind only from our OWN report-summary shape, fetch authoritative state, never
  // render the posted payload.
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
