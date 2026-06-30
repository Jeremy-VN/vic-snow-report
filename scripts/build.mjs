// Rebuild the forecast portion of index.html from Snowatch, deterministically.
// Runs in GitHub Actions (Node 20, global fetch). Keeps the snow-history tabs and
// the current-conditions strip (cond) exactly as they are — only the forecast
// (issued / liveTemp / p5,p10,p15 / days) and the BUILT stamp are refreshed.
// SAFETY: if Snowatch can't be parsed cleanly, or the rebuilt page fails its
// structural checks, the script writes nothing and exits — the live site is never
// overwritten with something broken.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const FILE = "index.html";
const MTN = [
  { key: "falls",  url: "https://www.snowatch.com.au/15-day-forecasts/falls-creek/", name: "Falls Creek",  sub: "Village 1600 m · Summit 1842 m · 14 lifts" },
  { key: "hotham", url: "https://www.snowatch.com.au/15-day-forecasts/hotham/",      name: "Mount Hotham", sub: "Village 1750 m · Summit 1861 m · 13 lifts (incl. Dinner Plain)" },
  { key: "buller", url: "https://www.snowatch.com.au/15-day-forecasts/mt-buller/",   name: "Mount Buller", sub: "Village 1600 m · Summit 1805 m · 22 lifts" },
];
const MONTHS = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
const MON3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WD3 = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const ICON = { "fine":"Fine","partly cloudy":"Part cloud","cloudy":"Cloudy","becoming cloudy":"Cloudy",
  "light showers":"Showers","showers":"Showers","rain":"Rain","light snow":"Snow","snow":"Snow","light-snow":"Snow" };

