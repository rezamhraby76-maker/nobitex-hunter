import 'dotenv/config';

const CFG={
 token:process.env.TELEGRAM_BOT_TOKEN||'', chat:process.env.TELEGRAM_CHAT_ID||'',
 interval:Number(process.env.SCAN_INTERVAL_MS||300000), min:Number(process.env.MIN_SCORE||78), max:Number(process.env.MAX_SIGNALS||5)
};
const API='https://apiv2.nobitex.ir';
const sent=new Map();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJSON(url){const r=await fetch(url,{signal:AbortSignal.timeout(15000)}); if(!r.ok) throw Error(`HTTP ${r.status}`); return r.json();}
async function stats(){for(const u of [`${API}/market/stats`,`https://api.nobitex.ir/market/stats`]){try{return await getJSON(u)}catch{}}throw Error('Nobitex stats unavailable');}
async function candles(key,res){const [a,b]=key.split('-'); const symbol=a.toUpperCase()+(b||'').toUpperCase(); const to=Math.floor(Date.now()/1000); const hours=res===15?24:res===240?240:48; const from=to-hours*3600; for(const host of [API,'https://api.nobitex.ir']){try{const d=await getJSON(`${host}/market/udf/history?symbol=${symbol}&resolution=${res}&from=${from}&to=${to}`); if(d.s==='ok'&&d.c?.length>=30)return {c:d.c.map(Number),o:d.o.map(Number),h:d.h.map(Number),l:d.l.map(Number),v:(d.v||[]).map(Number)}}catch{}}return null}
function ema(a,n){if(a.length<n)return null;let k=2/(n+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e}
function sma(a,n){if(a.length<n)return null;return a.slice(-n).reduce((x,y)=>x+y,0)/n}
function rsi(a,n=14){if(a.length<n+1)return null;let g=0,l=0;for(let i=a.length-n;i<a.length;i++){let d=a[i]-a[i-1];d>=0?g+=d:l-=d}if(!l)return 100;const rs=g/l;return 100-100/(1+rs)}
function atr(h,l,c,n=14){if(h.length<n+1)return null;let t=[];for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return t.slice(-n).reduce((x,y)=>x+y,0)/n}
function macd(c){const a=ema(c,12),b=ema(c,26);return a==null||b==null?null:a-b}
function bb(c){const m=sma(c,20);if(m==null)return null;const s=Math.sqrt(c.slice(-20).reduce((x,y)=>x+(y-m)**2,0)/20);return {u:m+2*s,l:m-2*s,w:2*s/m*100}}
function analyze(x){const c=x.c,o=x.o,h=x.h,l=x.l,v=x.v||[],last=c.at(-1);let add=0,why=[];const e9=ema(c,9),e21=ema(c,21),e50=ema(c,50),R=rsi(c),A=atr(h,l,c),M=macd(c),B=bb(c);
 if(e9>e21&&last>e9){add+=10;why.push('EMA صعودی')} else if(e9<e21&&last<e9){add+=3;why.push('EMA نزولی')}
 if(e50&&last>e50){add+=4;why.push('بالای EMA50')}
 if(R>45&&R<65){add+=8;why.push(`RSI مناسب ${R.toFixed(0)}`)} else if(R>=70){add-=12;why.push('اشباع خرید')} else if(R<=30){add+=5;why.push('اشباع فروش')}
 if(M>0){add+=6;why.push('MACD مثبت')} else add-=2;
 if(B){if(last<B.l*1.01){add+=5;why.push('نزدیک کف Bollinger')} if(last>B.u*.99){add-=6;why.push('نزدیک سقف Bollinger')} if(B.w<4){add+=4;why.push('فشردگی Bollinger')}}
 if(v.length>10){const av=v.slice(-11,-1).reduce((a,b)=>a+b,0)/10;if(v.at(-1)>av*1.8){add+=6;why.push('جهش حجم')}}
 const lows=l.slice(-8),highs=h.slice(-8);if(lows.at(-1)>lows[0]){add+=5;why.push('Higher Low')}if(highs.at(-1)<highs[0]){add+=2;why.push('Lower High')}
 return {add,R,A,why};}
function parseStats(d){const s=d.stats||d,o=[];for(const key of Object.keys(s||{})){const r=s[key];if(!r||r.isClosed)continue;let [src,dst]=key.split('-');src=src?.toUpperCase();dst=dst?.toUpperCase();if(!src||!dst)continue;if(dst==='RLS')dst='IRT';const price=Number(r.latest||r.dayClose||0),vol=Number(r.volumeDst||0),ch=Number(r.dayChange||0),bb=Number(r.bestBuy||0),bs=Number(r.bestSell||0);if(price<=0)continue;if(dst==='IRT'&&vol<3e7)continue;if(dst==='USDT'&&vol<300)continue;o.push({key,src,dst,price,vol,ch,bb,bs})}return o}
async function scan(){const rows=parseStats(await stats());const out=[];for(const s of rows){if(out.length>=CFG.max)break;let score=28;if(s.ch>1.5&&s.ch<9)score+=18;if(s.ch>=0&&s.ch<=3)score+=8;if(s.vol>0)score+=6;if(s.ch>14)score-=22;if(s.ch<-7)score-=10;if(s.bb&&s.bs){const mid=(s.bb+s.bs)/2,sp=(s.bs-s.bb)/mid;if(sp<.008)score+=6;if(sp>.035)score-=8}const a15=await candles(s.key,15),a60=await candles(s.key,60),a240=await candles(s.key,240);if(!a15||!a60||!a240)continue;const z=[analyze(a15),analyze(a60),analyze(a240)];score+=z[0].add*.45+z[1].add*.35+z[2].add*.2;score=Math.round(score);if(score<CFG.min)continue;const dir=s.ch>=1.2?'LONG':s.ch<=-1.5?'SHORT':'LONG';const A=z[1].A||z[0].A||s.price*.01;const entry=s.price;const stop=dir==='LONG'?entry-1.5*A:entry+1.5*A;const tp1=dir==='LONG'?entry+2*A:entry-2*A;const tp2=dir==='LONG'?entry+3*A:entry-3*A;out.push({s,score,dir,entry,stop,tp1,tp2,why:[...new Set(z.flatMap(q=>q.why))].slice(0,6)});await sleep(40)}out.sort((a,b)=>b.score-a.score);return out}
function esc(s){return String(s).replace(/[<&>]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]))}
async function tg(method,body){const r=await fetch(`https://api.telegram.org/bot${CFG.token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return r.json()}
async function sendSignal(x){const k=x.s.key;if(Date.now()-(sent.get(k)||0)<3600000)return;const msg=`🚨 <b>NOBITEX HUNTER</b>\n\n<b>${esc(x.s.src)}/${esc(x.s.dst)} — ${x.dir}</b>\nامتیاز: <b>${x.score}/100</b>\nقیمت ورود: <code>${x.entry}</code>\nحد ضرر: <code>${x.stop.toFixed(8)}</code>\nTP1: <code>${x.tp1.toFixed(8)}</code>\nTP2: <code>${x.tp2.toFixed(8)}</code>\n\n<b>دلایل:</b> ${x.why.map(esc).join(' • ')}\n\n⏱ اسکن خودکار 24/7`;const r=await tg('sendMessage',{chat_id:CFG.chat,text:msg,parse_mode:'HTML',disable_web_page_preview:true});if(r.ok)sent.set(k,Date.now());}
async function cycle(){try{const xs=await scan();for(const x of xs)await sendSignal(x);console.log(new Date().toISOString(),`signals=${xs.length}`)}catch(e){console.error('SCAN',e.message)}}
async function main(){if(!CFG.token||!CFG.chat){console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');process.exit(1)}try{const me=await tg('getMe',{});if(!me.ok)throw Error('Telegram token invalid');console.log(`Connected to @${me.result.username}`)}catch(e){console.error(e.message);process.exit(1)}await cycle();setInterval(cycle,CFG.interval)}main();
