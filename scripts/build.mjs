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
// Snowatch weather-icon FILENAME (/images/weathericons/NAME.gif) → emoji.
// Snowatch stitches icons to the Morning/Midday/Night labels via JS, so in the raw HTML
// the icons sit in their own block — we read them by filename in day order instead.
const FILEMOJI = {
  "fine":"☀️","mostly-fine":"🌤️","sunny":"☀️","mostly-sunny":"🌤️","cloud-clearing":"🌤️","clearing":"🌤️",
  "partly-cloudy":"⛅","mostly-cloudy":"🌥️","becoming-cloudy":"🌥️","cloudy":"☁️","overcast":"☁️",
  "light-showers":"🌦️","showers":"🌧️","rain":"🌧️","heavy-rain":"🌧️","drizzle":"🌦️","possible-shower":"🌦️","possible-showers":"🌦️",
  "light-snow":"🌨️","snow":"❄️","snow-showers":"🌨️","light-snow-showers":"🌨️","snow-flurries":"🌨️","flurries":"🌨️","heavy-snow":"❄️","possible-snow":"🌨️",
  "snow-and-rain":"🌨️","rain-and-snow":"🌨️","sleet":"🌨️",
  "fog":"🌫️","mist":"🌫️","frost":"❄️","wind":"💨","windy":"💨","storm":"⛈️","thunderstorm":"⛈️","thunder":"⛈️"
};
function fileEmoji(f){
  f=(f||"").toLowerCase();
  if(FILEMOJI[f]) return FILEMOJI[f];
  const k = Object.keys(FILEMOJI).find(x=> f.includes(x));   // fallback for unlisted icons
  return k ? FILEMOJI[k] : "•";
}
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
  // Weather icons live in the raw HTML as /images/weathericons/NAME.gif — 3 per day, in day order.
  // Take the trailing marks*3 so a stray leading icon (e.g. current conditions) can't shift alignment.
  const allIcons = [...html.matchAll(/weathericons\/([a-z0-9_-]+)\.(?:gif|png|svg)/gi)].map(x=>x[1].toLowerCase());
  const need = marks.length*3;
  const wicons = allIcons.length>=need ? allIcons.slice(allIcons.length-need) : allIcons;
  const days=[];
  for(let i=0;i<marks.length;i++){
    const seg = t.slice(marks[i], i+1<marks.length?marks[i+1]:t.length);
    const date = new Date(issueDate.getTime()+i*86400000);
    const dayIcons = wicons.slice(i*3, i*3+3);
    const c = dayIcons.length ? dayIcons.map(fileEmoji).join(" › ") : "—";
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

// ---- Official Falls Creek snow & weather report (server-rendered; fully fetchable) ----
function cmFig(t,label){ const m=t.match(new RegExp("(\\d+)\\s*cm\\s*"+label,"i")); return m? m[1]+" cm" : null; }
function parseFallsReport(raw){
  const t = raw.replace(/\s+/g," ").trim();
  const date = (t.match(/Report Date:\s*([A-Za-z]{3,}\s+\d{1,2}\s+\w+,\s*[\d:]+\s*[AP]M)/i)||[])[1] || null;
  if(!date) return null;
  let report = null;
  const dm = t.match(/Report Date:[^,]*,\s*[\d:]+\s*[AP]M/i);
  const ni = t.search(/NATURAL SNOW ?FALL/i);
  if(dm && ni>0){
    const block = t.slice(dm.index+dm[0].length, ni).replace(/\s+/g," ").trim();
    report = block.split(/(?<=[.!?])\s+/).filter(s=>s.length>2).slice(0,3).join(" ").slice(0,320).trim();
  }
  const smk = (t.match(/(Our snowmaking team[^!.]*[!.])/i)||[])[1] || null;
  const temp = (t.match(/([\d.]+)\s*°?\s*C\s*TEMP/i)||[])[1];
  const wind = (t.match(/(\d+)\s*kph\s*WIND/i)||[])[1];
  const dir  = (t.match(/([NSEW]{1,3})\s*DIRECTION/i)||[])[1];
  const lifts= (t.match(/(\d+)\s*CURRENT LIFTS/i)||[])[1];
  return { date, report, smk,
    last24: cmFig(t,"24 HOURS"), last7: cmFig(t,"7 DAYS"), season: cmFig(t,"SEASON"), base: cmFig(t,"DEPTH"),
    temp: temp? temp+"°C" : null, wind: wind? wind+" km/h "+(dir||"") : null, lifts };
}

// ---- Official Mt Hotham report (server-rendered like Falls) ----
// Page lays out: "Last 24hrs 0cm", "Last 7 Days 26cm", "Season Total 95cm", "Depth 42cm",
// "Temperature 7.0°C", "Wind Speed 20kph", "Wind Direction S", plus a "Daily Snow Report" issued date.
function parseHotham(raw){
  const t = raw.replace(/\s+/g," ").trim();
  const g = re => { const m = t.match(re); return m ? m[1] : null; };
  const last24 = g(/Last 24 ?hrs\s*([\d.]+)\s*cm/i);
  const last7  = g(/Last 7 Days\s*([\d.]+)\s*cm/i);
  const season = g(/Season Total\s*([\d.]+)\s*cm/i);
  const depth  = g(/Depth\s*([\d.]+)\s*cm/i);
  if(depth==null && season==null && last7==null) return null;   // nothing parsed → don't touch box
  const temp = g(/Temperature\s*([\d.]+)\s*°?\s*C/i);
  const wind = g(/Wind Speed\s*([\d.]+)\s*kph/i);
  const dir  = g(/Wind Direction\s*([NSEW]{1,3})\b/i);
  // Issued date on the natural-snow panel: "Issued: Fri 17 July, 08:59AM"
  const issued = g(/Issued:\s*([A-Za-z]{3},?\s*\d{1,2}\s+[A-Za-z]+,\s*[\d:]+\s*[AP]M)/i)
              || g(/([A-Za-z]{3},?\s*\d{1,2}\s+[A-Za-z]+,\s*[\d:]+\s*[AP]M)\s*It'?s another/i);
  // Lead sentence of the daily report (between the issued time and the backcountry heading)
  let report = null;
  const lead = t.match(/It'?ll be [\s\S]{0,260}?(?:\.|Enjoy\.)/i) || t.match(/It'?s (?:another|a) [\s\S]{0,220}?\./i);
  if(lead) report = lead[0].replace(/\s+/g," ").trim().slice(0,300);
  return {
    last24: last24!=null?last24+" cm":null, last7: last7!=null?last7+" cm":null,
    season: season!=null?season+" cm":null, base: depth!=null?depth+" cm":null,
    temp: temp?temp+"°C":null, wind: wind?wind+" km/h "+(dir||""):null,
    issued, report,
  };
}

// ---- Official Mt Buller report (Jane's Weather; report text server-rendered) ----
// Lays out: "Resort cover Fair 20cm Average natural 53cm Average made", "Snow last 24 hours 0cm",
// "Last snowfall 12 Jul 2026", "Resort rating Limited cover", and a "Ski Patrol update" paragraph.
function parseBuller(raw){
  const t = raw.replace(/\s+/g," ").trim();
  const g = re => { const m = t.match(re); return m ? m[1] : null; };
  // "Resort cover Fair 20cm Average natural 53cm Average made"
  const cvr = t.match(/Resort cover\s*([A-Za-z][A-Za-z ]*?)\s*([\d.]+)\s*cm\s*Average natural/i);
  const cover = cvr ? cvr[1].trim() : null;
  const natural = cvr ? cvr[2] : g(/([\d.]+)\s*cm\s*Average natural/i);
  const made = g(/Average natural\s*([\d.]+)\s*cm\s*Average made/i);
  if(natural==null && made==null) return null;
  const last24 = g(/Snow last 24 hours\s*([\d.]+)\s*cm/i);
  const lastSnow = g(/Last snowfall\s*([0-9]{1,2}\s+[A-Za-z]{3,}\s+\d{4})/i);
  const rating = g(/Resort rating\s*([A-Za-z][A-Za-z ]*?)\s*(?:Now|Snow|Observations|Ski|Updated|$)/i);
  let patrol = g(/Ski Patrol update\s*([\s\S]{20,320}?)(?:\.|!)\s/i);
  if(patrol){ patrol = patrol.replace(/\s+/g," ").trim(); }
  // Buller stamps the report with a date like "Saturday 18th July 07:15am" inside the patrol text, or "18 July 2026"
  const asAt = g(/((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\s+\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+[\d:]+\s*[ap]m)/i)
            || g(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*Forecast/i)
            || lastSnow;
  return {
    cover, natural: natural!=null?natural+" cm":null, made: made!=null?made+" cm":null,
    last24: last24!=null?last24+" cm":null, lastSnow, rating, patrol, asAt,
  };
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

// ---- Official Falls Creek report → live current-conditions box + tracker actual ----
// Server-rendered and fully fetchable (cache-busted). Falls Creek only for now.
const FALLS_REPORT_URL = "https://www.skifalls.com.au/discover-falls-creek/conditions-maps/snow-weather-report";
let fallsReport = null, reportActual = null;
try { fallsReport = parseFallsReport(await getText(FALLS_REPORT_URL + "?nocache=" + Date.now())); }
catch(e){ console.warn("Falls Creek report: " + e.message + " — keeping previous conditions box."); }
const condsForBuild = conds.slice();
if(fallsReport){
  const smM = fallsReport.smk && fallsReport.smk.match(/will be ([^,.!]+)/i);
  const smkCell = smM ? smM[1].replace(/^./,c=>c.toUpperCase()) : (fallsReport.smk ? "See note" : "—");
  const bits = [];
  if(fallsReport.report) bits.push(fallsReport.report);
  if(fallsReport.smk)    bits.push("Snowmaking: " + fallsReport.smk);
  if(fallsReport.temp)   bits.push("On-mountain now " + fallsReport.temp + (fallsReport.wind ? ", wind " + fallsReport.wind : "") + " (WeatherZone)");
  condsForBuild[0] = JSON.stringify({
    base: fallsReport.base || "—", last24: fallsReport.last24 || "—", last7: fallsReport.last7 || "—",
    season: fallsReport.season || "—", lifts: fallsReport.lifts || "—", snowmaking: smkCell,
    note: bits.join(" · "),
    source: "Falls Creek official report", sourceUrl: FALLS_REPORT_URL, asAt: fallsReport.date
  });
  if(fallsReport.last24){ const n = parseFloat(fallsReport.last24); if(!isNaN(n)) reportActual = n; }
  console.log(`Falls report: ${fallsReport.date} — 24h ${fallsReport.last24}, base ${fallsReport.base}, ${fallsReport.lifts} lift(s).`);
}

// ---- Official Mt Hotham report → conditions box (index 1) ----
const HOTHAM_REPORT_URL = "https://www.mthotham.com.au/mountain/conditions/snow-reports";
try {
  const hr = parseHotham(await getText(HOTHAM_REPORT_URL + "?nocache=" + Date.now()));
  if(hr){
    const bits = [];
    if(hr.report) bits.push(hr.report);
    if(hr.temp)   bits.push("On-mountain now " + hr.temp + (hr.wind ? ", wind " + hr.wind : "") + " (WeatherZone)");
    bits.push("Natural snow — 24 h " + (hr.last24||"—") + ", 7 d " + (hr.last7||"—") + ", season " + (hr.season||"—") + ", depth " + (hr.base||"—") + ".");
    condsForBuild[1] = JSON.stringify({
      auto: true, source: "mthotham.com.au", sourceUrl: HOTHAM_REPORT_URL, asAt: hr.issued || null, depthAsAt: null,
      base: hr.base || "—", last24: hr.last24 || "—", last7: hr.last7 || "—", season: hr.season || "—",
      lifts: "See report", trails: "—", snowmaking: "—",
      note: bits.join(" · ")
    });
    console.log(`Hotham report: issued ${hr.issued} — depth ${hr.base}, 7 d ${hr.last7}, season ${hr.season}.`);
  } else { console.warn("Hotham report: didn't parse — keeping previous box."); }
} catch(e){ console.warn("Hotham report: " + e.message + " — keeping previous box."); }

// ---- Official Mt Buller report → conditions box (index 2) ----
const BULLER_REPORT_URL = "https://www.mtbuller.com.au/winter/snow-weather/snow-report";
try {
  const br = parseBuller(await getText(BULLER_REPORT_URL + "?nocache=" + Date.now()));
  if(br){
    const bits = [];
    bits.push("Resort cover: " + (br.cover || br.rating || "—") + ". Average natural " + (br.natural||"—") + " on the ground; " + (br.made||"—") + " machine-made (the 'made' figure, NOT snow currently on the ground).");
    if(br.last24)   bits.push("Snow last 24 h " + br.last24 + (br.lastSnow ? "; last snowfall " + br.lastSnow : "") + ".");
    if(br.patrol)   bits.push("Ski Patrol: " + br.patrol + ".");
    bits.push("Live on-mountain temp/wind isn't exposed to an automated fetch; see Snowatch live temp above.");
    condsForBuild[2] = JSON.stringify({
      auto: true, source: "mtbuller.com.au", sourceUrl: BULLER_REPORT_URL, asAt: br.asAt || null, depthAsAt: null,
      base: br.natural || "0 cm", last24: br.last24 || "—", last7: "—",
      season: (br.made ? br.made + " <small>made</small>" : "—"),
      lifts: (br.cover || br.rating || "—"), trails: "—", snowmaking: "—",
      note: bits.join(" ")
    });
    console.log(`Buller report: cover ${br.cover||br.rating} — natural ${br.natural}, made ${br.made}, 24h ${br.last24}.`);
  } else { console.warn("Buller report: didn't parse — keeping previous box."); }
} catch(e){ console.warn("Buller report: " + e.message + " — keeping previous box."); }

// ---- Forecast-accuracy tracker: append today's Falls Creek snapshot ----
// Actual 24h snowfall now comes from the official report (reportActual); data/actuals.json
// still overrides/backfills any day by hand ({"YYYY-MM-DD": cm}) if the resort figure is off.
try {
  const todayISO = new Intl.DateTimeFormat("en-CA",{timeZone:"Australia/Melbourne",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  let acts = {}; try { acts = JSON.parse(readFileSync("data/actuals.json","utf8")); } catch(_){}
  const swDaily = {}; fc.falls.days.forEach(d=>{ swDaily[d.d] = d.cm; });
  const mwDaily = {}; if(mwData) mwData.days.forEach(d=>{ mwDaily[d.label] = d.cm; });
  const row = { date: todayISO, issued: fc.falls.issued, actual24h: (acts[todayISO]!=null?acts[todayISO]:reportActual), mw7: mwData?mwData.total7:null, swDaily, mwDaily };
  const LOG = "data/forecast-log.json";
  let log = []; try { log = JSON.parse(readFileSync(LOG,"utf8")); } catch(_){}
  log = log.filter(r=> r.date !== todayISO); log.push(row);
  log.forEach(r=>{ if(acts[r.date]!=null) r.actual24h = acts[r.date]; });   // backfill actuals added after the fact
  log.sort((a,b)=> a.date<b.date?-1:1);
  mkdirSync("data", { recursive:true });
  writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(`Tracker: logged ${todayISO} (actual24h=${row.actual24h}, MW Falls 7-day=${mwData?mwData.total7+"cm":"n/a"}).`);
} catch(e){ console.warn("Tracker log: " + e.message); }

// ---- Accuracy scorecard: grade Snowatch vs Mountainwatch on 1-day-ahead Falls forecasts ----
// For each day D with a real actual, look at the PRIOR day's log row and read what each
// source forecast for D. Snowatch cm is a range string ("3–12 cm") -> midpoint; MW is a number.
let SCORE = "null";
try {
  const log = JSON.parse(readFileSync("data/forecast-log.json","utf8"));
  const byd = Object.fromEntries(log.map(r=>[r.date,r]));
  const WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const swLbl = dt => `${WD[dt.getUTCDay()]} ${dt.getUTCDate()} ${MON3[dt.getUTCMonth()]}`;
  const mwLbl = dt => `${WD[dt.getUTCDay()]} ${dt.getUTCDate()}`;
  const mid = s => { if(s==null) return null; const n=String(s).match(/[\d.]+/g); if(!n) return null; const a=n.map(Number); return a.length>=2?(a[0]+a[1])/2:a[0]; };
  const rows=[];
  for(const r of log){
    if(r.actual24h==null) continue;
    const d=new Date(r.date+"T00:00:00Z");
    const prev=new Date(d.getTime()-864e5).toISOString().slice(0,10);
    const p=byd[prev]; if(!p) continue;
    const sw = mid(p.swDaily ? p.swDaily[swLbl(d)] : null);
    const mw = p.mwDaily ? p.mwDaily[mwLbl(d)] : null;
    rows.push({ d:`${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`, a:r.actual24h, sw, mw });
  }
  const mae = (arr,pick) => { const e=arr.filter(x=>pick(x)!=null).map(x=>Math.abs(pick(x)-x.a)); return e.length? Math.round(e.reduce((s,v)=>s+v,0)/e.length*10)/10 : null; };
  const snow = rows.filter(x=>x.a>0);
  const _sd = Object.fromEntries(new Intl.DateTimeFormat("en-AU",{timeZone:"Australia/Melbourne",day:"numeric",month:"short",year:"numeric"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  const score = {
    built: `${_sd.day} ${_sd.month} ${_sd.year}`,
    nAll: rows.length,
    swMaeAll: mae(rows,x=>x.sw), mwMaeAll: mae(rows,x=>x.mw),
    nSnow: snow.length,
    swMaeSnow: mae(snow,x=>x.sw), mwMaeSnow: mae(snow,x=>x.mw),
    events: snow.map(x=>({ d:x.d, a:x.a, sw:(x.sw==null?null:Math.round(x.sw*10)/10), mw:x.mw }))
  };
  SCORE = JSON.stringify(score);
  console.log(`Scorecard: ${score.nAll} scored days (SW MAE ${score.swMaeAll} / MW ${score.mwMaeAll}); ${score.nSnow} snow days (SW ${score.swMaeSnow} / MW ${score.mwMaeSnow}).`);
} catch(e){ console.warn("Scorecard: " + e.message); }

const M = "const M = {\n" + MTN.map((cfg,i)=>mtnJs(cfg, fc[cfg.key], condsForBuild[i])).join(",\n") + "\n};";
const _bp = Object.fromEntries(new Intl.DateTimeFormat("en-AU",{timeZone:"Australia/Melbourne",day:"numeric",month:"long",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true}).formatToParts(new Date()).map(x=>[x.type,x.value]));
const builtStamp = `${_bp.day} ${_bp.month} ${_bp.year}, ${_bp.hour}:${_bp.minute} ${(_bp.dayPeriod||"").toUpperCase()} AEST`;

let out = html.replace(/const M = \{[\s\S]*?\n\};/, ()=>M);
out = out.replace(/const CMP = [\s\S]*?;\s*\/\/ CMP/, `const CMP = ${CMP};  // CMP`);   // Snowatch-vs-Mountainwatch strip
out = out.replace(/const SCORE = [\s\S]*?;\s*\/\/ SCORE/, `const SCORE = ${SCORE};  // SCORE`);   // accuracy scorecard
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
