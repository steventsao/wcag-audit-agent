import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const URL = 'https://okra-a11y-agent.steventsao.workers.dev/app?id=ext-e6a7782e7db136da64928260';
const FPS = 24, DUR = 60;

const CONFIG = [
  { t0:0,  t1:7,  big:1, who:'THE APP IS THE AGENT', text:'okra-a11y-agent — one Cloudflare Durable Object, many live surfaces', color:'#7ee3ff', group:'none', veil:0.52 },
  { t0:7,  t1:18, who:'A11yAgent — coordinator DO', text:'Owns the report state, the pipeline phases, the live connection and the human-review gate. One setState re-renders every surface.', color:'#2563eb', group:'a11y', veil:0.66 },
  { t0:18, t1:29, who:'WcagAgent', text:'Maps gathered evidence onto WCAG 2.2 AA — the rule-area sidebar and the per-criterion rollup you are looking at.', color:'#7c3aed', group:'wcag', veil:0.66 },
  { t0:29, t1:39, who:'ValidatorAgent — facet agent', text:'Reads the PDF StructTree and tags; its verdicts populate Reading Order, Table Semantics and Tag Structure.', color:'#059669', group:'validator', veil:0.66 },
  { t0:39, t1:47, who:'ColorContrastAgent — facet agent', text:'Measures WCAG 1.4.3 against real background pixels; writes the Color Contrast verdict.', color:'#ea580c', group:'contrast', veil:0.66 },
  { t0:47, t1:54, who:'LiveDocAgent — per-session DO', text:'Streams the accessible HTML twin — the Create-HTML phase.', color:'#db2777', group:'livedoc', veil:0.66 },
  { t0:54, t1:60.1, who:'The app is the agent', text:'5 agents · 1 coordinator DO · 1 setState → browser, MCP host & native iOS. Delegation keeps each context lean.', color:'#7ee3ff', group:'all', veil:0.6 },
];