function decode(s){ return s.replace(/&amp;/g,"&").replace(/&deg;/g,"°").replace(/&nbsp;/g," ").replace(/&#?\w+;/g," "); }
function toText(html){
  let h = html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ");
  h = h.replace(/<img\b[^>]*?\b(?:title|alt)="([^"]*)"[^>]*>/gi," ⟦$1⟧ ");
  h = h.replace(/<[^>]+>/g," ");
  return decode(h).replace(/[ \t]+/g," ");
}
function num(s){ return s==null?null:parseFloat(String(s).replace(/[^\d.\-]/g,"")); }
function tempFmt(s){ const n=num(s); if(n==null||isNaN(n)) return null; return (n<0?"−":"")+Math.abs(n)+"°C"; }
function cmRange(s){ // "0" -> "0 cm" ; "2 - 6" -> "2–6 cm"
  s=s.trim(); const m=s.match(/^(\d+)\s*-\s*(\d+)$/); if(m) return m[1]+"–"+m[2]+" cm";
  return (s||"0")+" cm";
}
function predFmt(s){ if(!s) return "—"; return s.replace(/\s*-\s*/,"–").replace(/cm$/,"").trim()+" cm"; }
function cond3(title){ const t=(title||"").trim().toLowerCase(); return ICON[t] || (title?title.trim():""); }
function level(narr){
  const m = narr.match(/(?:above|lowering(?: overnight| later)? to|about)\s*(?:around\s*)?~?\s*\d{3,4}\s*(?:-\s*\d{3,4})?\s*m[^.,]*/i);
  if(m) return m[0].replace(/\s+/g," ").trim().replace(/^(\w)/,c=>c.toUpperCase());
  if(/about the peaks|about the tops/i.test(narr) && /snow/i.test(narr)) return "About the peaks";
  return "—";
}
function likelihood(cm, narr){
  const hi=(cm.match(/\d+/g)||[]).map(Number).reduce((a,b)=>Math.max(a,b),0);
  const s=/snow|flurr/i.test(narr);
  if(hi>=5 && s) return "high";
  if(hi>=1 && s) return "likely";
  if(s && /chance|possible|possibly|above|peaks|tops/i.test(narr)) return "possible";
  if(hi>=1) return "likely";
  return "none";
}

function parseSnow(html){
  const t = toText(html);
  const u = t.match(/Updated:\s*([A-Za-z]+)\s+(\d{1,2})\w*,?\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if(!u) return null;
  const mo = MONTHS[u[1].toLowerCase()]; if(mo==null) return null;
  const yr = new Date().getUTCFullYear();
  const issueDate = new Date(Date.UTC(yr, mo, +u[2]));
  const issued = `${u[2]} ${MON3[mo]} ${yr}, ${u[3]}:${u[4]} ${u[5].toUpperCase()}`;
  const lt = tempFmt((t.match(/LIVE TEMP:\s*([\-−\d.]+)/i)||[])[1]);
  const p5 = predFmt((t.match(/NEXT 5 DAYS:\s*([0-9]+(?:-[0-9]+)?cm)/i)||[])[1]);
  const p10= predFmt((t.match(/NEXT 10 DAYS:\s*([0-9]+(?:-[0-9]+)?cm)/i)||[])[1]);
  const p15= predFmt((t.match(/NEXT 15 DAYS:\s*([0-9]+(?:-[0-9]+)?cm)/i)||[])[1]);

  // Melbourne "today" (date only) for past-day marking
  const melParts = new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Melbourne",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const o={}; melParts.forEach(p=>o[p.type]=p.value);
  const today = new Date(Date.UTC(+o.year,+o.month-1,+o.day));

  const re = /(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s+\d{1,2}(?:ST|ND|RD|TH)/g;
  const marks=[]; let m; while((m=re.exec(t))!==null) marks.push(m.index);
  const days=[];
  for(let i=0;i<marks.length;i++){
    const seg = t.slice(marks[i], i+1<marks.length?marks[i+1]:t.length);
    const date = new Date(issueDate.getTime()+i*86400000);
    const cond = ["Morning","Midday","Night"].map(part=>{
      const mm = seg.match(new RegExp("⟦([^⟧]*)⟧\\s*"+part,"i"));
      return mm?cond3(mm[1]):"";
    }).filter(Boolean);
    const cset=[...new Set(cond)];
    const c = cond.length? (cset.length===1? cond[0]+" all day" : cond.join(" › ")) : "";
    const snowM = seg.match(/SNOW:\s*([0-9]+(?:\s*-\s*[0-9]+)?)\s*cm/i);
    const cm = snowM? cmRange(snowM[1]) : "0 cm";
    const narrM = seg.match(/cm\s*([\s\S]*?)\s*SNOWMAKING/i);
    const narr = narrM? narrM[1].replace(/⟦[^⟧]*⟧/g,"").replace(/\s+/g," ").trim() : "";
    const smkM = seg.match(/SNOWMAKING\s*(LIKELY|POSSIBLE|UNLIKELY)/i);
    const smk = smkM? smkM[1].toLowerCase() : "unlikely";
    const windM = seg.match(/WIND\s+([NESW]{1,3}(?:-[NESW]{1,3})?)\s*(LIGHT|MODERATE|STRONG|GALE\w*)?/);  // case-sensitive WIND label (avoids matching "Winds" in narrative)
    const wind = windM? (windM[1]+(windM[2]?", "+windM[2].toLowerCase().replace("moderate","mod"):"")) : "";
    const past = date < today;
    days.push({
      d: `${WD3[date.getUTCDay()]} ${date.getUTCDate()} ${MON3[date.getUTCMonth()]}`,
      c: c||"—", cm, lvl: level(narr), lk: likelihood(cm,narr),
      w: wind, smk, conf: i<7?"firm":"low", past
    });
  }
  if(days.length < 10) return null;          // sanity: Snowatch should give ~15 day blocks
  return { issued, liveTemp: lt||"—", p5, p10, p15, days, daysOld: Math.round((today-issueDate)/86400000) };
}

function dayJs(r){
  return `{d:"${r.d}", c:"${r.c}", cm:"${r.cm}", lvl:"${r.lvl}", lk:"${r.lk}", w:"${r.w}", smk:"${r.smk}", conf:"${r.conf}"${r.past?", past:true":""}}`;
}
function mtnJs(cfg, f, cond){
  const stale = f.daysOld>=1;
  const note = `Snowatch last refreshed this forecast on ${f.issued.replace(/,.*/,"")} — ${f.daysOld} day${f.daysOld===1?"":"s"} old. Elapsed days are dropped so the table starts on today's date. The conditions strip below shows each report's own date.`;
  const daysBlock = "[\n      "+f.days.map(dayJs).join(",\n      ")+"\n    ]";
  return `  ${cfg.key}: {
    name: "${cfg.name}",
    sub: "${cfg.sub}",
    issued: "${f.issued}",
    stale: ${stale},
    staleNote: ${stale?`"${note}"`:'""'},
    liveTemp: "${f.liveTemp}",
    p5: "${f.p5}", p10: "${f.p10}", p15: "${f.p15}",
    cond: ${cond},
    days: ${daysBlock}
  }`;
}

// ---- Mountainwatch (Falls Creek 7-day weather graph @ ~1770m) ----
function parseMW(text){
  const elev = (text.match(/For\s*(\d{3,4})\s*m/)||[])[1] || "1770";
  const labels = [...text.matchAll(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\b/g)].slice(0,7).map(m=>`${m[1]} ${parseInt(m[2],10)}`);
  const snows = [...text.matchAll(/Snow:\s*([\d.]+)\s*cm/g)].map(m=>parseFloat(m[1])).slice(0,7);
  if(labels.length<5 || snows.length<5) return null;
  const days = labels.map((lab,i)=>({label:lab, cm: snows[i] ?? 0}));
  return { elev, days, total7: Math.round(snows.reduce((a,b)=>a+b,0)) };
}
async function getText(u){
  const r = await fetch(u, { headers:{ "User-Agent":"Mozilla/5.0 snow-bot", "Cache-Control":"no-cache" }});
  if(!r.ok) throw new Error("HTTP "+r.status);
  return toText(await r.text());
}

function fail(msg){ console.error("BUILD ABORTED:", msg); process.exit(1); }

const html = readFileSync(FILE,"utf8");
const conds = [...html.matchAll(/cond: (\{[^{}]*\})/g)].map(x=>x[1]);
if(conds.length!==3) fail("expected 3 cond objects, found "+conds.length);

const fc = {};
for(const cfg of MTN){
  let res;
  try {
    const r = await fetch(cfg.url + "?nocache=" + Date.now(), { headers:{ "User-Agent":"Mozilla/5.0 snow-bot", "Cache-Control":"no-cache" }});  // cache-bust so we always get Snowatch's freshest issue
    if(!r.ok){ console.warn(cfg.key+": HTTP "+r.status+" — keeping existing data, no update."); process.exit(0); }
    res = parseSnow(await r.text());
  } catch(e){ console.warn(cfg.key+": fetch/parse error "+e.message+" — keeping existing data, no update."); process.exit(0); }
  if(!res){ console.warn(cfg.key+": Snowatch didn't parse cleanly — keeping existing data, no update."); process.exit(0); }
  fc[cfg.key] = res;
}

// ---- Mountainwatch comparison strips (all three mountains) ----
const MW_URL = {
  falls:  "https://www.mountainwatch.com/australia/falls-creek/weather/",
  hotham: "https://www.mountainwatch.com/australia/mt-hotham/weather/",
  buller: "https://www.mountainwatch.com/australia/mount-buller/weather/",
};
let CMP = "null";
let mwData = null;                 // Falls Creek MW (kept for the accuracy tracker)
const cmpAll = {};
for(const key of ["falls","hotham","buller"]){
  try {
    const mw = parseMW(await getText(MW_URL[key] + "?t=" + Date.now()));
    if(mw){
      const days = mw.days.map(d=>{
        const sw = fc[key].days.find(s=> s.d.startsWith(d.label));   // "Tue 30 Jun".startsWith("Tue 30")
        return { label:d.label, sw: sw? sw.cm : "—", mw: d.cm };
      });
      cmpAll[key] = { elev:mw.elev, days, mw7:mw.total7 };
      if(key==="falls") mwData = mw;
    }
  } catch(e){ console.warn("Mountainwatch "+key+": "+e.message+" — strip skipped this run."); }
}
if(Object.keys(cmpAll).length) CMP = JSON.stringify(cmpAll);

// ---- Forecast-accuracy tracker: append today's Falls Creek snapshot ----
try {
  const todayISO = new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Melbourne",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  let actual = null;
  try {
    const sf = await getText("https://www.skifalls.com.au/snow-report?t=" + Date.now());
    const a = sf.match(/24\s*hours?[^0-9]{0,24}(\d+(?:\.\d+)?)\s*cm/i) || sf.match(/(\d+(?:\.\d+)?)\s*cm[^0-9]{0,16}(?:in\s*the\s*)?(?:last\s*)?24\s*hours?/i);
    if(a) actual = parseFloat(a[1]);
  } catch(e){ console.warn("skifalls actual-snow fetch: " + e.message); }
  const swDaily = {}; fc.falls.days.forEach(d=>{ swDaily[d.d] = d.cm; });
  const mwDaily = {}; if(mwData) mwData.days.forEach(d=>{ mwDaily[d.label] = d.cm; });
  const row = { date: todayISO, issued: fc.falls.issued, actual24h: actual, mw7: mwData?mwData.total7:null, swDaily, mwDaily };
  const LOG = "data/forecast-log.json";
  let log = []; try { log = JSON.parse(readFileSync(LOG,"utf8")); } catch(_){}
  log = log.filter(r=> r.date !== todayISO); log.push(row); log.sort((a,b)=> a.date<b.date?-1:1);
  mkdirSync("data", { recursive:true });
  writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(`Tracker: logged ${todayISO} (actual24h=${actual}, MW Falls 7-day=${mwData?mwData.total7+"cm":"n/a"}).`);
} catch(e){ console.warn("Tracker log: " + e.message); }

const M = "const M = {\n" + MTN.map((cfg,i)=>mtnJs(cfg, fc[cfg.key], conds[i])).join(",\n") + "\n};";
const _bp = Object.fromEntries(new Intl.DateTimeFormat("en-AU",{timeZone:"Australia/Melbourne",day:"numeric",month:"long",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true}).formatToParts(new Date()).map(x=>[x.type,x.value]));
const builtStamp = `${_bp.day} ${_bp.month} ${_bp.year}, ${_bp.hour}:${_bp.minute} ${(_bp.dayPeriod||"").toUpperCase()} AEST`;

let out = html.replace(/const M = \{[\s\S]*?\n\};/, ()=>M);
out = out.replace(/const CMP = [\s\S]*?;\s*\/\/ CMP/, `const CMP = ${CMP};  // CMP`);   // Snowatch-vs-Mountainwatch strip
if(out === html){ console.log("No forecast or comparison change — page already current."); process.exit(0); }  // only bump BUILT when something actually changed
out = out.replace(/const BUILT = "[^"]*";/, `const BUILT = "${builtStamp}";`);

// ---- structural validation gate (never publish a broken page) ----
const checks = [
  ['data-m="falls"',1],['data-m="hotham"',1],['data-m="buller"',1],
  ['data-m="falls-h"',1],['data-m="hotham-h"',1],['data-m="buller-h"',1],
  ['const HSERIES_ALL',1],['function renderHistory',1],['name="robots" content="noindex"',1],
  ['<h2>14-day forecast</h2>',1],['.slice(0,14)',1],
];
for(const [tok] of checks){ if(!out.includes(tok)) fail("missing marker: "+tok); }
if(out.includes("15-day forecast")) fail("'15-day forecast' label reappeared");
for(const k of ["falls","hotham","buller"]){ if(!new RegExp(k+`: \\{[\\s\\S]*?days: \\[\\n      \\{`).test(out)) fail("no days for "+k); }
if((out.match(/\{/g)||[]).length !== (out.match(/\}/g)||[]).length) fail("brace mismatch");
const sz = Buffer.byteLength(out);
if(sz<45000 || sz>100000) fail("size out of range: "+sz);

writeFileSync(FILE, out);
console.log("Rebuilt index.html ("+sz+" bytes). Issued:", Object.fromEntries(MTN.map(c=>[c.key, fc[c.key].issued])));