function inject(CONFIG){
  document.getElementById('tour')?.remove();
  const W=window.innerWidth, H=window.innerHeight;
  const COL={a11y:'#2563eb',wcag:'#7c3aed',validator:'#059669',contrast:'#ea580c',livedoc:'#db2777'};
  const Q=s=>document.querySelector(s);
  const rc=sel=>{ const el=typeof sel==='string'?Q(sel):sel; if(!el) return null; const r=el.getBoundingClientRect(); if(r.width<1) return null; return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
  function sidebar(){ const sc=Q('.standards-control'); if(!sc) return null; const b=document.querySelector('button .rule-nav-label'); const nav=b?b.closest('button').parentElement:null; const a=sc.getBoundingClientRect(); const z=nav?nav.getBoundingClientRect():a; const x=Math.min(a.left,z.left)-4, y=a.top-24; const right=Math.max(a.right,z.right)+4, bottom=Math.min(z.bottom, H-6); return {x:Math.round(x),y:Math.round(y),w:Math.round(right-x),h:Math.round(bottom-y)}; }
  function row(label){ const v=Q('#view'); if(!v) return null; const vr=v.getBoundingClientRect(); const el=[...v.querySelectorAll('*')].find(e=>e.textContent.trim()===label && e.getBoundingClientRect().width>0 && e.getBoundingClientRect().width<440); if(!el) return null; const r=el.getBoundingClientRect(); return {x:Math.round(vr.x+10),y:Math.round(r.y-7),w:Math.round(vr.width-20),h:Math.round(r.height+14)}; }
  function tab(i){ const b=[...document.querySelectorAll('#phases button')][i]; return rc(b); }
  const G={
    a11y:[rc('.title-block'),rc('#conn'),rc('#phases')].filter(Boolean).map(r=>({...r,c:COL.a11y})),
    wcag:[sidebar(),rc('#view')].filter(Boolean).map(r=>({...r,c:COL.wcag})),
    validator:[row('Reading Order'),row('Table Semantics'),row('Tag Structure (PDF/UA)')].filter(Boolean).map(r=>({...r,c:COL.validator})),
    contrast:[row('Color Contrast')].filter(Boolean).map(r=>({...r,c:COL.contrast})),
    livedoc:[tab(1)].filter(Boolean).map(r=>({...r,c:COL.livedoc})),
  };
  G.all=[...G.a11y,...G.wcag.filter(r=>r.w<260),...G.validator,...G.contrast,...G.livedoc]; // sidebar only for "all" to avoid full-panel hole
  G.none=[];
  const SEGS=CONFIG.map(s=>({...s, regions:(s.group==='all'?G.all:(G[s.group]||[]))}));

  const root=document.createElement('div'); root.id='tour';
  root.style.cssText='position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system';
  document.body.appendChild(root);
  const NS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(NS,'svg'); svg.setAttribute('width',W); svg.setAttribute('height',H); svg.style.cssText='position:fixed;inset:0';
  const veil=document.createElementNS(NS,'path'); veil.setAttribute('fill-rule','evenodd'); veil.setAttribute('fill','#060e16'); svg.appendChild(veil); root.appendChild(svg);
  const borders=[]; for(let i=0;i<12;i++){ const d=document.createElement('div'); d.style.cssText='position:fixed;border:2.5px solid #fff;border-radius:9px;display:none;box-shadow:0 0 0 1px #ffffff55, 0 10px 30px -12px #000'; root.appendChild(d); borders.push(d); }
  // caption card
  const cap=document.createElement('div');
  cap.style.cssText='position:fixed;left:50%;bottom:34px;transform:translateX(-50%);width:min(880px,86vw);background:#0c1a27F2;color:#fff;border-left:4px solid #fff;border-radius:13px;padding:14px 20px;box-shadow:0 18px 60px -18px #000;backdrop-filter:blur(5px)';
  const capWho=document.createElement('div'); capWho.style.cssText='font:800 14px ui-sans-serif;letter-spacing:.2px;margin-bottom:3px';
  const capTxt=document.createElement('div'); capTxt.style.cssText='font:500 14.5px/1.45 ui-sans-serif;color:#dfeaf2';
  cap.appendChild(capWho); cap.appendChild(capTxt); root.appendChild(cap);
  // big intro title
  const big=document.createElement('div'); big.style.cssText='position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center';
  const bigH=document.createElement('div'); bigH.style.cssText='font:900 50px ui-sans-serif;letter-spacing:1px;color:#fff;text-shadow:0 4px 30px #000c';
  const bigS=document.createElement('div'); bigS.style.cssText='font:600 19px ui-sans-serif;color:#7ee3ff;margin-top:12px;text-shadow:0 2px 16px #000c';
  big.appendChild(bigH); big.appendChild(bigS); root.appendChild(big);
  // progress + chips
  const prog=document.createElement('div'); prog.style.cssText='position:fixed;left:0;top:0;height:4px;background:linear-gradient(90deg,#2563eb,#7c3aed,#059669,#ea580c,#db2777);width:0%'; root.appendChild(prog);

  function holePath(regs){ let d='M0 0H'+W+'V'+H+'H0Z'; regs.forEach(r=>{ d+=' M'+r.x+' '+r.y+'H'+(r.x+r.w)+'V'+(r.y+r.h)+'H'+r.x+'Z'; }); return d; }
  window.__renderAt=function(t){
    let seg=SEGS.find(s=>t>=s.t0&&t<s.t1)||SEGS[SEGS.length-1];
    const local=t-seg.t0, dur=seg.t1-seg.t0;
    const fin=Math.min(1,local/0.6), fout=Math.min(1,(dur-local)/0.5); const a=Math.max(0,Math.min(fin,fout));
    veil.setAttribute('d',holePath(seg.regions)); veil.setAttribute('fill-opacity', (seg.veil*a).toFixed(3));
    borders.forEach((b,i)=>{ const r=seg.regions[i]; if(r){ b.style.display='block'; b.style.left=(r.x-3)+'px'; b.style.top=(r.y-3)+'px'; b.style.width=(r.w+6)+'px'; b.style.height=(r.h+6)+'px'; b.style.borderColor=r.c; b.style.opacity=a; } else b.style.display='none'; });
    if(seg.big){ big.style.opacity=a; bigH.textContent=seg.who; bigS.textContent=seg.text; cap.style.opacity=0; }
    else { big.style.opacity=0; cap.style.opacity=a; cap.style.borderLeftColor=seg.color; capWho.textContent=seg.who; capWho.style.color=seg.color; capTxt.textContent=seg.text; }
    prog.style.width=(100*Math.min(t,60)/60)+'%';
  };
  return {W,H,regions:Object.fromEntries(Object.entries(G).map(([k,v])=>[k,v.length]))};
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport:{width:1456,height:828}, deviceScaleFactor:1 });
console.log('loading app...');
await page.goto(URL, { waitUntil:'networkidle', timeout:45000 });
await page.waitForFunction(()=>/TOTAL/.test(document.body.innerText) && document.querySelector('#view')?.innerText.includes('Compliance'), null, { timeout:30000 }).catch(()=>console.log('warn: rollup wait timed out, proceeding'));
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(__dir,'..','agent-app-clean.png') });
console.log('clean frame captured');
const meta = await page.evaluate(inject, CONFIG);
console.log('overlay injected; regions =', JSON.stringify(meta.regions));
const N = Math.round(DUR*FPS);
for(let i=0;i<N;i++){
  const t=i/FPS;
  await page.evaluate(t=>window.__renderAt(t), t);
  await page.screenshot({ path: path.join(__dir,'frames',String(i).padStart(5,'0')+'.png') });
  if(i%120===0) console.log('frame',i,'/',N,'(t='+t.toFixed(1)+'s)');
}
console.log('done frames:',N);
await browser.close();
