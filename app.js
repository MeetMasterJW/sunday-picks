import {firebaseConfig,parentEmail} from './config.js?v=83165485';
import {fetchWeek,fetchWinProb,fetchGameSummary,fetchClosingLine,groupIntoPickWeeks} from './espn.js?v=83165485';
import {tbMillis,compareTiebreak,rankRows} from './scoring.js?v=83165485';
import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getFirestore,doc,collection,setDoc,onSnapshot,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
const COLORS=['#E8641E','#2E6FD8','#C23B6B','#1E9E8A','#7B4FC9','#D9432B','#B71C1C','#AD1457','#E0457B','#A43BB5','#5B5BD6','#1565C0','#1B8FD1','#0F8C9E','#2F8F3A','#558B2F','#8A7A12','#C9A200','#D98200','#A0522D','#6D4C41','#4A5560','#37474F','#2B2F36'];
const MAX_PLAYERS=8;
const DEFAULT_FAMILY={players:[1,2,3,4,5].map((i)=>({id:'p'+i,name:'Player '+i,color:COLORS[i-1]}))};
const S={db:null,auth:null,parent:false,liveProb:{},chanceLog:{},profiles:{},lines:{},fillShown:{},family:DEFAULT_FAMILY,weeks:{},picks:{},locks:{},week:null,me:'p1',tab:'picks',results:false,ready:false,offline:false};
const $=(s)=>document.querySelector(s);
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};
S.me=store.get('picker')||'p1';S.tab=store.get('tab')||'picks';
// Sunday Picks on the living room screen: ?tv drops the chrome and blows the scores up
S.tv=new URLSearchParams(location.search).has('tv');
S.tvLive=store.get('tvlive')==='1';
if(S.tv){document.documentElement.classList.add('tv');S.tab='picks'}

function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2400)}
function textOn(hex){const h=hex.replace('#','');const [r,g,b]=[0,2,4].map(i=>parseInt(h.substr(i,2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4);return (.2126*r+.7152*g+.0722*b)>.45?'#111':'#fff'}
function players(){return (S.family.players||DEFAULT_FAMILY.players).slice(0,MAX_PLAYERS).map(p=>{const pr=S.profiles[p.id]||{};return {...p,color:pr.color||p.color}})}
function player(id){return players().find(p=>p.id===id)||players()[0]}
function initial(p){return esc((p.name||'?').trim().charAt(0).toUpperCase())}
// Late-pick days (Eastern date -> minutes after kickoff that picks stay open)
const LATE_PICKS={'2026-09-13':60};
const etDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function lockTime(g){const t=new Date(g.t);return t.getTime()+(LATE_PICKS[etDate.format(t)]||0)*60e3}
// Who a pick is tracking: final result, or the current leader while a game is live
function pickState(g,pick){
  if(!pick)return '';
  if(g.w)return g.w==='TIE'?'':(pick===g.w?'ok':'no');
  if(g.st!=='in')return '';
  if(g.as===g.hs)return 'even';
  return pick===(g.as>g.hs?g.a.ab:g.h.ab)?'up':'down';
}
function weekLocked(w=S.week){return !!(S.locks['w'+w]&&S.locks['w'+w].locked)}
// The Monday night game of a pick week carries the second tiebreaker guess. The week's
// own last game is usually the Thursday that follows, and it already carries the first,
// so a week whose last game IS the Monday one gets no second guess.
function mondayGame(w){
  const gs=weekGames(w);if(gs.length<2)return null;
  const mon=gs.filter((g,i)=>i<gs.length-1&&slotLabel(g)==='MNF');
  return mon.length?mon[mon.length-1]:null;
}
// It stays open until that game kicks off, even once the rest of the week has locked:
// Monday is after the lock, and everyone has the same Sunday results in front of them.
function tb2Open(w){const g=mondayGame(w);return !!g&&!g.w&&g.st==='pre'&&Date.now()<lockTime(g)}
// ESPN's own status backs up the kickoff time, so winding the phone's clock back can't reopen a
// game that is already being played — unless that day was deliberately given late picks
function locked(g,w=S.week){
  const inPlay=g.st==='in'&&!LATE_PICKS[etDate.format(new Date(g.t))];
  return weekLocked(w)||g.st==='post'||!!g.w||inPlay||Date.now()>=lockTime(g);
}
function pickDoc(week,pid){return S.picks['w'+week+'-'+pid]||{week,player:pid,picks:{}}}
function picksFor(week,pid){return pickDoc(week,pid).picks||{}}
function weekGames(w){return (S.weeks[w]||{}).games||[]}
// Weeks 19-22 are the playoffs; ESPN numbers those rounds 1, 2, 3 and 5
const MAX_WEEK=22;
const ROUNDS={19:{name:'Wild Card',short:'WC',espn:1},20:{name:'Divisional',short:'DIV',espn:2},21:{name:'Conference',short:'CONF',espn:3},22:{name:'Super Bowl',short:'SB',espn:5}};
function weekName(w){return ROUNDS[w]?ROUNDS[w].name:'Week '+w}
function isTbd(g){return g.a.ab==='TBD'||g.h.ab==='TBD'}

const fmtDay=new Intl.DateTimeFormat('en-US',{weekday:'long',month:'short',day:'numeric'});
const fmtShort=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric'});
const fmtTime=new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'});
const etParts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',hour12:false});
// The Sunday afternoon slate — Sunday night football is its own animal
function isSundayDay(g){
  const p=Object.fromEntries(etParts.formatToParts(new Date(g.t)).map(x=>[x.type,x.value]));
  return p.weekday==='Sun'&&+p.hour<20;
}
const clockText=(sec)=>`${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,'0')}`;
function slotLabel(g){
  if(g.tbd)return '';
  const p=Object.fromEntries(etParts.formatToParts(new Date(g.t)).map(x=>[x.type,x.value]));
  const h=+p.hour;
  if(p.weekday==='Thu'&&h>=19)return 'TNF';
  if(p.weekday==='Sun'&&h>=20)return 'SNF';
  if(p.weekday==='Mon'&&h>=19)return 'MNF';
  return '';
}

/* ---- scoring ---- */
// Week points by final place: 1st, 2nd, 3rd
const PLACE_LABEL=['1st','2nd','3rd','4th','5th','6th','7th','8th'];
// A week belongs to whoever actually played it: once it has started, anyone with no picks
// and no tiebreaker that week sits it out of the standings, points and badges.
function playedIn(w,p){const d=pickDoc(w,p.id);return Object.keys(d.picks||{}).length>0||typeof d.tb==='number'}
function rosterFor(w){
  const ps=players(),gs=weekGames(w);
  const started=weekLocked(w)||gs.some(g=>g.w||g.st==='in'||Date.now()>=lockTime(g));
  if(!started)return ps;
  const played=ps.filter(p=>playedIn(w,p));
  return played.length?played:ps;
}
// Shown, never scored: whoever rosterFor left out, so they don't just vanish from the week
function satOut(w){const ids=new Set(rosterFor(w).map(p=>p.id));return players().filter(p=>!ids.has(p.id))}
function satOutNote(w){const out=satOut(w);return out.length?`<p class="sat-note">Sat out: ${out.map(p=>esc(p.name)).join(', ')} · no picks, no points</p>`:''}
function weekScore(w){
  const games=weekGames(w);const done=games.filter(g=>g.w);
  const last=games[games.length-1];
  const actual=last&&last.w?last.as+last.hs:null;
  const rows=rosterFor(w).map((p,idx)=>{
    const doc=pickDoc(w,p.id),pk=doc.picks||{};let right=0,wrong=0,made=0,up=0;
    games.forEach(g=>{if(pk[g.id])made++;if(pickState(g,pk[g.id])==='up')up++});
    done.forEach(g=>{if(g.w==='TIE')return; if(pk[g.id]===g.w)right++; else wrong++});
    return {p,right,wrong,made,up,idx,tb:typeof doc.tb==='number'?doc.tb:null,tbAt:tbMillis(doc.tbAt),
      tb2:typeof doc.tb2==='number'?doc.tb2:null};
  });
  const complete=games.length>0&&done.length===games.length;
  const mon=mondayGame(w),actual2=mon&&mon.w?mon.as+mon.hs:null;
  rankRows(rows,{complete,actual,actual2});
  const top=Math.max(...rows.map(r=>r.right));
  rows.forEach(r=>r.lead=done.length>0&&r.right===top&&top>0);
  const winner=complete?rows[0]:null;
  const byTiebreak=!!winner&&rows.filter(r=>r.right===winner.right).length>1;
  return {rows,winner,byTiebreak,actual,actual2,mon,last,complete,done:done.length,total:games.length,top};
}
function currentWeek(){
  const now=Date.now();
  for(let w=1;w<=MAX_WEEK;w++){const gs=weekGames(w);if(!gs.length)continue;
    const last=Math.max(...gs.map(g=>new Date(g.t).getTime()));
    if(last+12*3600e3>now||gs.some(g=>!g.w))return w;}
  return MAX_WEEK;
}

/* ---- rendering ---- */
const calm=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
// Note where the standings rows are, then let them travel from there to wherever they land
function takeRowPositions(){
  if(calm())return null;
  const at=new Map();
  document.querySelectorAll('.rrow[data-profile]').forEach((el)=>at.set(el.dataset.profile,el.getBoundingClientRect().top));
  return at.size?at:null;
}
function playRowMoves(at){
  if(!at)return;
  document.querySelectorAll('.rrow[data-profile]').forEach((el)=>{
    const was=at.get(el.dataset.profile);if(was==null)return;
    const dy=was-el.getBoundingClientRect().top;
    if(Math.abs(dy)<1)return;
    el.animate([{transform:`translateY(${dy}px)`},{transform:'none'}],{duration:460,easing:'cubic-bezier(.2,.85,.25,1)'});
  });
}
// A tab or week change is a scene change, so it gets a cross-fade rather than a hard swap
function withTransition(fn){
  if(calm()||!document.startViewTransition)return fn();
  try{
    const t=document.startViewTransition(fn);
    t.finished?.catch(()=>{});
    t.ready?.catch(()=>{});
    t.updateCallbackDone?.catch(()=>{});
  }catch{fn()}
}
function render(){
  const rowsWere=takeRowPositions();
  paint();
  playRowMoves(rowsWere);
  nudgeSecondGuess();
}
// The week strip is rebuilt only when the schedule itself changes, so a flick keeps its place
let stripKey='';
function paintStrip(w,now){
  const strip=$('#weekStrip');
  const live=new Set(),has=new Set();
  for(let k=1;k<=MAX_WEEK;k++){
    const gs=weekGames(k);if(!gs.length)continue;
    has.add(k);
    if(gs.some(g=>g.st==='in'))live.add(k);
  }
  const key=[...has].join(',')+'|'+[...live].join(',')+'|'+now;
  if(key!==stripKey){
    stripKey=key;
    strip.innerHTML=Array.from({length:MAX_WEEK},(_,i)=>i+1).map(k=>{
      const label=ROUNDS[k]?ROUNDS[k].short:k;
      const note=live.has(k)?'LIVE':k===now?'NOW':'';
      return `<button type="button" role="tab" class="wkchip${live.has(k)?' live':''}" data-week="${k}" ${has.has(k)?'':'disabled'} aria-selected="false" aria-label="${esc(weekName(k))}${note?', '+note.toLowerCase():''}">${esc(String(label))}<small>${note||'&nbsp;'}</small></button>`;
    }).join('');
  }
  strip.querySelectorAll('.wkchip').forEach((b)=>{
    const on=+b.dataset.week===w;
    b.setAttribute('aria-selected',String(on));
    if(on&&b.scrollIntoView)b.scrollIntoView({block:'nearest',inline:'center'});
  });
}
function paint(){
  const w=S.week;
  document.querySelectorAll('.tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===S.tab)));
  const gs=weekGames(w);
  $('#wkTitle').textContent=S.tab==='family'?'Family':(w?weekName(w):'Week –');
  if(S.tab==='family'){$('#wkDates').textContent='Names & colors'}
  else if(gs.length){const a=new Date(gs[0].t),b=new Date(gs[gs.length-1].t);$('#wkDates').textContent=fmtShort.format(a)+' – '+fmtShort.format(b)+' · '+gs.length+' games'+(S.scoreError?' · scores offline':'')}
  else $('#wkDates').textContent=S.scoreError?'Couldn’t reach ESPN':(S.ready?'Schedule not loaded yet':'Loading schedule…');
  $('.weeknav').hidden=S.tab==='family';
  const now=currentWeek();
  if(S.tab!=='family')paintStrip(w,now);
  const meP=player(S.me),face=$('#meFace');
  face.className='jersey av-'+meP.id;face.style.setProperty('--c',meP.color);face.textContent=(meP.name||'?').trim().charAt(0).toUpperCase();
  $('#meBtn').classList.toggle('unlocked',isUnlocked(meP.id));
  $('#meBtn').setAttribute('aria-label',`Open ${meP.name}’s profile`);
  const app=$('#app');
  if(S.offline){app.innerHTML='<div class="empty"><b>Sunday Picks isn’t connected to its database yet.</b><br>Add your Firebase settings to config.js.</div>';return}
  if(S.tv&&gs.length)return renderTv(app);
  if(S.tab==='family')return renderFamily(app);
  if(!gs.length){
    app.innerHTML=S.scoreError
      ?'<div class="empty"><b>Couldn’t load the schedule from ESPN.</b><br>Check your connection, then try again.<br><br><button type="button" class="primary" data-retry>Try again</button></div>'
      :`<div class="empty">${S.ready?'No games found for this week yet.':'Loading the schedule…'}</div>`;
    return}
  if(S.tab==='standings')return renderStandings(app);
  if(S.tab==='all')return renderAllPicks(app);
  renderPicks(app);
}

// Everyone has picked every game they still can (and set a tiebreaker while it's open)
function allSubmitted(w){
  const gs=weekGames(w);if(!gs.length||gs.some(isTbd))return false;
  const now=Date.now(),last=gs[gs.length-1];
  return players().every(p=>{
    const d=pickDoc(w,p.id),pk=d.picks||{};
    return gs.every(g=>pk[g.id]||g.w||now>=lockTime(g))&&(typeof d.tb==='number'||now>=lockTime(last));
  });
}
// Lock a week automatically once all picks are in. A week with any lock record
// (including one someone unlocked by hand) is left alone.
function maybeAutoLock(){
  if(!S.db||!S.ready||!S.picksLoaded||!S.locksLoaded)return;
  for(let w=1;w<=MAX_WEEK;w++){
    const key='w'+w;
    if(S.locks[key]||!allSubmitted(w))continue;
    S.locks={...S.locks,[key]:{week:w,locked:true,auto:true,at:new Date().toISOString()}};
    S.db.doc('locks/'+key).set(S.locks[key]).then(()=>toast(`Everyone’s picks are in. ${weekName(w)} is locked.`)).catch(()=>{const n={...S.locks};delete n[key];S.locks=n;render()});
    render();
  }
}

function setLock(w,locked){
  const key='w'+w,prev=S.locks[key];
  S.locks={...S.locks,[key]:{week:w,locked,at:new Date().toISOString()}};render();
  return S.db.doc('locks/'+key).set(S.locks[key])
    .then(()=>toast(locked?`${weekName(w)} picks locked`:`${weekName(w)} picks unlocked`))
    .catch(()=>{S.locks={...S.locks,[key]:prev};render();toast(locked?'The lock didn’t save. Try again.':'Only a parent can unlock picks.')});
}

/* ---- parent controls ---- */
let afterParent=null;
function requireParent(why,action){
  if(S.parent){action();return}
  if(!S.auth){toast('Parent sign-in isn’t available right now.');return}
  afterParent=action;
  $('#parentWhy').textContent=why;
  $('#parentErr').hidden=true;
  $('#parentPw').value='';
  $('#parentKeep').checked=false;
  $('#parentDlg').showModal();
  $('#parentPw').focus();
}
function signInError(code){
  if(code==='auth/too-many-requests')return 'Too many tries. Wait a few minutes, then try again.';
  if(code==='auth/network-request-failed')return 'No connection. Check your internet and try again.';
  if(code==='auth/operation-not-allowed'||code==='auth/configuration-not-found')return 'Parent sign-in isn’t turned on in Firebase yet.';
  return 'That password didn’t work. Try again.';
}
$('#parentUser').value=parentEmail||'';
$('#boxDlg').addEventListener('close',()=>{boxOpenId=null;clearTimeout(boxTimer)});
$('#boxDlg').addEventListener('click',(e)=>{if(e.target===e.currentTarget)closeBox()});
$('#profDlg').addEventListener('close',()=>{profOpen=null});
$('#profDlg').addEventListener('click',(e)=>{if(e.target===e.currentTarget)closeProfile()});
$('#pinDlg').addEventListener('cancel',(e)=>{e.preventDefault();closePin(true)});
$('#parentCancel').addEventListener('click',()=>{afterParent=null;$('#parentDlg').close()});
$('#parentForm').addEventListener('submit',async(e)=>{
  e.preventDefault();e.stopPropagation();
  const go=$('#parentGo');go.disabled=true;
  try{
    await signInWithEmailAndPassword(S.auth,parentEmail,$('#parentPw').value);
    const keep=$('#parentKeep').checked,action=afterParent;
    afterParent=null;$('#parentPw').value='';$('#parentDlg').close();
    try{if(action)await action()}
    finally{if(!keep)await signOut(S.auth)}
  }catch(err){
    $('#parentErr').textContent=signInError(err&&err.code);$('#parentErr').hidden=false;
  }finally{go.disabled=false}
});

// Locking a week is a parent's housekeeping, not a headline: a quiet padlock, drawn
// open once the week is locked, since that is what the tap would do next.
function lockButton(w){
  const on=weekLocked(w),label=on?`Unlock ${weekName(w)} picks`:`Lock all picks for ${weekName(w)}`;
  return `<button class="iconbtn" id="lockToggle" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(on?'Unlock picks':'Lock all picks')}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.8" y="10.5" width="14.4" height="9.7" rx="2.4"/><path d="${on?'M9 10.5V7.6a3.4 3.4 0 016.6-1.1':'M9 10.5V7.6a3 3 0 016 0v2.9'}"/></svg></button>`;
}

function renderPicks(app){
  const w=S.week,gs=weekGames(w),me=player(S.me),mine=picksFor(w,me.id);
  const sc=weekScore(w);
  const allLocked=gs.length>0&&gs.every(g=>locked(g));
  // Someone's open picks stay private until they enter their PIN on this device
  const canSee=allLocked||S.parent||isUnlocked(me.id);
  const shown=canSee?mine:Object.fromEntries(Object.entries(mine).filter(([id])=>{const g=gs.find(x=>x.id===id);return g&&locked(g)}));
  let h='';
  const byPlayer=Object.fromEntries(sc.rows.map(r=>[r.p.id,r]));
  const meRow=byPlayer[me.id];
  const summary=sc.done?`<span class="num">${meRow.right}–${meRow.wrong}</span>${meRow.up?` · <span class="upct">${meRow.up} winning now</span>`:''}`:'';
  const madeBy=(id)=>Object.keys(picksFor(w,id)).filter(id2=>gs.some(g=>g.id===id2)).length;
  // One row of faces: the highlighted face says who you are, so the name is not repeated above it
  h+=`<section class="viewer"><div class="pickers" role="group" aria-label="Choose whose picks to show">`;
  players().forEach(p=>{
    h+=`<button class="pk" style="--c:${esc(p.color)}" data-picker="${esc(p.id)}" aria-pressed="${p.id===me.id}" aria-label="Show ${esc(p.name)}’s picks"><span class="jersey av-${p.id}">${initial(p)}</span></button>`;
  });
  h+=`</div><div class="viewer-now"><b>${esc(me.name)}</b><span class="viewer-sum">${summary||`<span class="num">${madeBy(me.id)}/${gs.length}</span> picked`}</span>${isUnlocked(me.id)?'<button type="button" class="linkbtn sm" data-pin-signout>Sign out</button>':''}</div></section>`;
  const open=gs.filter(g=>!locked(g)&&!mine[g.id]).length;
  const defaults=players().every(p=>/^Player \d$/.test(p.name));
  const status=S.results?'<b>Entering results.</b> Tap the team that won each game.'
    :weekLocked(w)?`<b>${S.locks['w'+w].auto?`Everyone’s picks are in, so ${weekName(w)} is locked.`:`Picks are locked for ${weekName(w)}.`}</b> Everyone’s picks now show.`
    :!canSee?'Tap a team and enter your PIN · picks stay hidden'
    :open?`<span class="num">${gs.length-open}</span> of <span class="num">${gs.length}</span> picked · hidden until lock`
    :'All set · picks show when they lock';
  const jump=canSee&&open&&!S.results?'<button type="button" class="toggle" data-jump>Next pick</button>':'';
  // the one thing still open on a locked week, so nobody loses a tie by not noticing it
  const needsSecond=tb2Open(w)&&typeof pickDoc(w,me.id).tb2!=='number';
  if(allLocked)h+=`<div class="lockbar"><span class="pill">Locked</span><span class="lb-text">${needsSecond?`${esc(me.name)}, the Monday night tiebreaker is still open.`:weekLocked(w)&&S.locks['w'+w].auto?'Everyone’s picks are in.':'Picks are closed for this week.'}</span>${weekLocked(w)?lockButton(w):''}</div>`;
  else h+=`<div class="note pickbar"><span>${status}</span>
      <span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${defaults&&!S.results?'<button class="linkbtn" data-tab="family">Add your names</button>':''}${jump}${S.results?'':lockButton(w)}</span></div>`;

  let lastDay='',lastSlot='';
  gs.forEach(g=>{
    const d=new Date(g.t),day=g.tbd?weekName(w)+' · Date TBD':fmtDay.format(d);
    if(day!==lastDay){if(lastDay)h+='</section>';h+=`<section class="day"><div class="dayhead"><h2>${esc(day)}</h2></div>`;lastDay=day;lastSlot=''}
    const slot=g.tbd?'':fmtTime.format(d),badge=slotLabel(g);
    if(slot&&slot!==lastSlot){h+=`<h3 class="slothead">${esc(slot)}${badge?`<span class="slot">${esc(badge)}</span>`:''}</h3>`;lastSlot=slot}
    h+=gameCard(g,w,me,shown,g===gs[gs.length-1]);
  });
  h+='</section>';
  app.innerHTML=h;
  app.classList.toggle('resultmode',S.results);
}

// The row just tapped springs once and draws its tick
let justPicked=null;
function teamBtn(g,side,me,mine,pips){
  const t=g[side],isMine=mine[g.id]===t.ab,won=g.w===t.ab,lost=g.w&&g.w!=='TIE'&&!won;
  const live=!g.w&&g.st==='in',mineState=isMine?pickState(g,t.ab):'';
  const ahead=live&&(side==='a'?g.as>g.hs:g.hs>g.as),behind=live&&(side==='a'?g.as<g.hs:g.hs<g.as);
  const fresh=isMine&&justPicked&&justPicked.game===g.id&&justPicked.team===t.ab&&Date.now()-justPicked.at<1500;
  const cls=['team',isMine?'mine':'',mineState,won?'won':'',lost?'lost':'',behind?'behind':'',ahead?'ahead':'',fresh?'just':''].join(' ');
  const tag=mineState==='up'?'Winning':mineState==='down'?'Losing':mineState==='even'?'Tied':mineState==='ok'?'Right':mineState==='no'?'Wrong':'';
  const started=g.st!=='pre'||!!g.w;
  return `<button class="${cls}" style="--tc:${esc(t.c)};--me:${esc(me.color)}" data-game="${esc(g.id)}" data-team="${esc(t.ab)}" ${locked(g)?'aria-disabled="true"':''} ${isTbd(g)?'aria-disabled="true"':''} aria-pressed="${isMine}" aria-label="${esc(t.loc+' '+t.name+(t.rec?', '+t.rec:''))}">
    <span class="logo">${t.logo?`<img src="${esc(t.logo)}" alt="" width="30" height="30" loading="lazy">`:`<span class="ab">${esc(t.ab)}</span>`}</span>
    <span class="tn"><b>${esc(t.name)}</b><span class="sub">${tag?`<em class="tag">${tag}</em>`:`<span class="num">${esc(t.rec||t.loc)}</span>`}</span></span>
    <span class="pips">${pips||''}</span>
    ${started?`<span class="sc num${flashing(g,side)?' bump':''}">${side==='a'?g.as:g.hs}</span>`:'<span class="pickmark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6.5 12.6l3.8 3.8 7.2-8.2"/></svg></span>'}
  </button>`;
}

// The second guess, on the Monday night game. Open until that kickoff even on a locked
// week, so it is the one thing on a locked card that can still be typed into.
function secondGuessRow(g,w,me){
  if(tb2Open(w)){
    const ps=players(),inCount=ps.filter(p=>typeof pickDoc(w,p.id).tb2==='number').length;
    const saved=typeof pickDoc(w,me.id).tb2==='number',canSee=S.parent||isUnlocked(me.id);
    // A guess that is in but hidden used to render as an empty box, which reads as lost
    const state=saved?(canSee?'Saved':'Saved · hidden'):'Not in yet';
    return `<label class="tb tb-second"><span><b>Second tiebreaker</b> · ${esc(me.name)}, total points in this game? <small>Used only if the first guess ties too · <b class="num">${inCount}</b> of ${ps.length} in</small></span><span class="tb-in"><input type="number" min="0" max="150" inputmode="numeric" data-tb2="${esc(g.id)}" value="${saved&&canSee?pickDoc(w,me.id).tb2:''}" placeholder="${saved?'••':'–'}" aria-label="Second tiebreaker guess"><span class="tb-state${saved?' ok':''}">${esc(state)}</span></span></label>`;
  }
  const guesses=players().map(p=>{const v=pickDoc(w,p.id).tb2;return `<span class="guess"><span class="pip av-${p.id}" style="--c:${esc(p.color)}" title="${esc(p.name)}" aria-label="${esc(p.name)}">${initial(p)}</span>${typeof v==='number'?v:'–'}</span>`}).join('');
  return `<div class="tb tb-second"><span><b>Second tiebreaker</b>${g.w?` · final total <b class="num">${g.as+g.hs}</b>`:''}</span><div class="dots">${guesses}</div></div>`;
}
function tiebreakRow(g,w,me){
  if(!locked(g)){
    const saved=typeof pickDoc(w,me.id).tb==='number',canSee=S.parent||isUnlocked(me.id);
    const tb=canSee?pickDoc(w,me.id).tb:null;
    return `<label class="tb"><span><b>Tiebreaker</b> · ${esc(me.name)}, how many total points will both teams score?</span><span class="tb-in"><input type="number" min="0" max="150" inputmode="numeric" data-tb="${esc(g.id)}" value="${typeof tb==='number'?tb:''}" placeholder="${saved?'••':'–'}" aria-label="Tiebreaker guess for ${esc(me.name)}"><span class="tb-state${saved?' ok':''}">${saved?(canSee?'Saved':'Saved · hidden'):'Not in yet'}</span></span></label>`;
  }
  const guesses=players().map(p=>{const tb=pickDoc(w,p.id).tb;return `<span class="guess"><span class="pip av-${p.id}" style="--c:${esc(p.color)}" title="${esc(p.name)}" aria-label="${esc(p.name)}">${initial(p)}</span>${typeof tb==='number'?tb:'–'}</span>`}).join('');
  return `<div class="tb"><span><b>Tiebreaker guesses</b>${g.w?` · final total <b class="num">${g.as+g.hs}</b>`:''}</span><div class="dots">${guesses}</div></div>`;
}

// Spreads disappear from the feed at kickoff, so remember the last one seen on this device
const spreads=(()=>{try{return JSON.parse(store.get('spreads')||'{}')}catch{return {}}})();
function rememberLine(g){
  if(!g.spread)return false;
  const prev=spreads[g.id]||{};
  const next={s:g.spread,ou:g.ou,hl:g.hl,ml:g.ml&&g.ml.h!=null&&g.ml.a!=null?g.ml:prev.ml};
  if(JSON.stringify(prev)===JSON.stringify(next))return false;
  spreads[g.id]=next;return true;
}
function spreadText(g){
  rememberLine(g);
  const sp=g.spread?{s:g.spread,ou:g.ou}:spreads[g.id];
  if(sp)return `${sp.s}${sp.ou!=null?' · O/U '+sp.ou:''}`;
  const saved=(S.lines['w'+pickWeekOf(g.id)]||{})[g.id];
  if(saved&&saved.fav&&saved.line!=null)return `${saved.fav} -${saved.line}`;
  return `${g.a.ab} @ ${g.h.ab}`;
}

function gameCard(g,w,me,mine,isLast){
  const lk=locked(g);
  let status;
  if(g.w)status=`<span class="st final">${g.w==='TIE'?'Final · Tie':'Final'}</span>`;
  else if(g.st==='in')status=`<span class="st live">${esc(g.d||'Live')}</span>`;
  else if(Date.now()>=new Date(g.t).getTime())status=`<span class="st live">Kicked off${lk?'':' · picks open until '+fmtTime.format(new Date(lockTime(g)))}</span>`;
  else status=`<span class="st">${g.tbd?'Time TBD':`${esc(g.a.ab)} @ ${esc(g.h.ab)}`}${lk&&!weekLocked(w)?' · locked':''}</span>`;
  if(g.st==='in'&&g.sit&&g.sit.rz&&g.sit.pos)status+=`<span class="rzflag">${esc(g[g.sit.pos].ab)} RED ZONE</span>`;
  const who=players().map(p=>({p,pick:picksFor(w,p.id)[g.id]})).filter(x=>x.pick);
  // How many have picked is a chip on the meta line; the "hidden until they lock" half is said once, up top
  const count=!lk&&!isTbd(g)?`<span class="pcount num" title="${who.length} of ${players().length} picked">${who.length}/${players().length}</span>`:'';
  const pips=(ab)=>lk?who.filter(x=>x.pick===ab).map(x=>`<span class="pip ${pickState(g,x.pick)} av-${x.p.id}" style="--c:${esc(x.p.color)}" title="${esc(x.p.name)}" aria-label="${esc(x.p.name)}">${initial(x.p)}</span>`).join(''):'';
  let h=`<article class="game${flashing(g)?' flash':''}" data-card="${esc(g.id)}"><button type="button" class="gmeta" data-box="${esc(g.id)}" aria-label="Box score, ${esc(g.a.name)} at ${esc(g.h.name)}">${status}<span class="line">${count}${lk?esc(spreadText(g)):''}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span></button>
    <div class="rows">${teamBtn(g,'a',me,mine,pips(g.a.ab))}${teamBtn(g,'h',me,mine,pips(g.h.ab))}</div>`;
  if(isTbd(g))h+='<p class="sealed">Matchup is set once the previous round ends</p>';
  if(isLast)h+=tiebreakRow(g,w,me);
  const mon=mondayGame(w);
  if(mon&&mon.id===g.id)h+=secondGuessRow(g,w,me);
  return h+'</article>';
}

const fmtKick=new Intl.DateTimeFormat('en-US',{weekday:'short',hour:'numeric',minute:'2-digit'});
function renderAllPicks(app){
  // the same roster the week was scored against, or the header asks for a row that isn't there
  const w=S.week,gs=weekGames(w),ps=rosterFor(w),sc=weekScore(w);
  const rec=Object.fromEntries(sc.rows.map(r=>[r.p.id,r]));
  const anyOpen=gs.some(g=>!locked(g));
  let h=`<div class="note"><span>${anyOpen?'Open games show as ✓ until they lock':'Every game is locked · all picks show'}</span><span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${lockButton(w)}</span></div>`;
  h+=`<section class="card"><p class="legend"><span class="lg ok">✓ Right</span><span class="lg up">▲ Winning now</span><span class="lg down">▼ Losing now</span><span class="lg no">✗ Wrong</span></p><div class="scroll${ps.length>6?'':' dock'}"><table class="allpicks${ps.length>6?' wide':''}"><thead><tr><th>Game</th>${ps.map(p=>`<th class="${rec[p.id].right>0&&rec[p.id].right===Math.max(...sc.rows.map(x=>x.right))?'lead':''}" style="--c:${esc(p.color)}"><span class="jersey av-${p.id}">${initial(p)}</span><span class="pname">${esc(p.name)}</span><small class="num">${rec[p.id].right}–${rec[p.id].wrong}${rec[p.id].up?`<span class="upct"> · ${rec[p.id].up} ▲</span>`:''}</small></th>`).join('')}</tr></thead><tbody>`;
  gs.forEach(g=>{
    const show=locked(g);
    const status=g.w?(g.w==='TIE'?`Final · tie ${g.as}–${g.hs}`:`Final ${g.as}–${g.hs}`):g.st==='in'?`Live ${g.as}–${g.hs}${g.d?' · '+g.d:''}`:g.tbd?'Time TBD':fmtKick.format(new Date(g.t));
    h+=`<tr><td class="gcell"><b>${esc(g.a.ab)} @ ${esc(g.h.ab)}</b><span class="num">${esc(status)}</span></td>`;
    ps.forEach(p=>{
      const pick=picksFor(w,p.id)[g.id];
      if(!pick){h+='<td class="none" aria-label="No pick">—</td>';return}
      if(!show){h+='<td class="sealedc" aria-label="Picked, hidden until lock">✓</td>';return}
      const t=pick===g.a.ab?g.a:pick===g.h.ab?g.h:{c:'#555555'};
      const res=pickState(g,pick);
      const mark={ok:'<i class="mark" aria-label="correct">✓</i>',no:'<i class="mark" aria-label="wrong">✗</i>',up:'<i class="mark" aria-label="winning now">▲</i>',down:'<i class="mark" aria-label="losing now">▼</i>'}[res]||'';
      h+=`<td class="${res}"><span class="plogo" style="--tc:${esc(t.c)}" title="${esc(t.name||pick)}">${t.logo?`<img src="${esc(t.logo)}" alt="${esc(pick)}" width="26" height="26" loading="lazy">`:`<b>${esc(pick)}</b>`}</span>${mark}</td>`;
    });
    h+='</tr>';
  });
  const last=gs[gs.length-1],tbShow=locked(last);
  h+=`<tr class="tbrow"><td class="gcell"><b>Tiebreaker</b><span>Total points, ${esc(last.a.ab)} @ ${esc(last.h.ab)}${last.w?' · final '+(last.as+last.hs):''}</span></td>${ps.map(p=>{const tb=pickDoc(w,p.id).tb;return `<td class="num">${typeof tb!=='number'?'—':tbShow?tb:'✓'}</td>`}).join('')}</tr>`;
  const mon=mondayGame(w);
  if(mon)h+=`<tr class="tbrow"><td class="gcell"><b>Second tiebreaker</b><span>Total points, ${esc(mon.a.ab)} @ ${esc(mon.h.ab)}${mon.w?' · final '+(mon.as+mon.hs):''}</span></td>${ps.map(p=>{const v=pickDoc(w,p.id).tb2;return `<td class="num">${typeof v!=='number'?'–':(tb2Open(w)&&!(S.parent||isUnlocked(p.id))?'✓':v)}</td>`}).join('')}</tr>`;
  h+='</tbody></table></div>'+satOutNote(w)+'</section>';
  app.innerHTML=h;
}

/* ---- weekly win chances ---- */
// Standard normal CDF (Abramowitz-Stegun 7.1.26)
function phi(z){const t=1/(1+.3275911*Math.abs(z)/Math.SQRT2),y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-z*z/2);return z>=0?(1+y)/2:(1-y)/2}
function gauss(){let u=0;while(!u)u=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*Math.random())}
function impliedProb(o){return o<0?-o/(-o+100):100/(o+100)}
// Share of regulation still to play (overtime counts as a sliver)
function timeLeft(g){
  if(g.st!=='in'||!g.period)return 1;
  if(g.period>4)return Math.max(0,Math.min(1,g.clock/3600));
  return Math.max(0,Math.min(1,((4-g.period)*900+g.clock)/3600));
}
function homeWinProb(g){
  if(g.w)return g.w===g.h.ab?1:g.w==='TIE'?.5:0;
  const c=spreads[g.id]||{},ml=g.ml&&g.ml.h!=null&&g.ml.a!=null?g.ml:c.ml,hl=g.hl!=null?g.hl:c.hl;
  let pre=.5;
  if(ml&&ml.h!=null&&ml.a!=null){const ih=impliedProb(ml.h),ia=impliedProb(ml.a);pre=ih/(ih+ia)}
  else if(hl!=null)pre=phi(-hl/13.5);
  if(g.st!=='in')return pre;
  if(g.liveProb!=null)return g.liveProb;
  if(S.liveProb[g.id])return S.liveProb[g.id].p;
  // Fallback: current margin plus the pregame line scaled to the time left
  const f=timeLeft(g),line=hl!=null?hl:-13.5*(pre-.5)*2.5;
  return phi(((g.hs-g.as)-line*f)/(13.5*Math.sqrt(Math.max(f,.003))));
}
function totalSampler(g){
  if(g.w)return ()=>g.as+g.hs;
  const c=spreads[g.id]||{},ou=g.ou??c.ou??44,cur=g.as+g.hs,f=timeLeft(g);
  const mean=cur+ou*f,sd=Math.max(1,13*Math.sqrt(f));
  return ()=>Math.max(cur,Math.round(mean+sd*gauss()));
}
const SIMS=20000;
let chanceCache={key:'',value:null};
function winChances(w){
  const games=weekGames(w);
  if(!games.length)return null;
  // Until picks lock, anyone can still pick, so a chance would be guesswork
  if(games.some(g=>!locked(g,w)))return null;
  const ps=players(),last=games[games.length-1];
  const pending=games.filter(g=>!g.w).map(g=>({g,ph:homeWinProb(g)}));
  if(!pending.length)return null;
  const docs=ps.map(p=>pickDoc(w,p.id));
  const mon=mondayGame(w);
  const key=JSON.stringify([w,pending.map(x=>[x.g.id,Math.round(x.ph*1000)]),games.filter(g=>g.w).map(g=>g.id+g.w),last.as,last.hs,last.period,last.clock,
    mon?[mon.id,mon.as,mon.hs,mon.period,mon.clock,mon.w||'']:null,docs.map(d=>[d.picks,d.tb,d.tbAt,d.tb2])]);
  if(chanceCache.key===key)return chanceCache.value;
  const picks=docs.map(d=>d.picks||{});
  const base=ps.map((p,i)=>games.filter(g=>g.w&&g.w!=='TIE'&&picks[i][g.id]===g.w).length);
  const pickIdx=pending.map(({g})=>picks.map(pk=>pk[g.id]===g.h.ab?1:pk[g.id]===g.a.ab?0:-1));
  const guesses=docs.map(d=>({tb:typeof d.tb==='number'?d.tb:null,tb2:typeof d.tb2==='number'?d.tb2:null,tbAt:tbMillis(d.tbAt)}));
  const sampleTotal=totalSampler(last),sampleMon=mon?totalSampler(mon):null;
  const wins=new Array(ps.length).fill(0),score=new Array(ps.length);
  for(let n=0;n<SIMS;n++){
    for(let i=0;i<ps.length;i++)score[i]=base[i];
    for(let k=0;k<pending.length;k++){
      const homeWon=Math.random()<pending[k].ph?1:0,row=pickIdx[k];
      for(let i=0;i<ps.length;i++)if(row[i]===homeWon)score[i]++;
    }
    const total=sampleTotal(),total2=sampleMon?sampleMon():null;
    let best=0;
    for(let i=1;i<ps.length;i++){
      // positive: i overtakes the leader so far; a dead heat keeps the earlier person, as the standings do
      const d=score[i]-score[best]||-compareTiebreak(guesses[i],guesses[best],total,total2);
      if(d>0)best=i;
    }
    wins[best]++;
  }
  // Out: can't even catch the current leader by winning every remaining pick
  const lead=Math.max(...base);
  const value={out:new Set(),p:{}};
  ps.forEach((p,i)=>{
    value.p[p.id]=wins[i]/SIMS;
    const canGain=pickIdx.filter(row=>row[i]!==-1).length;
    if(base[i]+canGain<lead)value.out.add(p.id);
  });
  chanceCache={key,value};
  return value;
}
// A running log of win chances, sampled as the scores come in, so the board can say
// who has been climbing. Anything older than twelve minutes is dropped.
function logChances(w,ch){
  if(!ch)return;
  const log=S.chanceLog['w'+w]||(S.chanceLog['w'+w]=[]),now=Date.now(),last=log[log.length-1];
  if(!last||now-last.at>=25e3)log.push({at:now,p:{...ch.p}});
  while(log.length>2&&now-log[0].at>12*6e4)log.shift();
}
// The biggest move since the oldest sample still in the log. The simulation carries a
// little sampling noise of its own, so small drifts are not worth announcing.
function swingNow(w,ch){
  const log=S.chanceLog['w'+w]||[];
  if(!ch||log.length<2)return null;
  const base=log[0];let best=null;
  for(const [id,v] of Object.entries(ch.p)){
    if(base.p[id]==null)continue;
    const d=v-base.p[id];
    if(!best||Math.abs(d)>Math.abs(best.d))best={id,d};
  }
  if(!best||Math.abs(best.d)<.04)return null;
  return {...best,from:base.p[best.id],to:ch.p[best.id],mins:Math.max(1,Math.round((Date.now()-base.at)/6e4))};
}
const pctText=(v)=>v>=1?'100%':v>.99?'>99%':v<=0?'0%':v<.01?'<1%':Math.round(v*100)+'%';
function chanceLabel(ch,id){
  if(isOut(ch,id))return 'Out';
  return pctText(ch.p[id]);
}
// Eliminated, or simulated at a flat zero: "0% to win" next to "2 games left" reads as a bug
function isOut(ch,id){return ch.out.has(id)||!(ch.p[id]>0)}
function chanceHtml(ch,r){
  if(!ch)return '<span></span>';
  const out=isOut(ch,r.p.id);
  return `<div class="chance${out?' out':''}" aria-label="${esc(r.p.name)} win chance ${chanceLabel(ch,r.p.id)}"><b class="num">${chanceLabel(ch,r.p.id)}</b><small>to win</small></div>`;
}

// Every game of the week at a glance, sized for a screen across the room.
// Live games come first, then the ones about to start, then the finals.
function renderTv(app){
  const w=S.week,gs=weekGames(w),sc=weekScore(w),chances=sc.complete?null:winChances(w);
  logChances(w,chances);
  // live first, and inside that the games about to turn: one score late, then the red zone
  const inRz=(g)=>g.st==='in'&&g.sit&&g.sit.rz&&!!g.sit.pos;
  const tight=(g)=>g.st==='in'&&g.period>=4&&g.clock>0&&g.clock<=120&&Math.abs(g.as-g.hs)<=8;
  const rank=(g)=>g.st==='in'?(tight(g)?-2:inRz(g)?-1:0):g.w?2:1;
  const order=[...gs].sort((a,b)=>rank(a)-rank(b)||a.t.localeCompare(b.t));
  // the underdog is ahead, or got there: the reason to look up from your phone
  const lines=S.lines['w'+w]||{};
  const upset=(g)=>{
    const f=lines[g.id];
    if(!f||!f.fav||g.st==='pre')return null;
    const dog=f.fav===g.h.ab?g.a:g.h,ds=f.fav===g.h.ab?g.as:g.hs,fs=f.fav===g.h.ab?g.hs:g.as;
    if(g.w)return g.w===dog.ab?{dog,line:f.line,done:true}:null;
    return ds>fs?{dog,line:f.line,done:false}:null;
  };
  const side=(g,k)=>{
    const t=g[k],score=k==='a'?g.as:g.hs,other=k==='a'?g.hs:g.as;
    const lead=(g.st!=='pre'||g.w)&&score>other;
    const who=locked(g,w)?players().filter(p=>picksFor(w,p.id)[g.id]===t.ab):[];
    return `<div class="tv-side${lead?' lead':''}" style="--tc:${esc(t.c)}">
      <span class="tv-logo">${t.logo?`<img src="${esc(t.logo)}" alt="" width="54" height="54">`:esc(t.ab)}</span>
      <b>${esc(t.ab)}</b>
      <span class="tv-sc num">${g.st==='pre'&&!g.w?'':score}</span>
      <span class="tv-pips">${who.map(p=>`<span class="pip av-${p.id}" style="--c:${esc(p.color)}" title="${esc(p.name)}" aria-label="${esc(p.name)}">${initial(p)}</span>`).join('')}</span>
    </div>`;
  };
  // Live-only is a view, not a filter that can empty the screen: with nothing being
  // played it shows the whole week and says so.
  const playing=order.filter(g=>g.st==='in');
  const solo=S.tvLive&&playing.length>0;
  const shown=solo?playing:order;
  let h=`<div class="tv-wrap${solo?' solo':''}"><div class="tv-games">`;
  h+=shown.map(g=>{
    const state=g.w?(g.w==='TIE'?'Final · tie':'Final'):g.st==='in'?(g.d||'Live'):fmtKick.format(new Date(g.t));
    const rz=inRz(g)?`<span class="rzflag">${esc(g[g.sit.pos].ab)} RED ZONE</span>`:'';
    const up=upset(g);
    const close=tight(g)?`<span class="closeflag">${g.as===g.hs?'TIED':'ONE SCORE'} · ${esc(clockText(g.clock))}</span>`:'';
    const flag=up?`<span class="upflag${up.done?' done':''}">${esc(up.dog.ab)} ${up.done?'UPSET':'UPSET ALERT'}${up.line?` · +${up.line}`:''}</span>`:'';
    return `<article class="tv-game${g.st==='in'?' on':''}${inRz(g)?' rz':''}${up&&!up.done?' upset':''}${tight(g)?' tight':''}"><header><span class="${g.st==='in'?'st live':'st'}">${esc(state)}</span>${close}${flag}${rz}</header><div class="tv-row">${side(g,'a')}<span class="tv-at">–</span>${side(g,'h')}</div>${g.st==='in'?`<div class="tv-field">${fieldView(g)}</div>`:''}</article>`;
  }).join('');
  h+=`</div><aside class="tv-board"><h2>${esc(weekName(w))} · ${sc.complete?'Final':`${sc.done}/${sc.total} final`}</h2>`;
  h+=`<button type="button" class="tv-only${S.tvLive?' on':''}" data-tvlive aria-pressed="${S.tvLive}">${S.tvLive?`Live games only${playing.length?` · ${playing.length}`:''}`:'Show live games only'}</button>`;
  if(S.tvLive&&!playing.length)h+='<p class="tv-note">Nothing is being played right now, so here is the whole week.</p>';
  const sw=swingNow(w,chances);
  if(sw){
    const p=player(sw.id);
    h+=`<div class="tv-swing ${sw.d>0?'up':'down'}">
      <p class="sw-head">Biggest swing in win chance · last ${sw.mins} min</p>
      <span class="jersey av-${sw.id}" style="--c:${esc(p.color)}">${initial(p)}</span>
      <b class="sw-who">${esc(p.name)}</b>
      <span class="sw-move num"><i>${esc(pctText(sw.from))}</i><em>${sw.d>0?'▲':'▼'}</em><b>${esc(chanceLabel(chances,sw.id))}</b></span>
    </div>`;
  }
  h+=sc.rows.map((r,i)=>`<div class="tv-rank" style="--c:${esc(r.p.color)}"><span class="num">${i+1}</span><span class="jersey av-${r.p.id}">${initial(r.p)}</span><b>${esc(r.p.name)}</b><span class="tv-rec num">${r.right}–${r.wrong}</span><span class="tv-ch num">${chances?chanceLabel(chances,r.p.id):`+${r.pts}`}</span></div>`).join('');
  h+=satOut(w).map(p=>`<div class="tv-rank sat" style="--c:${esc(p.color)}"><span class="num">–</span><span class="jersey av-${p.id}">${initial(p)}</span><b>${esc(p.name)}</b><span class="tv-rec num">–</span><span class="tv-ch">Sat out</span></div>`).join('');
  h+='</aside></div>';
  app.innerHTML=h;
}
function renderStandings(app){
  const w=S.week,sc=weekScore(w),chances=sc.complete?null:winChances(w),stats=seasonStats();
  let h='';
  if(sc.complete)h+=recapCard(w,sc);
  h+=`<section class="card"><p class="eyebrow">${weekName(w)} · ${sc.complete?'Final':`${sc.done} of ${sc.total} final`}</p><div class="rank">${chances?'<canvas class="sparks" aria-hidden="true"></canvas>':''}`;
  let pos=0,prev=null;
  sc.rows.forEach((r,i)=>{
    if(sc.complete)pos=r.place; else if(prev===null||r.right!==prev){pos=i+1;prev=r.right}
    if(!sc.done)pos='–';
    // Every row gets a second line so names stay in one column
    const left=sc.total-sc.done;
    const notes=[];
    if(!sc.done)notes.push(`${r.made}/${sc.total} picked`);
    else if(!sc.complete&&r.up)notes.push(`<b class="upct">${r.up} winning now</b>`);
    else if(!sc.complete)notes.push(`${left} game${left===1?'':'s'} left`);
    else notes.push(r.tied?`Tiebreaker ${r.tb===null?'—':r.tb}`:'Final');
    const spoon=sc.complete&&r.place===sc.rows.length;
    // Win chance fills the row from the left in the person's color
    const fill=chances?(isOut(chances,r.p.id)?0:Math.round((chances.p[r.p.id]||0)*100)):0;
    const leadChance=chances&&fill>0&&fill===Math.max(...sc.rows.map(x=>isOut(chances,x.p.id)?0:Math.round((chances.p[x.p.id]||0)*100)));
    // Fill animates from the last value shown; a redraw mid-animation picks up where it left off
    const fkey=w+':'+r.p.id,prevFill=S.fillShown[fkey],now=Date.now();
    let from=0,start=now;
    if(prevFill){if(prevFill.to===fill){from=prevFill.from;start=prevFill.start}else{from=prevFill.to}}
    if(chances)S.fillShown[fkey]={from,to:fill,start};
    const dur=600+Math.round(1200*fill/100),elapsed=now-start,filling=chances&&from!==fill&&elapsed<dur;
    h+=`<div class="rrow${chances?' has-chance':''}${leadChance?' lead':''}${filling?' filling':''}" data-profile="${r.p.id}" style="--c:${esc(r.p.color)};--p:${fill}%;--p0:${from}%;--g:${(fill/100).toFixed(2)};--dur:${dur}ms;--delay:-${filling?elapsed:0}ms;--edge:${fill>0&&fill<100?1:0}"><span class="pos num">${pos}</span><span class="jersey av-${r.p.id}">${initial(r.p)}</span>
      <div class="who"><b>${esc(r.p.name)} ${sc.complete&&r.place===1?'<span class="crown" aria-label="Week winner">★</span>':''}${spoon?`<span class="spoon" title="Wooden Spoon">${badgeIcon(BADGE.spoon)}</span>`:''}</b><span class="num">${notes.join(' · ')}</span></div>
      ${chanceHtml(chances,r)}<div class="rec num">${r.right}–${r.wrong}<small>${sc.complete?`<b class="ptsb">+${r.pts} pts</b>`:'W–L'}</small></div></div>`;
  });
  satOut(w).forEach(p=>{
    h+=`<div class="rrow sat" data-profile="${p.id}" style="--c:${esc(p.color)}"><span class="pos num">–</span><span class="jersey av-${p.id}">${initial(p)}</span>
      <div class="who"><b>${esc(p.name)}</b><span>Sat out · no picks</span></div><span></span><div class="rec num">–<small>${sc.complete?'0 pts':'W–L'}</small></div></div>`;
  });
  h+='</div></section>';
  h+=seasonSection(stats,false);
  if(Object.values(stats).some(o=>Object.keys(o.weeks).some(k=>+k>18)))h+=seasonSection(stats,true);
  h+=trophyCase(stats);
  h+=`<details class="rules"><summary>How scoring works</summary><p class="muted">Each week ends with a final order by correct picks. 1st place gets 3 points, 2nd gets 2 and 3rd gets 1; last place gets the Wooden Spoon. If people tie on correct picks, the closest guess of total points in the week’s last game goes ahead, then a guess that didn’t go over, then whoever saved their guess first. Tied NFL games don’t count, and a missed pick counts as a loss. Anyone with no picks and no tiebreaker guess in a week sits it out: no wins, losses or points, and they show as “Sat out.” Season standings count regular-season points only; the playoffs have their own standings. People tied on points share the spot. Win chances play out the rest of the week 20,000 times using ESPN’s live win probability (betting odds before kickoff) and everyone’s tiebreaker guesses. Badge emblems by Lorc and Delapouite from game-icons.net, used under CC BY 3.0. Badges: Weekly Champ (1st in a week), Perfect Week (every pick right), Upset Artist (picked an underdog that won), Hot Streak (5 right in a row), Tiebreak Wizard (exact tiebreaker total) and Wooden Spoon (last in a week).</p></details>`;
  app.innerHTML=h;
  if(chances)startSparks();
}

/* ---- sparks thrown off each win-chance edge ---- */
const sparks={parts:[],raf:0,last:0,moving:{},emitted:{}};
function startSparks(){
  if(sparks.raf||document.hidden||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  sparks.last=performance.now();
  sparks.raf=requestAnimationFrame(sparkFrame);
}
// Sparks fly only while a fill is moving, with a burst when it lands; then the loop shuts off
function sparkFrame(t){
  const canvas=document.querySelector('.rank canvas.sparks');
  if(!canvas||document.hidden){sparks.raf=0;sparks.parts.length=0;sparks.moving={};return}
  const dt=Math.min(50,t-sparks.last)/1000;sparks.last=t;
  const box=canvas.parentElement,br=box.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  const W=Math.round(br.width),H=Math.round(br.height);
  if(canvas.width!==W*dpr||canvas.height!==H*dpr){canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.width=W+'px';canvas.style.height=H+'px'}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  let anyMoving=false;
  for(const row of box.querySelectorAll('.rrow.has-chance')){
    const cs=getComputedStyle(row),f=parseFloat(cs.getPropertyValue('--f'))||0,target=parseFloat(cs.getPropertyValue('--p'))||0,g=parseFloat(cs.getPropertyValue('--g'))||0;
    const id=row.dataset.profile,moving=Math.abs(target-f)>.05,landed=!moving&&sparks.moving[id];
    sparks.moving[id]=moving;
    if(f<=0&&target<=0)continue;
    const rr=row.getBoundingClientRect(),x=rr.left-br.left+rr.width*f/100,top=rr.top-br.top,c=row.style.getPropertyValue('--c')||'#ffffff';
    let count=0;
    if(moving){anyMoving=true;count=(45+150*g)*dt;if(Math.random()<dt*5)count+=4+10*g}
    else if(landed)count=12+28*g;
    for(let n=count;n>0;n--){if(n<1&&Math.random()>n)break;emitSpark(x,top,rr.height,g,c,id,landed)}
  }
  ctx.globalCompositeOperation='lighter';ctx.lineCap='round';
  sparks.parts=sparks.parts.filter(p=>{
    p.life+=dt;if(p.life>=p.max)return false;
    p.vx*=.9;p.vy=p.vy*.9+300*dt;
    const nx=p.x+p.vx*dt,ny=p.y+p.vy*dt,tx=nx-p.vx*.045,ty=ny-p.vy*.045,a=1-p.life/p.max;
    // Sparks keep the person's colour: white cores blended additively to a white field,
    // and white text over a white field is no text at all
    ctx.strokeStyle=p.c;ctx.globalAlpha=.34*a;ctx.lineWidth=p.w*4;ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(nx,ny);ctx.stroke();
    ctx.globalAlpha=.7*a;ctx.lineWidth=p.w*1.1;ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(nx,ny);ctx.stroke();
    p.x=nx;p.y=ny;return true;
  });
  if(sparks.parts.length>450)sparks.parts.splice(0,sparks.parts.length-450);
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  if(!anyMoving&&!sparks.parts.length){sparks.raf=0;ctx.clearRect(0,0,W,H);return}
  sparks.raf=requestAnimationFrame(sparkFrame);
}
function emitSpark(x,top,h,g,c,id,burst){
  const speed=(130+420*g)*(.35+Math.random())*(burst?1.35:1),ang=(Math.random()-.4)*Math.PI*(burst?1.7:1);
  sparks.parts.push({x,y:top+3+Math.random()*(h-6),vx:Math.cos(ang)*speed,vy:Math.sin(ang)*speed-50,life:0,max:.28+Math.random()*(.3+.5*g),w:1+Math.random()*(1.4+1.4*g),c});
  sparks.emitted[id]=(sparks.emitted[id]||0)+1;
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&S.tab==='standings')startSparks()});

/* ---- season stats, badges, recap, chart ---- */
// How rare a badge is meant to be; the colour and label come from the tier, not the badge
const TIER={
  common:{label:'Common',color:'#8A93A3',rank:0},
  rare:{label:'Rare',color:'#4DB3FF',rank:1},
  epic:{label:'Epic',color:'#A983FF',rank:2},
  legendary:{label:'Legendary',color:'#F5B400',rank:3},
  mythic:{label:'Mythic',color:'#FF4FD8',rank:4},
};
const BADGE={
  postseason:{tier:'mythic',name:'Perfect Postseason',desc:'Win all four playoff weeks',color:'#FF4FD8',icon:'<path d="M256 25c-11.594 0-23 12.8-23 31s11.406 31 23 31 23-12.8 23-31-11.406-31-23-31zm-103.951 2.975l-16.098 8.05c15.092 30.185 51.37 56.81 82.188 74.442L232.334 295H247V192h18v103h14.666l14.195-184.533c30.818-17.632 67.096-44.257 82.188-74.442l-16.098-8.05c-19.91 29.9-44.891 49.148-71.334 57.77C281.311 97.28 269.75 105 256 105c-13.75 0-25.31-7.72-32.617-19.256-26.443-8.62-51.424-27.87-71.334-57.77zM169 313v96H25v78h462v-30H343V313H169z"/>',count:o=>o.postseason},
  champion:{tier:'legendary',name:'Champion',desc:'Win the season',color:'#FFC93C',icon:'<path d="M98.398 21.146a17.092 17.092 0 0 0-4.636.521c-20.49 5.262-33.163 20.63-36.116 38.649-2.952 18.019 2.168 38.346 12.676 58.193 20.695 39.086 63.262 77.08 117.852 85.85-5.61-6.72-11.05-14.246-16.274-22.375-39.008-12.57-70.021-42.344-85.67-71.899-9.206-17.387-12.846-34.491-10.82-46.857C77.437 50.862 83.482 42.89 98.238 39.1c.065-.017.068-.034.092-.053-.065-.143.105-.08 0 0 .022.049.061.11.176.217.527.493 1.689 2.24 2.207 5.14 1.036 5.804-.413 15.593-8.135 25.68l14.293 10.942c10.418-13.61 13.65-28.086 11.56-39.785-1.044-5.85-3.396-11.165-7.628-15.124-3.174-2.969-7.747-4.868-12.405-4.972zm315.204 0c-4.658.104-9.23 2.003-12.405 4.972-4.232 3.96-6.584 9.274-7.629 15.124-2.089 11.699 1.143 26.174 11.56 39.785l14.294-10.942c-7.722-10.087-9.171-19.876-8.135-25.68.518-2.9 1.68-4.647 2.207-5.14a.695.695 0 0 0 .176-.217c-.105-.08.065-.143 0 0 .024.019.027.036.092.053 14.756 3.79 20.801 11.76 22.828 24.127 2.026 12.366-1.614 29.47-10.82 46.857-15.649 29.555-46.662 59.33-85.67 71.899-5.223 8.129-10.665 15.655-16.274 22.375 54.59-8.77 97.157-46.764 117.852-85.85 10.508-19.847 15.628-40.174 12.676-58.193-2.953-18.02-15.626-33.387-36.116-38.649a17.092 17.092 0 0 0-4.636-.521zm-276.166 7.713c2.146 36.533 16.76 83.07 36.537 120.824 10.707 20.442 22.876 38.334 34.761 50.685C220.62 212.72 232 218.858 240 218.858h32c8 0 19.38-6.138 31.266-18.49 11.885-12.351 24.054-30.243 34.761-50.685 19.777-37.755 34.39-84.29 36.537-120.824H137.436zm95.564 208v16h46v-16h-46zm6.445 34c-2.458 25.967-12.796 57.873-24.437 76h81.984c-11.64-18.127-21.979-50.033-24.437-76h-33.11zm-38.445 94v14h110v-14H201zm-32 32v94h174v-94H169zm23 23h128v48H192v-48z"/>',count:o=>o.champion},
  longgame:{tier:'legendary',name:'The Long Game',desc:'Last at the halfway mark, first at the end',color:'#C9A227',icon:'<path d="M115.063 21.97v9.343c0 101.953 38.158 189.648 96.343 222.093v6.094c-58.186 32.445-96.344 120.14-96.344 222.094v9.344H401.81v-9.344c0-102.552-38.804-190.274-97.53-222.188V253.5c58.722-31.917 97.53-119.64 97.53-222.188V21.97H115.06zM134 40.655h248.875c-2.477 96.445-42.742 175.523-91.938 198.906l-5.343 2.532V270.844l5.344 2.53c49.193 23.383 89.456 102.438 91.937 198.876H134c2.456-95.898 42.125-175.078 90.875-198.938l5.25-2.562v-28.594l-5.25-2.562c-48.748-23.86-88.42-103.04-90.875-198.938zm213.656 86.125c-57.607 27.81-124.526 27.84-177.562 4.095C184.748 181.78 213.91 218.012 248.22 224c-1.54 2.047-2.47 4.585-2.47 7.344 0 6.76 5.488 12.25 12.25 12.25s12.25-5.49 12.25-12.25c0-2.72-.907-5.218-2.406-7.25 35.426-5.88 65.488-44.07 79.812-97.313zM258 258.626c-6.762 0-12.25 5.488-12.25 12.25s5.488 12.25 12.25 12.25 12.25-5.488 12.25-12.25-5.488-12.25-12.25-12.25zm0 39.28c-6.762 0-12.25 5.49-12.25 12.25 0 6.763 5.488 12.25 12.25 12.25s12.25-5.487 12.25-12.25c0-6.76-5.488-12.25-12.25-12.25zm0 39.533c-6.762 0-12.25 5.488-12.25 12.25 0 6.76 5.488 12.25 12.25 12.25s12.25-5.49 12.25-12.25c0-6.762-5.488-12.25-12.25-12.25zm.125 39.906c-23.21.28-46.19 25.77-75.813 75.656h153c-30.523-51.003-53.977-75.936-77.187-75.656z"/>',count:o=>o.longgame},
  wire:{tier:'epic',name:'Wire to Wire',desc:'Lead the standings after every week',color:'#7FD1FF',icon:'<path d="M375.7 20.11l-15.6 3.53c5.5 24.18 10.9 48.4 16.4 72.61-12.4-1.91-22.7-3.61-34-5.36l6.5 28.91c12.4 1.6 22.6 3.6 34 5.3l7.6 33.6c9.4 41.6 18.9 83.3 28.3 124.9-12.4-1.9-22.6-3.7-34-5.4l6.5 28.8c12.3 2.1 22.7 3.4 34 5.4 13.6 59.8 27 119.7 40.6 179.5l15.6-3.7c-37.4-162.5-73.8-328.9-105.9-468.09zM391.4 307c-12.9-1.9-23.9-3.4-33.7-4l7.4 32.9h.4c12.2 1.3 22.5 3.1 33.5 4.7zm-33.7-4l-6.7-29.5c-14.4-1.5-24.2-1.5-32.7.3l7 31.3c10.4-2.4 20.6-2.9 32.4-2.1zm-32.4 2.1c-10.3 2.4-19.7 6.3-30.1 12l7.4 32.7c9.8-5.2 20.1-11.2 29.8-13.4zm-30.1 12l-6.6-29.5c-7.8 4.8-17.2 11.1-28.6 18.8l6.5 28.9c10.8-7.4 20.2-13.4 28.7-18.2zm-28.7 18.2c-10.3 7-18.9 13-28.4 19.5l7.6 33.2c10-7.2 18.8-13.1 28.3-19.6zm-28.4 19.5l-6.5-28.9c-10.8 7.4-20.1 13.4-28.7 18.2l6.7 29.5c7.8-4.8 17.2-11.1 28.5-18.8zm-28.5 18.8c-12.3 7.5-21.2 11.7-29.7 13.7l7 31.2c10.4-2.4 19.8-6.4 30.1-12.1zm-29.7 13.7l-7.1-31.2c-10.3 2.3-20.5 2.8-32.3 2.1l6.7 29.5c14.3 1.5 24.1 1.5 32.7-.4zm-32.7.4c-9.1-.9-20.3-2.6-33.9-4.7l7.6 33.6s16 2.9 33.7 4zm-33.9-4.7l-6.5-28.8c-12.35-2-22.71-3.4-34.02-5.4l6.53 28.8c12.36 1.8 22.69 3.8 33.99 5.4zm-6.5-28.8c12.9 1.9 23.9 3.4 33.7 4l-7.5-32.9c-9.1-1-20.2-2.6-33.8-4.7zm-7.6-33.6l-6.52-28.9c-12.39-1.8-22.66-3.7-34.02-5.3l6.52 28.8c12.35 2 22.71 3.4 34.02 5.4zm-6.52-28.9c12.82 2 23.92 3.5 33.72 4.1l-7.5-32.9c-9.1-1-20.19-2.6-33.82-4.7zm-7.6-33.6l-6.52-28.9c-12.38-1.8-22.66-3.6-34.02-5.2l6.52 28.8c12.38 1.9 22.64 3.7 34.02 5.3zm-6.52-28.9c12.89 2 23.94 3.5 33.74 4.1l-7.5-33c-9.07-.9-20.22-2.5-33.84-4.7zm-7.6-33.6l-6.52-28.8c-12.33-2.1-22.71-3.3-34.02-5.3l6.52 28.9c12.36 1.9 22.66 3.6 34.02 5.2zm-6.52-28.8c12.89 2 23.93 3.5 33.72 4l-7.45-32.9c-11.72-2.1-24.9-3.3-33.87-4.7zm33.72 4l6.64 29.5c14.4 1.6 24.2 1.5 32.7-.4l-7-31.2c-10.4 2.4-20.6 2.9-32.34 2.1zm32.24-2.1c10.4-2.3 19.8-6.3 30.2-12l-7.5-32.9c-12.3 7.5-21.2 11.7-29.7 13.7zm-7-31.2c-.1 0-.1 0 0 0zm37.2 19.2l6.6 29.5c7.8-4.8 17.2-11 28.6-18.8l-6.6-28.8c-10.7 7.3-20.1 13.4-28.6 18.1zm28.6-18.1c10.3-7 18.9-13.1 28.5-19.4l-7.6-33.66c-10.4 7.05-19 13.01-28.5 19.56zm28.5-19.4l6.5 28.7c10.8-7.3 20.1-13.4 28.7-18.1l-6.7-29.5c-7.8 4.8-17.2 11.1-28.5 18.9zm28.5-18.9c12.3-7.55 21.2-11.74 29.7-13.68l-7-31.2c-11.1 3-21.8 7.36-30.1 11.95zm29.7-13.68l7.1 31.28c10.3-2.4 20.5-2.9 32.3-2.2l-6.7-29.53c-14.3-1.51-24.1-1.48-32.7.45zm32.7-.45c9.1.97 20.3 2.59 33.9 4.72l-7.6-33.59s-16.1-2.91-33.7-4.03zm6.7 29.53l7.4 32.8c9.2 1 20.3 2.6 33.9 4.8l-7.6-33.5c-12.9-2-23.9-3.5-33.7-4.1zm41.3 37.6l6.5 28.8c12.4 1.9 22.7 3.7 34.1 5.3l-6.6-28.8c-12.4-1.9-22.7-3.7-34-5.3zm6.5 28.8c-12.8-2-23.9-3.5-33.7-4l7.5 33c9.1.9 20.2 2.5 33.8 4.6zm7.6 33.6l6.6 28.9c12.4 2 22.7 3.4 34 5.3l-6.5-28.9c-12.4-1.8-22.7-3.7-34.1-5.3zm6.6 28.9c-12.9-2-24-3.5-33.8-4l7.5 32.9c9.1.8 20.2 2.6 33.9 4.7zm-33.8-4l-6.6-29.5c-14.4-1.6-24.2-1.5-32.7.4l7 31.1c10.3-2.3 20.6-2.8 32.3-2zm-32.3 2c-10.3 2.5-19.8 6.4-30.1 12l7.5 33c12.3-7.5 21.1-11.8 29.7-13.8zm-30.1 12l-6.7-29.5c-7.8 4.9-17.1 11-28.5 18.9l6.5 28.8c10.8-7.3 20.1-13.5 28.7-18.2zm-28.7 18.2c-10.5 6.9-18.7 13.2-28.4 19.5l7.6 33.6c10.4-7 19-13 28.4-19.5zM224 292.2l-6.5-28.8c-10.8 7.3-20.1 13.4-28.7 18.2l6.7 29.5c7.8-4.8 17.1-11.1 28.5-18.9zm-28.5 18.9c-12.3 7.5-21.2 11.7-29.7 13.6l7 31.4c10.3-2.4 19.8-6.4 30.1-12zm-29.7 13.6l-7.1-31.1c-10.3 2.3-20.5 2.8-32.2 2.1l6.5 29.5c14.4 1.5 24.2 1.5 32.8-.5zm-7.1-31.1c10.3-2.4 19.8-6.2 30.1-11.9l-7.4-33.1c-12.3 7.7-21.2 11.9-29.8 13.7zm-7.1-31.3l-7-31.2c-10.3 2.4-20.5 3-32.2 2.2l6.6 29.5c14.3 1.5 24.1 1.5 32.6-.5zm-7-31.2c10.3-2.3 19.7-6.3 30.1-12l-7.5-32.9c-12.3 7.6-21.1 11.9-29.7 13.7zm30.1-12l6.7 29.5c7.8-4.6 17.1-11 28.5-18.8l-6.5-28.8c-10.8 7.3-20.1 13.4-28.7 18.1zm28.7-18c10.2-7.2 18.9-13 28.4-19.5l-7.6-33.7c-10.3 7.2-19 13.1-28.4 19.6zm28.4-19.5l6.5 28.8c10.8-7.3 20.1-13.4 28.7-18.1l-6.7-29.5c-7.8 4.7-17.1 11-28.5 18.8zm28.5-18.9c12.3-7.6 21.2-11.8 29.7-13.6l-7-31.2c-10.3 2.2-19.8 6.1-30.1 11.8zm29.7-13.6l7.1 31.1c10.3-2.3 20.5-2.9 32.3-2.1l-6.7-29.5c-14.3-1.6-24.1-1.5-32.7.5zm7.1 31.1c-10.3 2.4-19.8 6.4-30.1 12l7.4 32.9c12.3-7.5 21.2-11.8 29.8-13.6zm-58.8 30.1c-10.3 7.1-19 13-28.4 19.5l7.6 33.7c10.3-7.2 18.9-13 28.4-19.5z"/>',count:o=>o.wire},
  bullseye:{tier:'epic',name:'Bullseye',desc:'Win a week and nail the total exactly',color:'#4DB3FF',icon:'<path d="M226.063 24.22l-9.782 32.624c12.992-2.652 26.423-4.032 40.19-4.032 10.475 0 20.766.82 30.81 2.376l-9.405-30.97h-51.813zm30.406 48.843c-99.627 0-180.19 80.53-180.19 180.156 0 99.624 80.563 180.155 180.19 180.155 99.624 0 180.155-80.53 180.155-180.156 0-99.627-80.53-180.157-180.156-180.157zm0 41.687c76.482 0 138.467 61.985 138.467 138.47 0 76.482-61.985 138.5-138.468 138.5-76.485 0-138.5-62.018-138.5-138.5 0-76.485 62.015-138.47 138.5-138.47zm-.033 38.938c-54.96 0-99.53 44.54-99.53 99.5s44.57 99.5 99.53 99.5 99.5-44.54 99.5-99.5-44.54-99.5-99.5-99.5zm.032 39.687c33.052 0 59.842 26.79 59.842 59.844 0 33.052-26.79 59.843-59.843 59.843-33.055 0-59.845-26.79-59.845-59.844 0-33.055 26.79-59.845 59.844-59.845zm0 30.906c-15.993 0-28.97 12.947-28.97 28.94 0 15.99 12.977 28.968 28.97 28.968 15.99 0 28.936-12.977 28.936-28.97 0-15.99-12.945-28.937-28.937-28.937zM114.905 395l-27.844 92.875h46.876l20.28-62.313c-14.35-8.54-27.56-18.833-39.312-30.562zm277.188 5.688c-11.982 11.026-25.324 20.595-39.72 28.468l19.25 58.72h46.907l-26.436-87.188zm-165.03 50.78v36.407h52.092v-35.53c-7.45.84-15.015 1.28-22.687 1.28-9.99 0-19.81-.74-29.408-2.156z"/>',count:o=>o.bullseye},
  perfectsun:{tier:'epic',name:'Perfect Sunday',desc:'Every Sunday game right, undone by a primetime one',color:'#FFB020',icon:'<path d="M17.488 17.883V27.1l31.72 13.17c-4.947 16.663-7.873 34.187-8.507 52.275L17.49 89.443v63.428l28.852-3.917c3.968 16.532 9.893 32.31 17.527 47.068l-46.38 19.193v85.652l77.298-60.297c10.784 11.913 22.92 22.575 36.154 31.762L17.487 419.047v74.812h79.15l80.544-197.33c14.558 5.425 29.874 9.278 45.746 11.35l-24.914 185.98H299.93L275.055 308.18c16.05-1.902 31.553-5.62 46.29-10.948l79.96 196.63h92.16v-58.548L368.043 273.34c13.018-8.875 24.983-19.18 35.68-30.682l89.742 69.053V221.18l-57.643-23.737c7.784-14.768 13.854-30.573 17.95-47.15l39.693 5.292V87.275l-33.748 4.543c-.694-18.028-3.672-35.49-8.65-52.09l42.398-17.505v-4.338h-112.22l-42.282 32.527c-4.65-8.143-10.22-15.098-16.805-21.683l8.13-10.845H167.655l7.59 9.758c-6.94 6.73-12.477 14.34-17.346 22.767l-41.744-32.527H17.488zm416.22 29.012c4.37 15.116 6.913 31.006 7.392 47.43l-88.584 11.925c.04-1.177 0-2.065 0-3.254 0-7.216-.776-14.88-2.168-21.683l83.36-34.418zM66.57 47.48l78.856 32.747c-1.546 7.146-2.168 15.16-2.168 22.767 0 1.19-.04 2.075 0 3.254L59.31 95.03c.42-16.463 2.93-32.39 7.262-47.55zm82.65 87.5c2.51 7.588 5.67 14.977 9.758 21.684l-77.84 32.21c-7.003-13.298-12.48-27.522-16.204-42.446l84.287-11.448zm197.872 1.086l88.07 11.743c-3.854 14.962-9.48 29.21-16.63 42.514l-81.74-33.658c3.9-6.395 7.833-13.4 10.3-20.6zm-171.852 41.74c5.61 5.437 11.178 10.017 17.89 14.096l-50.806 65.703c-12.01-8.234-23.03-17.804-32.846-28.5l65.762-51.298zm144.203.003l69.49 53.47c-9.706 10.252-20.536 19.43-32.296 27.33l-52.915-68.333c5.71-3.65 10.837-7.81 15.72-12.468zm-37.404 22.768l32.274 79.365c-13.294 4.732-27.27 8.03-41.74 9.715L261.44 206.54c6.972-.943 14.133-3.712 20.6-5.962zm-66.138 1.084c6.534 2.07 13.58 4.128 20.6 4.88l-11.096 82.825c-14.282-1.85-28.07-5.276-41.18-10.1l31.676-77.605z"/>',count:o=>o.perfectsun},
  grain:{tier:'epic',name:'Against the Grain',desc:'Win a week after backing six underdogs',color:'#9B7BFF',icon:'<path d="M465.3 25C442.9 33.05 427 39.94 427 39.94l-3 1.3-55-15.99c4.1 11 5.6 21.33 5.3 30.91C390.2 65.4 401 72.59 401 72.59l2 1.31 24.7-9.15 3 1.11s21.3 7.63 49.4 15.3c2.3-.34 4.6-.63 6.9-.9V25h-21.7zm-198.9 8.32c-.9 0-1.7.01-2.6.04-24 .53-57.6 8.98-85.8 18.19-32.2 10.53-57.8 21.64-57.8 21.64l-3 1.3L62.25 58.5c3.94 10.71 5.5 20.77 5.3 30.14 3.43-.28 6.8-.45 10.09-.5v.01c4.01-.06 7.91.07 11.66.4 17.4 1.56 37.3 8.9 56.3 17.75 9.9 3.1 22.4 6.8 36.2 10.4 32.1 8.4 71.1 15.5 94.6 12.4 2.7-.4 5.6-1 8.7-1.7-1.8-4.6-4.2-9.4-7.4-14.6l-12-19.8 61 17.8c7.6-3.8 15-7.8 22-11.76 12.6-7.21 23.1-13.81 30.8-18.78-7.9-4.9-18.7-11.37-32-18.47-24.4-13.14-54.8-26.45-74-28.16-2.3-.2-4.6-.31-7.1-.31zm33.9 20.56a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9zm-80.7 2.85l2.6 17.82c-11.8 1.65-14.5 5.16-14.5 5.38-.1.11-.2.22.2 1.35.5 1.12 1.6 2.96 3.6 4.83 3.8 3.74 10.4 7.52 17 9.19s12.8 1.28 17.3-1.23l8.8 15.63c-9.7 5.5-20.8 5.5-30.5 3.1-9.8-2.5-18.7-7.4-25.2-13.82-3.3-3.2-6-6.8-7.7-11.09-1.7-4.29-2.2-9.58-.3-14.46 3.8-9.77 14.1-14.65 28.7-16.7zM487 98.61c-21.5 2.79-46.9 9.59-69 16.79-32.2 10.5-57.8 21.7-57.8 21.7l-3 1.2-54.9-15.9c5 13.8 6.2 26.5 4.6 38-1.1 8.6-3.5 16.4-6.4 23.8l60.4-22.4 3 1.1s25.7 9.3 57.9 17.6c20.9 5.5 44.6 10.4 65.2 12.3v-16.1c-7.6 2.1-15.6 1.7-22.9-.1-9.8-2.5-18.7-7.4-25.2-13.8-3.3-3.2-6-6.8-7.7-11.1-1.7-4.2-2.2-9.5-.3-14.4 3.8-9.8 14.1-14.7 28.7-16.7l2.6 17.8c-11.8 1.7-14.5 5.2-14.5 5.4-.1.1-.2.2.2 1.3.5 1.1 1.6 3 3.6 4.8 3.8 3.8 10.4 7.5 17 9.2 6.6 1.7 12.8 1.3 17.3-1.2l1.2 2.1V98.61zM78.02 106.2c-15.13.3-34.05 3.8-53.02 8.6v16.5c2.74-.7 5.69-1.3 8.85-1.7l2.5 17.8c-5.65.8-9.18 2.1-11.35 3.1v7.7c.21.3.43.5.66.7 3.83 3.8 10.41 7.5 17.01 9.2 6.6 1.7 12.85 1.3 17.3-1.2l8.86 15.6c-9.7 5.5-20.78 5.5-30.56 3.1-4.69-1.2-9.16-3-13.27-5.2v12.9l24.2 7.1c11.12 1.5 21.69 2.4 30.86 2.2 9.94-4 26.44-10.4 46.74-17 8.1-2.6 16.6-5.3 25.2-7.7 3.7-2 7.4-4 10.9-6 12.6-7.3 23.1-13.8 30.8-18.8-7.9-4.9-18.7-11.4-32-18.5-24.4-13.1-54.8-26.4-74-28.1-2.26-.2-4.64-.3-7.14-.3h-2.54zm36.48 20.5a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9zm103.7 57.8c-24 .5-57.6 9-85.8 18.2-32.2 10.5-57.81 21.7-57.81 21.7l-2.99 1.3L25 212v55.8l50.25-18.7 3.1 1.1s25.65 9.3 57.85 17.6c32.1 8.4 71.1 15.5 94.6 12.4 18.9-2.5 48.5-16.5 72.3-30 12.6-7.3 23.1-13.9 30.8-18.8-7.9-4.9-18.7-11.4-32-18.5-24.4-13.2-54.8-26.4-74-28.1-2.2-.2-4.6-.3-7.1-.3h-2.6zm36.5 20.5a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9zm-80.7 2.9l2.6 17.8c-11.8 1.7-14.5 5.2-14.5 5.4-.1.1-.2.2.2 1.3.5 1.1 1.6 3 3.6 4.8 3.8 3.8 10.4 7.5 17 9.2 6.6 1.7 12.8 1.3 17.3-1.2l8.8 15.6c-9.7 5.5-20.7 5.5-30.5 3.1-9.8-2.5-18.7-7.4-25.2-13.8-3.3-3.2-6-6.8-7.7-11.1-1.7-4.2-2.2-9.5-.3-14.4 3.8-9.8 14.1-14.7 28.7-16.7zm252.5 23.9c5 13.8 6.2 26.6 4.6 38.1-1.1 8.6-3.5 16.4-6.4 23.8l60.4-22.4 1.9.7v-26.5c-1 .4-2.6 1.1-2.6 1.1l-3 1.3-54.9-16.1zM25 278.8v93.7c18.91-3.7 46.09-16.7 68.25-29.3 12.65-7.3 23.15-13.9 30.85-18.8-7.9-4.9-18.7-11.4-31.97-18.5-21.7-11.7-48.04-23.4-67.13-27.1zm321.9 8.9c-24 .5-57.6 9-85.8 18.2-32.2 10.5-57.8 21.7-57.8 21.7l-3 1.3-54.9-16.1c5 13.8 6.2 26.6 4.6 38.1-1.1 8.6-3.5 16.4-6.4 23.8l60.4-22.4 3 1.1s25.7 9.3 57.9 17.6c32.1 8.4 71.1 15.5 94.6 12.4 18.9-2.5 48.5-16.5 72.3-30 12.6-7.3 23.1-13.9 30.8-18.8-7.9-4.9-18.7-11.4-32-18.5-24.4-13.1-54.8-26.4-74-28.1-2.3-.2-4.6-.3-7.1-.3h-2.6zM44.9 298a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9zm338.5 10.2a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9zm-80.7 2.9l2.6 17.8c-11.8 1.7-14.5 5.2-14.5 5.4-.1.1-.2.2.2 1.3.5 1.1 1.6 3 3.6 4.8 3.8 3.8 10.4 7.5 17 9.2 6.6 1.7 12.8 1.3 17.3-1.2l8.8 15.6c-9.7 5.5-20.7 5.5-30.5 3.1-9.8-2.5-18.7-7.4-25.2-13.8-3.3-3.2-6-6.8-7.7-11.1-1.7-4.2-2.2-9.5-.3-14.4 3.8-9.8 14.1-14.7 28.7-16.7zm121.7 83.1c-24 .5-57.6 9-85.8 18.2-32.2 10.5-57.8 21.7-57.8 21.7l-3 1.3-54.9-16.1c4.1 11.3 5.6 22 5.2 31.8 11.3 6.2 21.4 12.2 28.8 16.8l24.6-9.1 3 1.1s25.7 9.3 57.9 17.6c14 3.7 29.3 7.1 44 9.5h63.4c11.3-3.3 24.3-8.9 37.2-15.3V412c-19.2-8.9-39-16.3-52.9-17.5-2.3-.2-4.6-.3-7.1-.3h-2.6zm36.5 20.5a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9zm-80.7 2.9l2.6 17.8c-11.8 1.7-14.5 5.2-14.5 5.4-.1.1-.2.2.2 1.3.5 1.1 1.6 3 3.6 4.8 3.8 3.8 10.4 7.5 17 9.2 6.6 1.7 12.8 1.3 17.3-1.2l8.8 15.6c-9.7 5.5-20.7 5.5-30.5 3.1-9.8-2.5-18.7-7.4-25.2-13.8-3.3-3.2-6-6.8-7.7-11.1-1.7-4.2-2.2-9.5-.3-14.4 3.8-9.8 14.1-14.7 28.7-16.7zM132.8 437c-24 .5-57.6 9-85.81 18.2-7.82 2.5-15.22 5.1-21.99 7.6V487h33.95c-.52-3.2-.34-6.6.92-9.9 3.79-9.8 14.16-14.7 28.78-16.7l2.5 17.8c-11.73 1.7-14.39 5.2-14.49 5.4-.04.1-.19.2.26 1.3.22.5.62 1.3 1.2 2.1H243.6c1.7-1.1 3.4-2.1 4.9-3.1-7.9-4.9-18.7-11.4-32-18.5-24.4-13.2-54.8-26.4-74-28.1-2.3-.2-4.6-.3-7.1-.3h-2.6zm36.5 20.5a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9z"/>',count:o=>o.grain},
  icecold:{tier:'epic',name:'Ice Cold',desc:'Fewer than four right in a whole week',color:'#8FD8FF',icon:'<path d="M255.063 15.47c-131.508 0-238.657 107.12-238.657 238.624S123.558 491.75 255.062 491.75c131.505 0 238.625-106.15 238.625-237.656 0-131.504-107.117-238.625-238.625-238.625zm0 18.343c121.407 0 219.28 98.877 219.28 220.28 0 121.408-97.877 219.313-219.28 219.313-121.404 0-219.313-97.91-219.313-219.312 0-121.404 97.905-220.28 219.313-220.28zm-.032 19.28c-110.986 0-200.75 89.763-200.75 200.75 0 110.988 89.764 200.75 200.75 200.75 110.99 0 200.75-89.762 200.75-200.75 0-110.987-89.76-200.75-200.75-200.75zm-.843 16.532l12.313 62.72 51-21.095-46.094 46.094 6.22 31.687-12.5 3.345L273 221.72l29.313-7.876-3.25-12.094 31.343-10.72 16.813-62.81 7.217 54.56 60.313-20.624-48.313 42.156 42.375 33-61.625-16.187-24.25 21.156-10.03-10.03-21.47 21.5 21.47 21.47 9.218-9.22 24.688 21.563L409.5 270.78l-43.563 33.47 48.22 42.063-60.97-20.844-7.406 53.186-16.81-61.5-30.22-10.312 3.563-13.313L273 285.657 265.125 315l12.5 3.344-6.22 31.625 46.095 46.06-51-21.06-12.313 62.75-12.375-63.033-49.593 20.125 44.686-45.093-6.125-31.19 13.157-3.53-7.875-29.344-29.343 7.875 3.624 13.533-29.28 10.03L164.28 378.5l-7.374-53.156L96 346.188l48.188-42.063-43.594-33.5 62.75 16.813 24.03-20.97 8.75 8.75 21.47-21.468-21.47-21.5-9.593 9.594-23.56-20.563-61.72 16.22 42.47-33.03-48.345-42.19 60.28 20.626 7.19-54.53 16.81 62.75 30.376 10.374-3.31 12.344 29.343 7.875 7.875-29.345-13.188-3.53 6.156-31.25-44.687-45.126 49.593 20.124 12.375-62.97z"/>',count:o=>o.icecold},
  ring:{tier:'rare',name:'Ring Bearer',desc:'Win Super Bowl week',color:'#F5D76E',icon:'<path d="M255.157 123c-68.66 0-137.1 18.922-182.867 55.275.234 14.35 1.818 35.624 9.332 48.23 110.634-60.336 236.436-60.336 347.07 0 7.513-12.606 9.098-33.88 9.332-48.23C392.257 141.922 323.817 123 255.157 123zm199.81 76.057c-.324 2.98-.718 6.02-1.246 9.082-2.226 12.93-6.213 26.458-15.99 35.98-14.436 18.637-40.806 30.462-72.858 38.603C332.392 290.973 293.79 295 255.157 295c-38.632 0-77.235-4.028-109.715-12.277-31.907-8.104-58.17-19.868-72.648-38.36-11.983-11.982-16.234-28.786-17.77-43.857-13.73 27.256-11.503 62.122.672 98.648C69.988 342.03 129.406 389 255.156 389c125.75 0 185.17-46.97 199.462-89.846l.1-.297.12-.287c15.134-36.712 15.61-71.983.13-99.513z"/>',count:o=>o.ring},
  chalk:{tier:'rare',name:'Chalk Eater',desc:'Win a week picking nothing but favorites',color:'#D8D8D8',icon:'<path d="M392.8 107.5c9.3 5.3 25.8 9.3 40 9.2 7.7-.1 14.6-1.2 19.5-3.2 5-1.8 6.9-4.9 8.9-8.8-9.2-6.08-22.1-12.27-31.8-12.87-14.9.53-28.8 8.13-36.6 15.67zm-253 20.2c-1.7 5.5-7.9 8.1-13 5.4-26.5-14.5-50.46-6.9-67.71 8.7-35.93 32.6-45.13 87.3-32.47 145.7 7.31 33.6 18.99 53 41.29 62.8 0 .1.1.1.15.1 2.22 1 4.21 1.9 6.09 2.8l4.61-22c1.02-4.9 5.8-8 10.66-7s7.98 5.8 6.96 10.7l-23.5 112c4.79 7.2 16.4 1.2 21.3-1.2l38.12-106.5c10.8-9.4 21.2-19 28.7-29.2 6.6-9.1 10.4-18.4 10.6-23.5.2-5 4.4-8.9 9.4-8.7 5 .2 9 4.6 8.6 9.6-.6 11.2-6.2 22.4-14 33.2-7.3 10-16.7 19.6-27.2 27.2l-3.3 8.9c6.9 8.7 13.4 13.8 19.6 16.8 8.8 4.1 17.7 4.6 28.5 3.3 16.4-1.9 34.6-12.9 43.5-37.2 2.8-7.7 13.6-8 16.8-.5 7.7 21.2 36.1 32.6 55.1 24l-3.9-23.3c-.8-4.9 2.5-9.6 7.4-10.4 4.9-.9 9.6 2.5 10.4 7.4l17.6 105.9c9.2 6.3 14.5 2.4 19.9-4.4l-13.8-114.4c-.7-5.3 3.3-10 8.6-10.2 4.8-.2 8.8 3.3 9.3 8l4.3 35.7c5.1-1.2 9.1-2.5 12.4-5 4.3-3.2 8.5-8.7 12.1-21.5 1.7-6 9-8.5 14.1-4.7 13.6 8.3 27.4-1.8 35.6-12.2 12.9-16.5 14.7-42.4 13.2-69.2-2.1.3-4.2.5-6.3.6-8.8.5-17.9-.9-25.7-4.4-12.4-7-22-18.4-28.2-28.9-3.9-6.8-7.3-13.7-10.5-20-5.4 9.9-11 23.1-19.2 25-12.5 2.1-23.9-3.7-29.8-12.7-5.9-8.9-7.4-20.2-4.8-31.1 2.7-11.7 9.8-38.3 22.6-56.1 2.2-2.9 4.5-5.3 6.8-7.4-7.5-3.1-16.2-3.8-22.9-3.8-5.8 0-13.5 1.8-19.7 5-6.2 3.3-10.7 7.8-12.2 11.8-3.2 8.5-15.5 7.5-17.3-1.3-3.8-22.78-53.9-17.8-65.6 2-3.8 7-14.1 5.9-16.5-1.7-8.1-22.61-62.7-21.3-66.7 5.9zm345-1.5c1.7 16.4 3.5 32.2 4.2 45.6 1.8 6.5 6 18.9 8.7 7.3.9-4.1.8-11-.4-18.6-.1-7.1-14.5-47.3-12.5-34.3zm-112.7-2.5c-11.9 15-19.2 37.4-23.3 53.7-.6 5.8-.6 12.6 2.3 17.1 2.3 3.4 4.8 5.2 9.4 5 5.8-9.4 12.1-19.8 15.6-28.2-1.2-7.9-2.8-19.9-3.6-31.4-.4-5.8-.6-11.2-.4-16.2zm94.4 2.4c-2.4 1.6-4.8 3.1-7.5 4.1-7.8 3.2-16.8 4.4-26 4.5-14.8.1-30.2-2.7-42.9-8.4 0 3.6.1 7.7.4 12.3.9 12.6 3 27.2 4 33.5 10.5 16.6 19.9 44.4 36.8 52.5 5.8 2 11.9 3.1 17.2 2.9 6-.4 10.6-2.6 11.5-3.7 3.5-8 5.9-15.2 7.3-22.3 2.1-10.9 3.4-23.3 3.6-31.6.3-6.4-.6-13.3-1.1-18.7-1.4 4.1-5.7 6.6-10 5.9-4.3-.7-7.5-4.4-7.5-8.8 0-5.1 4.2-9.2 9.3-9 3 0 5.8 1.7 7.4 4.3-.9-6.1-1.4-12-2.5-17.5zm-58.3 16.5c4.9.2 8.7 4.2 8.7 9 0 5-4 9-9 9-4.9 0-9-4-9-9s4.2-9.1 9.3-9zm47.5 48.3c3.7-.1 6.5 1.9 6.5 6.2 0 7.8-5.8 15-12.7 19l-1-23.1c2.5-1.4 5-2.1 7.2-2.1zm-24.1 2c1.8-.1 3.9.4 5.8 1.3l3.8 22.5c-6-3.7-15.4-3.6-16.5-16.1-.5-5.2 2.8-7.7 6.9-7.7zm-30.9 164.2c-3.7 5.1-7.6 9.1-12.6 12.1l16.6 62c7.6 1.5 15.9 1 19.2-5.1zm-241.2 33.7l1.5 46.8c7.9 7.9 12.9 4.8 19.7-3l-3.7-39.5c-6.3-.9-12.6-2.2-17.5-4.3z"/>',count:o=>o.chalk},
  rockbottom:{tier:'rare',name:'Rock Bottom',desc:'Wooden spoon three weeks running',color:'#8A93A3',icon:'<path d="M90.53 23c-18.345 0-36.688 7.002-50.686 21-27.996 27.996-27.994 73.38 0 101.375 21.776 21.776 54.08 26.603 80.53 14.5l53.69 53.688c-21.425 19.696-44 38.257-67.44 55.937l30.126 30.125c18.734-22.545 37.953-44.474 57.844-65.53l169.594 169.593c-51.845 40.444-120.866 53.838-192.813 42.562L173 424.906 72.47 404.47l95.405 88.405 1.97-26c86.593 36.97 177.603 34.61 241.343-11.75l63.062 21.313-21.47-63.594c44.61-63.62 46.408-153.412 9.908-238.875l26.03-1.97-88.406-95.375 20.438 100.53 21.344-1.624c11.278 71.983-2.168 141.017-42.656 192.876l-169.782-169.75c21.075-20.34 42.93-39.665 65.78-57.72l-30.123-30.124c-17.015 24.154-35.673 46.66-55.688 67.813l-53.97-53.97C167.834 98.183 163.032 65.814 141.22 44c-14-13.998-32.343-21-50.69-21zm0 27.03c11.434.002 22.872 4.34 31.595 13.064 17.447 17.447 17.446 45.742 0 63.187-17.446 17.447-45.71 17.447-63.156 0-17.447-17.444-17.448-45.74 0-63.186C67.69 54.37 79.097 50.03 90.53 50.03z"/>',count:o=>o.rockbottom},
  loyalist:{tier:'rare',name:'Loyalist',desc:'Never pick against your team all season',color:'#66D19E',icon:'<path d="M494 61.363l-82.58 77.934 78.994 132.96 3.586-4.458V61.362zM18 62.5v225.893c4.48.582 9.863.903 15.295.96 11.87.125 21.654-.65 27.15-1.144L113.1 154.974 18 62.5zm389.154 104.86l-7.04 4.556c-.15.097-5.362 3.336-6.893 4.29l-10.605 6.42.15.09c-4.914 3.057-6.28 3.917-11.857 7.38-2.83 1.757-2.9 1.798-5.584 3.465-20.29-10.907-42.306-19.29-67.998-25.882-32.312 9.762-66.542 23.888-100.722 37.142 14.19 17.087 29.96 22.651 45.845 22.85 18.42.23 37.25-7.78 50.218-16.754l7.4-5.12 7.426 10.73 115.453 83.33 45.112-29.987-60.906-102.51zM126.477 170.1L81.11 284.887 97.76 297.69l30.795-34.905 2.467-2.795 3.72-.232c1.5-.094 2.98-.138 4.44-.13 10.212.066 19.342 2.716 26.19 8.76 5.072 4.472 8.444 10.426 10.4 17.32l2.28-.142c11.995-.75 22.802 1.725 30.63 8.63 7.827 6.907 11.63 17.323 12.38 29.32l.07 1.08c6.44 1.216 12.205 3.752 16.893 7.888 7.828 6.906 11.63 17.32 12.38 29.317l.197 3.12c.642.202 1.275.424 1.9.658l2.033-2.853 5.47-7.678 2.813-3.95 7.33 5.223 59.428 42.336c6.464-1.594 10.317-4.075 12.46-7.086 2.147-3.012 3.233-7.47 2.624-14.107l-71.258-51.03-7.318-5.24 5.19-7.246 6.67-9.365 7.33 5.223 80.335 57.226c6.464-1.593 10.32-4.074 12.463-7.085 2.144-3.01 3.23-7.457 2.625-14.082l-92.398-65.55-7.34-5.21 10.414-14.68 7.343 5.208 92.414 65.565c6.47-1.594 10.327-4.075 12.473-7.088 2.148-3.015 3.233-7.476 2.62-14.125l-110.44-79.71c-14.655 8.688-33.402 15.648-53.557 15.396-23.587-.295-48.817-11.566-67.377-40.05a9 9 0 0 1 4.343-13.327c13.014-4.945 26.163-10.17 39.343-15.354l-92.056-6.834zm12.902 107.62l-47.564 53.91c.927 6.746 3.04 10.942 5.887 13.454 2.847 2.512 7.275 4.085 14.084 4.164l47.563-53.908c-.927-6.747-3.04-10.945-5.887-13.457-2.847-2.512-7.274-4.084-14.084-4.162zm43.308 25.81l-53.713 60.88c.926 6.747 3.04 10.945 5.886 13.457 2.85 2.51 7.275 4.083 14.085 4.16l53.713-60.878c-.926-6.748-3.04-10.944-5.887-13.457-2.846-2.512-7.273-4.085-14.083-4.164zm29.34 38.286l-47.56 53.91c.927 6.746 3.04 10.943 5.887 13.456 2.848 2.512 7.275 4.083 14.084 4.162L232 359.44c-.927-6.75-3.04-10.947-5.887-13.46-2.847-2.512-7.274-4.083-14.084-4.162zm24.702 39.137l-38.794 44.28c.925 6.76 3.038 10.962 5.888 13.476 2.845 2.51 7.267 4.082 14.067 4.163l38.796-44.28c-.926-6.758-3.04-10.96-5.89-13.476-2.844-2.51-7.266-4.08-14.066-4.162zm35.342 4.79c1.694 4.62 2.673 9.74 3.014 15.192l.232 3.704-8.277 9.448 26.724 19.037c6.464-1.594 10.316-4.075 12.46-7.086 2.145-3.01 3.233-7.464 2.628-14.093l-36.78-26.2z"/>',count:o=>o.loyalist,detail:o=>o.loyalTeam?`Never picked against ${o.loyalTeam}`:''},
  jinx:{tier:'rare',name:'Jinx',desc:'Back the same team five times and watch them lose every one',color:'#B06CE8',icon:'<path d="M323.3 19.97c-60.4.63-112.4 52.18-109 119.13l14.2-13.4 12.8 13.6-23.8 22.6c2.2 9.2 5.4 18.6 9.8 28.2-53.6-22.8-67-40.1-111.9-94.1-9.4-11.23-18.92-15.48-27.49-16.13-1.07-.1-2.14-.1-3.19-.1-7.36.24-14.13 3.22-19.35 8.03-5.96 5.5-9.71 13.3-9.77 21.7-.1 8.4 3.36 18 13.55 27.7 24.54 23.5 52.75 47.2 74.15 71.2 11.7 13.1 21.7 26.5 27.6 40.3 16 4.2 32 8.5 48 12.7l1.5 5c4.3 14.2 2.4 31.7-12.2 45.8l-3.9 3.7c-12.2-3.3-24.5-6.5-36.8-9.8-4.5 8.1-10.3 15-16.6 21-11.4 10.9-24.3 19.4-36.2 29-23.66 19.1-43.42 40.3-41.58 92.2 1.15 32.2 25.42 45.8 45.98 44.5 10.3-.6 19-4.9 24-12.6 5-7.8 7.2-19.9.9-38.5-5.5-16.6 2.9-33.5 15.3-45.2 12.5-11.7 30.4-19.4 48.6-15.3 10 2.2 16.2 10.7 19.4 19.1 3.2 8.4 4.8 17.8 6.9 27.5 4.1 19.4 9.5 38.7 25.2 50 30.4 21.7 61.3 18.2 74.9 6.6 6.8-5.8 9.7-12.8 8-22.1-1.7-9.2-9.1-21.5-26.3-34.5-19.7-14.9-24-41.6-22.2-67.1 1.9-25.5 9.9-51 20.3-67.8 6.3-10.1 17.3-13.7 29.4-16.8 12-3.2 26-5.6 40.5-9.3 28.9-7.4 58.5-19.3 76.3-50.6 8.7-15.4 10.8-28 9.3-37.1-1.4-9.1-6-15.1-12.5-18.7-13-7.1-35.8-4.2-54.6 21-13.7 18.2-39.5 26.6-69.2 28.6-9 .6-18.5.6-28.1-.1 2.4-1.5 4.9-3.1 7.4-4.8l.1-31.2h18.6v15.9c31.5-29.7 55.1-74.4 53.1-119.84 18.1 11.88 30.6 27.13 42 47.74 3.4-16.5-.2-32.57-8.1-47.99 16.2 6.7 28.6 17.11 41.4 27.1-4.8-20.07-14.7-33.13-29.5-43.24 16.7 1.34 26.1 5.24 40.8 12.74-11-24.93-55.2-50.35-98.3-35.21-16.7-6.54-34-11.16-49.4-11.13zm-34.6 54.34c11 0 19.8 8.87 19.8 19.81 0 10.98-8.8 19.88-19.8 19.88-10.9 0-19.8-8.9-19.8-19.88 0-10.94 8.9-19.81 19.8-19.81zm44.7 33.09c10.9 0 19.8 8.9 19.8 19.8 0 11-8.9 19.8-19.8 19.8-11 0-19.8-8.8-19.8-19.8 2.3-11.3 6.5-19.5 19.8-19.8zm-80.1 40.7l15 11.3-21 27.7-14.9-11.3c7-9.2 14-18.5 20.9-27.7zm28.1 16.8l17.8 5.7-10.1 31.6-17.8-5.7c3.3-10.5 6.8-21.1 10.1-31.6zM42.31 204.6c-16.92 20.2-19.8 44.5-18 72.1l30.38-17.1 3.31-1.8 3.66.9L198.7 295c5.5-6.5 6.2-11.9 5-18.2L66.72 240.4l-3.69-.9-1.94-3.3c-6.24-10.6-12.54-21.1-18.78-31.6zM326.2 309.8c-2.5 5.2-4.9 11.2-6.9 17.8l95.9 25.4c19.2 2.4 38.5 3.7 57.7 5.9l-51.7-22.8c-34.1-9.8-67.2-18.9-95-26.3z"/>',count:o=>o.jinx,detail:o=>o.jinxTeam?`${o.jinxTeam} went 0-5 on your picks`:''},
  photo:{tier:'common',name:'Photo Finish',desc:'Tie for first and win it on the tiebreaker',color:'#7FE0C8',icon:'<path d="M179.594 20.688v41.406h143.25V20.687h-143.25zM256.03 82C143.04 82 51.25 173.727 51.25 286.656c0 112.93 91.788 204.656 204.78 204.656 112.994 0 204.75-91.728 204.75-204.656C460.78 173.73 369.025 82 256.03 82zm0 35.625c93.42 0 169.126 75.665 169.126 169.03 0 93.368-75.706 169.564-169.125 169.564-93.417 0-169.155-76.197-169.155-169.564 0-93.366 75.736-169.03 169.156-169.03zm76.19 20.28l-72.47 107.5c10.67 1.036 20.516 6.045 27.625 13.814l44.844-121.314zm-85.533 1.064v45.31c3.077-.275 6.196-.405 9.344-.405 3.155 0 6.263.13 9.345.406v-45.31h-18.688zm-88.53 36.655l-13.22 13.22L177 220.874c3.992-4.784 8.432-9.198 13.22-13.188l-32.064-32.062zm195.75 0l-32.063 32.063c4.786 3.99 9.196 8.403 13.187 13.187l32.064-32.03-13.188-13.22zm-98.344 81.22c-2.08.01-4.195.243-6.313.686-16.948 3.544-27.7 20.005-24.156 36.94 3.544 16.932 20.02 27.698 36.97 24.155 16.946-3.543 27.7-20.004 24.155-36.938-3.102-14.816-16.104-24.925-30.658-24.843zM108.28 277.31V296h45.314c-.278-3.08-.406-6.192-.406-9.344 0-3.146.13-6.27.406-9.344H108.28zm250.157 0c.277 3.075.438 6.197.438 9.344 0 3.153-.16 6.264-.438 9.344h45.344v-18.688H358.44zm-60.062 6.72c.993 10.522-1.968 20.742-7.813 28.937l124 19.092-116.187-48.03zM176.97 352.405l-32.032 32.03 13.218 13.22 32.063-32.03c-4.798-4-9.253-8.424-13.25-13.22zm158.093 0c-4 4.796-8.423 9.22-13.22 13.22l32.063 32.03 13.188-13.22-32.03-32.03zM246.688 389v45.313h18.687V389c-3.082.278-6.19.438-9.344.438-3.147 0-6.266-.16-9.342-.438z"/>',count:o=>o.photo},
  heart:{tier:'common',name:'Heartbreaker',desc:'Tie for first and lose it on the tiebreaker',color:'#FF7A8A',icon:'<path d="M373.47 25.5c-33.475-.064-67.614 13.444-94.44 43.156l37.22 145.156-33.437.032 35.343 132.093-116.718-188.375 50.03 5.375L202.5 47.312C120.437-1.43 4.756 40.396 8.5 158.156c4.402 138.44 191.196 184.6 247.406 331.625 59.376-147.035 251.26-184.33 246.656-331.624-2.564-82.042-64.6-132.532-129.093-132.656z"/>',count:o=>o.heart},
  champ:{tier:'rare',name:'Weekly Champ',desc:'Finish 1st in a week',color:'#F5B400',icon:'<path d="M256.156 21.625c-45.605 0-86.876 2.852-117.22 7.563-15.17 2.355-27.554 5.11-36.874 8.53-4.66 1.71-8.568 3.515-11.968 6.094-3.238 2.457-6.65 6.36-6.97 11.75h-.75c0 10.08.362 20.022 1.064 29.813H57.53c-.12-7.952.003-15.922.376-23.875l-26.812-6.28C22.55 161.892 64.1 265.716 140.564 339.655l15.655-29.594c-4.198-3.477-8.25-7.063-12.157-10.75 5.846-6.112 12.293-11.76 19.28-16.843 13.468 13.172 28.182 23.565 43.813 30.655 22.114 17.744 8.053 29.368-23.5 36.25 58.863 10.6 38.948 62.267-14.125 92.313-2.14.27-4.256.523-6.28.812-12.047 1.718-21.876 3.71-29.406 6.25-3.765 1.27-6.958 2.6-9.906 4.656-2.95 2.055-6.626 5.705-6.626 11.406 0 5.702 3.677 9.32 6.626 11.375 2.948 2.055 6.14 3.387 9.906 4.657 7.53 2.54 17.36 4.532 29.406 6.25 24.094 3.436 56.784 5.53 92.906 5.53 36.123 0 68.812-2.094 92.906-5.53 12.048-1.718 21.877-3.71 29.407-6.25 3.764-1.27 6.957-2.602 9.905-4.656 2.948-2.055 6.625-5.674 6.625-11.375 0-5.702-3.677-9.352-6.625-11.407-2.948-2.055-6.14-3.387-9.906-4.656-7.53-2.54-17.36-4.532-29.408-6.25-2.013-.287-4.12-.544-6.25-.813-53.076-30.045-72.99-81.71-14.125-92.312-31.568-6.886-45.63-18.522-23.468-36.28 15.74-7.15 30.547-17.655 44.092-30.97 6.648 4.773 12.84 10.038 18.47 15.72-4.105 4.172-8.338 8.257-12.72 12.217l16.188 29.594c79.118-71.955 116.195-179.53 110.03-285l-27.342 7.97c.45 7.61.64 15.19.562 22.75h-25.594c.702-9.792 1.063-19.735 1.063-29.814h-.75c-.323-5.39-3.763-9.293-7-11.75-3.402-2.58-7.31-4.383-11.97-6.093-9.32-3.422-21.704-6.177-36.875-8.532-30.342-4.71-71.613-7.563-117.22-7.563zm0 18.688c44.822 0 85.426 2.854 114.344 7.343 14.46 2.245 26.06 4.932 33.313 7.594 1.04.382 1.775.75 2.625 1.125-.85.375-1.58.742-2.625 1.125-7.252 2.662-18.854 5.38-33.313 7.625-28.918 4.49-69.522 7.344-114.344 7.344-44.82 0-85.425-2.855-114.344-7.345-14.46-2.245-26.06-4.963-33.312-7.625-1.05-.386-1.77-.748-2.625-1.125.853-.376 1.577-.74 2.625-1.125 7.252-2.662 18.853-5.35 33.313-7.594 28.918-4.49 69.522-7.343 114.343-7.343zm-197.25 71.874H86.25c8.057 57.878 28.23 108.83 56.188 146.25-6.974 5.74-13.407 11.968-19.188 18.688-38.648-46.456-59.042-104.647-64.344-164.938zm367.188 0h27C447.51 171.82 425.336 228.34 388.03 275c-5.44-6.055-11.406-11.73-17.842-16.97 27.81-37.38 47.873-88.175 55.906-145.842z"/>',count:o=>o.champ},
  b2b:{tier:'rare',name:'Back-to-Back',desc:'Win two weeks in a row',color:'#6C7BFF',icon:'<path d="M234.7 18.05c-21 .2-38.8 2.5-62 10.2-4.1 2-8.2 4.1-12.2 6.2.8 5.26 3.2 10.77 5.5 14.7-4.9 4.2-9.6 8.4-14.1 12.8-3.7-5.5-6.6-11.4-8.3-17.4-14.2 9.2-27.7 19.6-40.1 31.4 1.9 9.5 9.2 18.21 15.2 24.15-3.7 5.2-7.2 10.4-10.5 15.7-8.22-7.2-15.12-15.5-19.32-24.65C74.97 108.1 61.92 126 53.08 142.3c5.29 13 19.01 22.7 29.8 28.4-2 6.1-3.7 12.2-5.1 18.4-13.5-6.4-26.3-15.7-34.5-26.6-8.7 20.1-14.7 40.7-18.2 61.4 9.63 15.5 30.57 22.9 46 25.9.1 6.4.4 12.8.9 19.2-17.79-2.7-37.26-9.6-49.9-20.4-1.6 22.3-.5 44.5 3.4 66.2 15.25 13.7 41.14 15.3 58.6 13.7 2 6.1 4.1 12.2 6.5 18.1-18.61 4.5-43.29 1.1-59.3-6.2 6.6 23.7 16.4 46.4 29.2 67.4 19.33 8.6 44.52 3.6 61.72-2.5 3.7 5.3 7.6 10.5 11.6 15.5-17.8 9.5-39.9 11.5-57.52 10.1 12.3 16.3 26.62 31.2 42.72 44.4 4.9 1.1 10.5 1.1 16.7.3 11.7-1.7 25.2-7 37.9-14.7 16.7 13.5 34.9 24.7 54.1 33.1l7.5-17.2c-16-6.9-31.3-16.2-45.6-27.3 13.3-10.9 24.3-24 30.2-36.5 4.7-9.7 6.3-18.4 4.5-26.3-10.7-5.7-20.6-12.5-29.5-20.3-7.8 20.8-26.4 36.1-43.5 46-4-4.9-7.9-9.9-11.6-15 16.8-9.8 39.9-27.5 39.1-47.1-8.9-10.3-16.6-21.8-22.9-34.1-12 14-30.7 22.5-46.5 26.7-2.4-5.8-4.6-11.6-6.6-17.6 16.8-5.2 37.9-13 44.1-29.7-4.3-11.5-7.5-23.6-9.7-36-13.8 8.4-32 11.1-46.32 10.9-.6-6.2-1-12.4-1.2-18.7 15.52-.6 33.92-2.5 44.92-14.3-.8-12.6-.5-25.5.9-38.5-13.4 2.8-29 .3-40.42-3.2 1.3-6 2.9-12.1 4.8-18.1 12.82 3.2 27.12 6.7 38.82.8 2.7-13.6 6.7-27.3 12-40.8-9.9-1.8-20.2-6.3-27.7-10.7 3.3-5.3 6.8-10.5 10.5-15.7 8.1 4.2 16.3 8.8 25.2 8.4 5.7-11.6 12.3-22.65 19.5-32.75-5.1-2.7-10-6.4-14.4-10.6 4.4-4.3 9.1-8.5 13.9-12.7 3.8 3.54 8 6.18 12.3 8.2 15.9-18.6 35.9-36.23 49-53.8zm38.4 0c15.4 20.75 33.8 35.63 48.9 53.7 4.6-1.76 9.1-5.23 12.3-8.1 4.9 4.2 9.5 8.4 13.9 12.7-4.4 4.2-9.2 7.9-14.4 10.6 7.3 10.1 13.9 21.05 19.6 32.65 9-.1 18.4-4.4 25.2-8.4 3.7 5.2 7.2 10.4 10.4 15.7-8.8 5.9-18.2 9.6-27.6 10.7 5.3 13.5 9.3 27.2 12 40.8 12.3 5.4 27.3 2.7 38.7-.8 1.9 6 3.5 12.1 4.9 18.1-14.2 3.4-27.3 6.2-40.4 3.3 1.4 12.9 1.6 25.8.8 38.5 11.4 12.3 30.2 14.4 44.9 14.2-.2 6.3-.5 12.5-1.2 18.7-17.1-.5-32.8-2.5-46.3-10.9-2.1 12.4-5.3 24.5-9.6 36.1 8.2 17.4 27.8 25.3 44.1 29.6-2 6-4.2 11.8-6.6 17.6-18.5-5.6-34.9-13-46.6-26.7-6.3 12.4-13.9 23.8-22.9 34.1 1.5 22.4 22.4 37.8 39.2 47.1-3.7 5.1-7.6 10.1-11.6 15-19-11.8-36.6-25.8-43.5-46-9 7.8-18.8 14.6-29.6 20.3-1.8 7.9-.1 16.6 4.5 26.3 6 12.5 17 25.6 30.3 36.5-14.3 11.1-29.6 20.4-45.6 27.3l7.4 17.2c19.3-8.4 37.4-19.6 54.1-33.2 12.7 7.8 26.2 13.1 38 14.8 6.2.8 11.8.8 16.7-.3 16.1-13.2 30.4-28.1 42.7-44.4-18 1.7-37.9-2.3-56.5-9.7-.3-.1-.7-.3-1.1-.4 4.1-5 7.9-10.2 11.7-15.5 18.2 7.8 43.7 11.7 61.6 2.5 12.8-21 22.6-43.7 29.2-67.4-.4.2-.8.4-1.2.5-20.5 6.4-40.1 7.6-58.1 5.7 2.4-5.9 4.5-12 6.5-18 19.1 1.7 45.2.1 58.6-13.8 3.9-21.7 5.1-43.9 3.4-66.2-14.4 10.7-34.9 17.9-49.9 20.4.5-6.4.9-12.8 1-19.2 16.8-4.8 37.9-10 45.9-25.9-3.5-20.7-9.5-41.3-18.2-61.4-9.4 11.6-23.1 21-34.4 26.5-1.5-6.1-3.2-12.2-5.2-18.3 12-7.4 25.1-15.3 29.9-28.4-10.1-18.7-22.2-35.8-35.9-51.05-4.2 9.05-11.1 17.45-19.2 24.65-3.3-5.3-6.8-10.5-10.6-15.7 6.2-7.17 14.2-14.71 15.2-24.15-12.4-11.8-25.8-22.2-40-31.4-1.8 6-4.7 11.9-8.3 17.4-4.5-4.4-9.2-8.6-14.1-12.8 2.7-4.82 4.7-9.62 5.4-14.7-4-2.1-8.1-4.2-12.2-6.2-24.7-8.2-43.3-10.3-66.2-10.2z"/>',count:o=>o.b2b},
  perfect:{tier:'legendary',name:'Perfect Week',desc:'Every pick right in a week',color:'#30D158',icon:'<path d="M17.47 250.9C88.82 328.1 158 397.6 224.5 485.5c72.3-143.8 146.3-288.1 268.4-444.37L460 26.06C356.9 135.4 276.8 238.9 207.2 361.9c-48.4-43.6-126.62-105.3-174.38-137z"/>',count:o=>o.perfect},
  landslide:{tier:'legendary',name:'Landslide',desc:'Win a week by four games',color:'#F2A03D',icon:'<path d="M156.777 16.248l21.832 149.004-83.165-78.248 40.946 125.732-74.765-6.927 39.33 68.112h71.87l-11.512-38.73 28.125 15.234 1.17-49.223 44.537 51.568 14.064-78.52 17.58 60.94 57.425-39.846-17.58 58.597 55.082-22.266-30.912 42.248h80.834l37.17-63.13-51.26 6.845 20.565-85.008-70.873 48.905L395.61 69.693l-95.25 51.473-12.266-100.908-51.576 104.803-32.53-87.51-18.517 18.18-28.693-39.482zm57.23 259.61l-48.064 34.892 20.48 27.527L59.384 355l8.42 66.527-.506 2.99-48.087 20.126V491.7h34.42l47.1-46.206-18.678-74.63 46.343-6.1 3.358 54.933 1.685.75 39.685 32.815-18.117 38.437h54.185L215 432.284l-65.352-26.19-2.673-43.777 73.43-9.666-28.182-37.886 53.593-38.91h-31.81zm60.124 0l49.722 58.437-74.63 35.61-4.355.222 52.588 62.935L266.69 491.7h72.033l-2.315-73.403L282.78 374.6l58.706-28.014 73.418 17.262-45.13 72.213 41.003 55.112.19.527h69.838l-78.51-55.122 14.45-35.62 77.86 30.75v-34.606l-68.937-15.215 18.912-30.26-101.807-23.934-44.103-51.836h-24.54z"/>',count:o=>o.landslide},
  sharp:{tier:'rare',name:'Sharpshooter',desc:'Get 85% of a week right',color:'#5AD6C8',icon:'<path d="M27.48 25.695C37 62.802 51.945 100.233 69.07 137.86c17.496-31.598 41.214-52.96 71.563-70.473C102.823 50.575 65.097 36.27 27.48 25.695zm456.24 0c-37.62 10.575-75.347 24.88-113.156 41.692 30.35 17.514 54.067 38.875 71.563 70.472 17.125-37.627 32.07-75.058 41.592-112.165zm-367.1 81.315c-3.574 3.207-6.978 6.57-10.224 10.117L232.12 242.85l10.257-10.243L116.62 107.01zm277.956 0L28.018 473.11l10.54 10.26L404.8 117.126c-3.245-3.548-6.648-6.91-10.224-10.117zm-138.963 26.81c-24.338 0-47.014 7.245-65.998 19.682l13.494 13.477c15.33-9.19 33.285-14.472 52.503-14.472 19.214 0 37.16 5.28 52.483 14.465l13.492-13.477c-18.975-12.433-41.64-19.676-65.975-19.676zm-.004 45.08c-11.807 0-22.994 2.732-32.967 7.588l14.246 14.23c5.86-2.026 12.152-3.138 18.72-3.138 6.56 0 12.848 1.11 18.702 3.13l14.25-14.228c-9.97-4.853-21.15-7.582-32.953-7.582zm102.27 11.58l-13.556 13.55c8.464 14.877 13.297 32.102 13.297 50.488 0 19.172-5.255 37.087-14.403 52.392l13.496 13.48c12.386-18.958 19.598-41.59 19.598-65.872 0-23.51-6.76-45.467-18.43-64.04zm-204.56 0c-11.677 18.573-18.443 40.527-18.443 64.038 0 24.282 7.217 46.912 19.61 65.87l13.493-13.478c-9.154-15.305-14.416-33.22-14.416-52.392 0-18.386 4.838-35.61 13.307-50.487l-13.55-13.55zm171.315 33.24l-14.457 14.458c1.536 5.174 2.373 10.655 2.373 16.343 0 6.543-1.103 12.813-3.113 18.654l14.25 14.23c4.83-9.952 7.543-21.11 7.543-32.883 0-10.962-2.37-21.38-6.595-30.8zm-138.072.003c-4.227 9.417-6.598 19.836-6.598 30.798 0 11.773 2.715 22.93 7.547 32.882l14.25-14.23c-2.01-5.84-3.117-12.11-3.117-18.65 0-5.69.837-11.17 2.375-16.344l-14.458-14.455zm92.523 45.547l-10.274 10.273 203.83 203.826 10.54-10.26-204.096-203.84zm-39.84 39.84l-14.453 14.452c9.423 4.23 19.85 6.604 30.816 6.604 10.962 0 21.38-2.373 30.798-6.6l-14.453-14.453c-5.174 1.538-10.657 2.375-16.346 2.375-5.695 0-11.183-.838-16.364-2.38zM81.87 341.3l-68.024 68.026h51.588l68.11-68.025H81.872zm295.78 0l68.112 68.026h51.59L429.326 341.3H377.65zm-172.546 1.95l-13.55 13.553c18.58 11.68 40.544 18.45 64.06 18.45 23.51 0 45.464-6.768 64.036-18.444l-13.55-13.552c-14.875 8.47-32.102 13.306-50.487 13.306-18.39 0-35.625-4.84-50.51-13.314zm-34.88 34.883l-68.03 68.025.003 51.52 68.026-68.024v-51.52zm170.75 0v51.52L409 497.68l.002-51.52-68.027-68.025z"/>',count:o=>o.sharp},
  upset:{tier:'common',name:'Upset Artist',desc:'Pick an underdog that wins',color:'#A983FF',icon:'<path d="M231.6 16.18l16.7 120.02 73.8 20.5c37.3-11.2 78.5-18.2 102.3-43.6 9.7-10.3 17.2-24.78 9.1-37.92l-75.3 2.22-14.6-31.79h-74.7c-7.7-11.71-22.8-20.46-37.3-29.43zm5.7 145.22c-46.9 19.8-110.1 146.3-111.8 276.5-34.02-58.1-24.9-122.6-2.9-202.6C55.31 287 4.732 448.4 133.1 486.9H346s-6.3-21.5-14.1-28.9c-12.7-12-48.2-20.2-48.2-20.2 27.8-39.2 33.5-71.7 38.6-103.9 4.5 59.8 40.7 126.8 57.4 153h76.5s4.6-15.9.2-21.5c-10.9-13.8-51.3-11.9-51.3-11.9-31.1-107.2-46.3-260.2-90-273.2-21.7-6.5-54.3-14.1-77.8-18.9z"/>',count:o=>o.upsets},
  dogpile:{tier:'epic',name:'Dog Pile',desc:'Five winning underdogs in one week',color:'#E86FA6',icon:'<path d="M163.188 21.97c-7.297 26.986-10.203 53.018-7.938 78.436-14.85 7.285-25.906 20.114-25.813 37.438.283 52.65 14.304 78.17 27.75 103.28 13.548 25.303-13.83 40.578-25.812 11.626-9.234-22.314-15.026-41.954-32.938-67.78-9.084-13.102-22.705-17.43-36.124-15.75-11.94-18.19-21.904-36.186-30.188-56.282-7.62 29.437-8.15 53.222-.875 72.156-10.35 10.828-15.61 25.955-9.625 41.844 12.662 33.607 39.78 62.612 56.156 76.812 31.5 27.312 48.92 57.614 59.69 93.78L122.187 444l23.124-12.375-15.687 47.063 17.406-10.438c-1.464 10.67-4.858 19.785-9.843 29.156h220.094c-6.797-11.38-13.59-21.46-17.405-32.344l18.594 13.625-12.783-58.218 15.282 16.936.592-48.156c17.473-24.295 40.45-46.337 58.97-61.625 4.012-3.313 8.287-6.348 12.28-9.688 16.656-13.928 34.265-34.822 50.344-65.187 7.97-15.047 4.18-29.898-5.437-41.28 6.854-20.713 10.25-40.728 10.186-61.376l-39.03 43.03c-16.944-4.927-35.66-2.328-47.688 12.5-15.665 19.312-20.914 36.51-32.938 52.282-14.377 18.857-30.835 6.79-21.938-9.687 14.045-26.01 29.088-57.898 31.625-109.095 1.034-20.86-12.418-35.303-30.406-42.5 1.58-23.15-7.402-49.838-16.217-74.313-5.48 21.334-13.383 46.38-21.407 69.72-19.64 2.562-37.13 12.946-42.344 32.906-11.923 45.646-6.575 79.856-5.812 103.28.998 30.646-32.694 23.28-30.97 0 2.43-32.78 9.427-56.95-.655-103.937-3.872-18.04-18.63-27.624-35.688-30.093-6.52-25.415-18.27-48.343-31.25-72.218zm157.25 92.468c23.62.08 46.055 24.707 29.656 68.624-20.786 55.666-73.04 38.98-69.156-21.78 2.052-32.11 21.128-46.908 39.5-46.845zm-142.72 3.75c17.888-.42 38.083 16.814 40.188 49.156 3.6 55.282-52.667 63.817-64.78 15.28-10.868-43.537 5.55-63.99 24.593-64.436zM65.25 191.344c9.805-.166 20.597 5.605 27.594 18.28 30.027 54.392-16.39 80.447-39.625 41-21.794-36.994-6.688-58.965 12.03-59.28zm370.625 22.406c21.77-.634 42.792 24.326 19.844 51.125-35.94 41.97-80.713 30.29-44.564-34.844 6.206-11.18 15.527-16.012 24.72-16.28zM253.47 266.438c97.645 0 155.217 95.69 61.468 113.093-28.966 5.38-41.64-10.665-61.875-10.75-17.822 0-38.463 16.566-59.844 12.845-98.955-17.233-51.51-115.188 60.25-115.188z"/>',count:o=>o.dogpile},
  lone:{tier:'common',name:'Lone Wolf',desc:'Be the only one to call a game right',color:'#CBD5E1',icon:'<path d="M179.3 38.94C154.7 77.7 142.7 139.7 168.4 185.9l-16.3 9.2c-6.7-11.9-11.2-24.4-13.9-37.2-34.5-6.3-69.42-7.5-104.98-2.1 34.07 10.1 52.77 23.7 76.68 46.7-26.82 9.7-60.25 30.2-92.93 70.2 35.47-8.8 64.83-11.5 89.43-6.3-36.94 22.5-64.06 56.1-88.34 114.1 35.9-17.2 64.89-18.8 102.94-18.8-23.07 32.7-35.27 77.2-36.31 112.8 24.51-26 57.61-60.2 87.21-79 3 29.9 15 58.3 35.9 85.3-.2-43.9 10.3-88.3 31.6-133.4-18.8 9-32.4 18.1-49.9 29.3 6.2-27.9 12.4-55.8 18.7-83.7-23.3 2.4-39 10-60.5 18.5 16.3-33.1 32.7-66.1 49.1-99.2l16.8 8.3-28.4 57.4c18.4-4.4 28.7-4.1 45.7-1.3-4.5 20.4-9 40.7-13.6 61 65.3-36.2 148.3-45.9 226.7-50 7.6-12.9 13.8-24.2 18.8-34.8l-6.3-24.4-24.4 30.8-7.8-27.5-22.5 29.2-7.5-26.1-23.9 31.5-7.7-28.2-23.8 31.4 1.2-41.1 22.6-42.7 7.6 28.3 23.9-31.5 7.6 28.2 23.5-30 6.5 26.9 24.5-30.8 7.8 27.5 24.6-32c2.3-10.8 4.6-22.4 7.4-35.7-55.5-3.7-106.3 4.8-154 9.8-38-20.8-80.8-26.8-121.9-18.5-13.6-29.69-27.2-59.38-40.9-89.06zM325.5 158.3c-4.5 14.2-13 18.3-24.7 20.6-16.1-4.4-28.3-15.5-34.4-30.2 20.4-3.8 42.4 3.4 59.1 9.6z"/>',count:o=>o.lone},
  slayer:{tier:'epic',name:'Giant Slayer',desc:'Take a 10+ point underdog that wins',color:'#FF5C5C',icon:'<path d="M491.844 22.533l-83.42 14.865L196.572 249.25c3.262 4.815 5.37 10.72 5.37 16.932 0 5.863-1.71 11.35-4.643 15.996-5.065-1.606-10.448-2.477-16.027-2.477-15.724 0-29.904 6.89-39.69 17.796l-9.112-9.113 17.237-17.237c-4.515-5.772-8.907-11.645-13.19-17.6l-19.443 19.44-13.215-13.215 21.828-21.827c-4.403-6.59-8.67-13.278-12.792-20.068l-40.802 40.803 58.314 58.314c-1.613 5.075-2.49 10.47-2.49 16.063 0 7.666 1.65 14.96 4.592 21.564l-72.14 72.14-14.56-14.56L21.013 437l14.558 14.56-8.607 8.608 27.246 27.246 8.606-8.61 14.56 14.56 24.798-24.8-14.557-14.556 72.158-72.16c6.586 2.922 13.858 4.562 21.498 4.562 5.593 0 10.988-.877 16.063-2.49l58.363 58.363L296.5 401.48c-6.797-4.127-13.486-8.395-20.068-12.793l-21.83 21.83L241.39 397.3l19.442-19.44c-5.962-4.29-11.835-8.683-17.603-13.194l-17.238 17.238-9.16-9.16c10.905-9.785 17.795-23.965 17.795-39.69 0-5.346-.806-10.51-2.285-15.39 4.703-3.04 10.288-4.817 16.265-4.816 6.21 0 11.776 1.77 16.52 4.955L476.98 105.95l14.864-83.417zm-66.227 53.012l13.215 13.215-191.684 191.68-13.214-13.213L425.617 75.545zM181.273 298.39c19.257 0 34.665 15.41 34.665 34.665 0 19.256-15.408 34.666-34.665 34.666-19.256 0-34.666-15.41-34.666-34.665s15.41-34.666 34.666-34.666z"/>',count:o=>o.slayer},
  streak:{tier:'rare',name:'Hot Streak',desc:'12 right in a row',color:'#FF7A3D',icon:'<path d="M162.22 21.312c-183.876 106.68 51.994 227.35-10.19 332.47C116.95 413.083 38.11 325.45 43.75 227-6.035 353.376 30.21 443.745 95.22 492.75c1.386.34 17.577.498 41.186.562-28.478-16.9-32.06-75.355 32.813-103.25l15.78-7L182.062 400c-1.356 8.34-.318 13.95 1.188 16.937 1.507 2.987 3.106 3.544 5.844 4.094 5.475 1.1 16.963-2.395 26.28-14.624 18.636-24.457 29.117-80.228-26.874-167l-4.094-6.437-13.906-19.25 23.25 9.905 5.25 1.75c80.85 25.498 135.3 58.46 174.625 112.72 21.544-22.906 38.7-56.835 43.812-91.69l3.5-27.468 13.438 23.97c25.525 45.802 30.267 104.912 11.094 156.5-14.23 38.28-42.036 72.34-84 93.5 13.623-.01 24.05.032 25.25.124 154.76-34.77 139.345-244.952-14.19-394.093.012.726 0 1.46 0 2.188 78.964 185.87-136.465 189.104-119.25 11.47-41.686 100.463-132.86-2.147-91.06-91.283zM269.093 332.25c13.51 15.806 22.35 33.086 22.78 50.812.587 24.03-9.293 47.12-24.53 66.563-14.832 18.926-34.837 34.62-56.625 43.656 33.127-.065 64.926-.16 95.217-.25l-.062-.186c30.95-18.584 47.31-38.83 53.75-57.813 6.44-18.982 3.25-37.246-5.844-53.718-15.44-27.97-49.705-47.71-84.686-49.062z"/>',count:o=>o.bestStreak>=12?1:0,detail:o=>`Best: ${o.bestStreak} in a row`},
  wizard:{tier:'rare',name:'Tiebreak Wizard',desc:'Guess the exact tiebreaker total',color:'#4DB3FF',icon:'<path d="M416.125 42.406c-57.576.457-104.863 25.804-144.813 64.875-41.984 41.063-75 97.61-100 155.5.78 4.503 3.06 8.946 7.094 13.658 5.158 6.024 13.183 12.113 23.188 17.593 20.01 10.962 47.79 19.545 75.5 24.47 27.71 4.925 55.505 6.21 75.156 3.438 9.825-1.386 17.538-3.91 21.813-6.563 4.274-2.653 4.916-3.957 4.812-6.625l.72-.03c-3.408-42.828-6-88.797.092-131.94 2.82-19.972 7.668-39.434 15.22-57.624-31.573 31.44-62.918 65.425-86.844 94.72 35.418-70.2 86.2-121.398 141.125-168.97-11.376-1.71-22.42-2.584-33.063-2.5zM155.21 238.994c-2.033-.012-4.053-.012-6.054.006-2.453.022-4.87.065-7.28.125-23.138.575-44.227 2.91-61.876 7.188-23.532 5.703-40.466 14.888-48.78 26.03-8.317 11.144-10.08 24.667-.97 45.532 32.86 75.263 117.185 130.26 207.844 148.594 90.66 18.33 186.108.147 242.28-66.75 13.59-16.185 15.297-29.312 9.938-43.22-5.358-13.908-19.586-28.878-40.78-42.75-14.745-9.65-32.683-18.737-52.75-27.03 1.506 22.59 3.555 44.877 5.124 65.967v.219c.607 11.402-5.49 21.585-14.344 27.938-8.853 6.353-20.268 10.08-33.437 12.406-26.337 4.654-60.026 3.398-93.344-2.188-33.317-5.585-66.085-15.466-90.28-29.312-12.097-6.923-22.145-14.85-28.875-24.47-6.73-9.617-9.76-21.554-6.594-33.374l.095-.375.125-.374c7.637-21.206 16.308-42.79 26.094-64.094-2.053-.032-4.1-.056-6.133-.068zm6.634 46.662c-3.08 7.8-6.017 15.596-8.813 23.344-1.595 6.246-.4 11.407 3.907 17.563 4.374 6.25 12.28 12.923 22.844 18.968 21.128 12.09 52.4 21.78 84.095 27.095 31.694 5.314 64.016 6.28 87 2.22 11.492-2.032 20.53-5.42 25.78-9.19 5.25-3.766 6.864-6.726 6.595-11.78-.517-6.93-1.088-14.027-1.688-21.25-7.448 4.03-16.47 6.367-26.718 7.813-22.732 3.206-51.79 1.665-81.03-3.532-29.242-5.196-58.5-14.055-81.22-26.5-11.36-6.222-21.122-13.34-28.375-21.812-.825-.962-1.62-1.933-2.376-2.938z"/>',count:o=>o.wizard},
  soclose:{tier:'common',name:'So Close',desc:'Miss the tiebreaker by a single point',color:'#9CC9E8',icon:'<path d="M134.745 22.098c-4.538-.146-9.08 1.43-14.893 7.243-5.586 5.586-11.841 21.725-15.248 35.992-.234.979-.444 1.907-.654 2.836l114.254 105.338c-7.18-28.538-17.555-59.985-29.848-86.75-11.673-25.418-25.249-46.657-37.514-57.024-6.132-5.183-11.56-7.488-16.097-7.635zM92.528 82.122L82.124 92.526 243.58 267.651l24.072-24.072L92.528 82.122zm-24.357 21.826c-.929.21-1.857.42-2.836.654-14.267 3.407-30.406 9.662-35.993 15.248-5.813 5.813-7.39 10.355-7.244 14.893.147 4.538 2.452 9.965 7.635 16.098 10.367 12.265 31.608 25.842 57.025 37.515 26.766 12.293 58.211 22.669 86.749 29.848L68.17 103.948zM280.899 255.79l-25.107 25.107 73.265 79.469 31.31-31.31L280.9 255.79zm92.715 85.476l-32.346 32.344 2.07 2.246c.061.058 4.419 4.224 10.585 6.28 6.208 2.069 12.71 2.88 21.902-6.313 9.192-9.192 8.38-15.694 6.31-21.902-2.057-6.174-6.235-10.54-6.283-10.59l-2.238-2.065zm20.172 41.059a46.23 46.23 0 0 1-5.233 6.226 46.241 46.241 0 0 1-6.226 5.235L489.91 489.91l-96.125-107.586z"/>',count:o=>o.soclose},
  ironman:{tier:'common',name:'Iron Man',desc:'Pick every game, every week',color:'#8A93A3',icon:'<path d="M128.688 115.594v147.75h285v-147.75h-285zm-111.844 20.47c17.374 47.14 54.372 80.413 94.906 93.81v-93.81H16.844zm414.375 12.31v88.657c21.457-9.083 42.92-25.257 64.374-47.374-21.52-22.562-42.633-35.173-64.375-41.28zm-226.25 132.47c-12.15 38.536-33.897 71.5-60.595 100.47l257.844-.002c-28.705-29.016-49.952-62.054-61.5-100.468H204.97zM101.843 400v43.78h337.562V400H101.844z"/>',count:o=>o.scoredWeeks>0&&o.fullWeeks===o.scoredWeeks?1:0,detail:o=>`Every pick in all ${o.scoredWeeks} scored ${o.scoredWeeks===1?'week':'weeks'}`},
  comeback:{tier:'rare',name:'Comeback Kid',desc:'Finish last, then win the next week',color:'#B0E64C',icon:'<path d="M259.375 16.25c-132.32 0-239.78 107.46-239.78 239.78s107.46 239.783 239.78 239.783 239.78-107.462 239.78-239.782-107.46-239.78-239.78-239.78zm33.5 20.406c26.563 4.015 51.57 12.708 74.156 25.25L308.907 209.03c-14.573-7.215-30.96-11.344-48.312-11.53l32.28-160.844zm-67.72.094l23.97 161.22c-17.2 1.56-33.28 6.986-47.313 15.436l-51-151c22.616-12.698 47.696-21.54 74.344-25.656zm193.25 64.5c17.683 18.164 32.28 39.32 42.94 62.688l-107.658 85.468c-8.9-14.076-20.863-26.014-34.968-34.875l99.686-113.28zm-319.092 1.063L192.5 219.686c-13.318 9.978-24.317 22.88-32.063 37.75L56.5 166c10.527-23.725 25.082-45.226 42.813-63.688zm378.75 115.906c2.105 12.286 3.218 24.92 3.218 37.81 0 11.49-.882 22.768-2.56 33.783l-107.876 16.062c-.463-17.028-4.757-33.097-12-47.375l119.22-40.28zM40.25 221.093l115.844 45.75c-4.918 12.077-7.81 25.224-8.188 39l-107.844-16.03c-1.678-11.016-2.562-22.295-2.562-33.783 0-11.89.954-23.554 2.75-34.936zm130.563 89.53h177.125L467 334.532c-31.674 83.843-112.62 143.376-207.625 143.376-95.018 0-175.968-59.548-207.625-143.406l119.063-23.875z"/>',count:o=>o.comeback},
  immaculate:{tier:'mythic',name:'Immaculate',desc:'A perfect week with the tiebreaker within 3',color:'#FF4FD8',icon:'<path d="M78.594 20.313c-20.396-.083-40.037 3.83-57.78 12.468C126.016 63.043 213.21 117.8 289.185 187.813c-9.978-45.738-40.414-87.43-79.375-117.78-11.143 8.35-27.725 8.505-41.156.75-13.402-7.74-21.53-22.143-19.906-35.938-23.19-9.237-47.145-14.438-70.156-14.532zm101.625 6.625c-5.215.166-9.516 2.475-11.532 5.968-3.442 5.962-.55 15.975 9.343 21.688 9.894 5.713 19.997 3.212 23.44-2.75 3.44-5.962.58-16.006-9.314-21.72-3.71-2.14-7.465-3.108-10.875-3.186-.354-.01-.714-.012-1.06 0zm-43.25 73.906L31.75 283.188c5.972 8.454 13.093 14.29 25.125 15.062l105.47-182.78c-8.03-5.31-16.5-10.178-25.376-14.626zm194.78 6.25l-17.406 10.78-10.22 66.657 38.313-59.124-10.687-18.312zm-140.344 61.72l-21.844 13.467 14.375 17.314 86.157-4.75-78.688-26.03zm209.75.686l-3.78 1.156-181.095 55.906-3.75 1.188-1.81 3.5-42.314 82.875-3.625 7.125 6.47 4.688 216.53 157.25 10.126 7.343 4.156-11.81 88.563-251.44 2.656-7.5-7-3.81-81.655-44.564-3.47-1.906zm-2.03 20.188l63.28 34.562-65.97 20.344-33.248-43.813 35.937-11.093zm-54.97 16.968l33.28 43.813L279 280.843l2.78-54.938 62.376-19.25zM262.78 231.78L260 286.72l-67.22 20.75 32.782-64.19 37.22-11.5zm202.5 11.126L400 428.312l4.063-166.5 61.218-18.906zm-80.06 24.72l-4.064 166.5-98.812-134.72 102.875-31.78zm-121.783 37.593L364.75 443.374 201.062 324.5l62.375-19.28z"/>',count:o=>o.immaculate},
  untouchable:{tier:'mythic',name:'Untouchable',desc:'Win five weeks in a row',color:'#FF4FD8',icon:'<path d="M460.406 22.125l-10.47 1.25c-132.005 15.758-263.716 19.22-395.248.03L54 23.282H44v9.345c0 103.06 10.502 205.848 41.25 289.22 30.748 83.37 82.665 147.96 164.344 170.405l2.22.594 2.217-.47c89.592-19.1 142.168-83.93 171-168.155 28.835-84.225 35.376-188.492 35.376-291.595v-10.5zm-18.78 20.906c-.265 56.583-2.753 113.052-9.813 165.595l-97.282 41.28L417.22 285c-2.957 11.405-6.22 22.478-9.876 33.156-22.214 64.89-57.017 114.956-112.97 141.188l-41.843-98.375-40.75 95.842c-50.813-28.117-85.577-77.93-109-141.437-3.886-10.54-7.41-21.46-10.655-32.688l77.188-32.78-93.657-41.376c-8.595-52.263-12.39-108.494-12.812-165.186 49.124 6.71 98.217 10.326 147.28 11.406l42.595 100.188 42.843-100.782c48.718-1.684 97.41-5.558 146.062-11.125zM86.218 66.78c0 43.91 2.32 87.696 7.968 129.157l122.937 54.313-101.344 43.03c18.374 55.7 46.708 101.438 88.75 129.033l48.19-113.375 49.468 116.375c46.042-26.184 74.48-72.526 91.75-129.563l-107.22-45.5 126.313-53.625c4.576-41.822 6.064-85.915 6.064-129.844-36.633 4.374-73.274 7.63-109.906 9.44l-56.47 132.874L196.5 76.874c-36.768-1.483-73.514-4.73-110.28-10.093z"/>',count:o=>o.untouchable},
  dynasty:{tier:'epic',name:'Dynasty',desc:'Win three weeks in a row',color:'#F5B400',icon:'<path d="M408.256 119.46l-37.7 52.165 19.57 44.426 34.8-37.214-16.67-59.375zm86.074 12.513L384.44 249.498 334.01 135.02l-75.162 132.947-86.948-131.78-33.334 114.122L17.922 132.83l39.3 127.6c1.945-.348 3.94-.54 5.98-.54 18.812 0 34.26 15.452 34.26 34.262 0 13.823-8.346 25.822-20.235 31.22l5.337 17.33c12.425 25.466 71.863 45.152 176.582 47.206 110.805 2.174 178.12-17.54 189.854-47.207h-.002l4.357-20.26c-16.836-2.114-30.02-16.612-30.02-33.986 0-18.81 15.45-34.262 34.263-34.262 3.513 0 6.91.54 10.11 1.54l26.622-123.762zm-391.77 2.04l1.22 56.337 25.56 24.89 9.592-32.842-36.37-48.386zm150.585 2.91l-24.483 51.36 28.955 43.885 24.922-44.08-29.395-51.166zm204.453 135.962c-8.712 0-15.575 6.862-15.575 15.572 0 8.71 6.863 15.574 15.575 15.574s15.572-6.863 15.572-15.573-6.86-15.572-15.572-15.572zM63.2 278.58c-8.71 0-15.573 6.864-15.573 15.574s6.862 15.573 15.574 15.573c8.713 0 15.573-6.862 15.573-15.573 0-8.71-6.86-15.574-15.572-15.574zm130.33 17.842c18.812 0 34.26 15.45 34.26 34.262 0 18.81-15.448 34.26-34.26 34.26-18.813 0-34.262-15.45-34.262-34.26s15.45-34.262 34.26-34.262zm131.234 0c18.812 0 34.26 15.45 34.26 34.262 0 18.81-15.448 34.26-34.26 34.26-18.813 0-34.262-15.45-34.262-34.26s15.45-34.262 34.262-34.262zm-131.235 18.69c-8.713 0-15.573 6.86-15.573 15.572 0 8.71 6.86 15.574 15.572 15.574 8.71 0 15.572-6.864 15.572-15.574s-6.86-15.573-15.573-15.573zm131.234 0c-8.712 0-15.573 6.86-15.573 15.572 0 8.71 6.862 15.574 15.574 15.574s15.574-6.864 15.574-15.574-6.862-15.573-15.574-15.573z"/>',count:o=>o.dynasty},
  spoon:{tier:'common',name:'Wooden Spoon',desc:'Finish last in a week',color:'#C08A5B',icon:'<path d="M67 20.31c-42.25.41-79.45 58.42-19.84 72.19C151 116.5 232 178.6 295.1 275.6c8.2 16.3 14.4 32.5 11.3 48.8-4.4 15.9-5.3 32-3.2 45.9 4.1 25 16.5 52.2 37.8 75.4 21.2 23.2 46.9 37.8 71.4 44 24.5 6.1 49 4.3 65.4-10.7 16.5-15.1 18.6-38.2 12.9-61.7-5.7-23.5-20-48.8-41-71.7-21-23-44.9-39.5-67.8-47.3-8.2-2.8-16.5-4.6-24.4-5-13.6-5.5-23.6-17.1-32.6-30.5C269.3 154.7 186.7 84.04 90.4 26.66c-7.62-3.79-16.14-6.35-23.4-6.35zM322.2 335.8c24.6 61.8 73.3 110.8 127.6 137.5-8.4 1.5-18.9 1.1-30.3-1.7-21-5.3-44.5-18.3-63.8-39.3-19.3-21.1-30.7-46.4-34.2-67.9-1-9.7-1.3-20.1.7-28.6z"/>',count:o=>o.spoon},
};
const BADGES=Object.values(BADGE);
function badgeIcon(b){return `<span class="badge-ico t-${b.tier||'common'}" style="--bc:${(TIER[b.tier]||TIER.common).color}"><svg viewBox="0 0 512 512" aria-hidden="true">${b.icon}</svg></span>`}
function tierRank(b){return (TIER[b.tier]||TIER.common).rank}

let statsCache={key:'',value:null};
function seasonStats(){
  const ps=players();
  const key=JSON.stringify([S.picks,S.lines,ps.map(p=>p.id),Object.values(S.weeks).map(wk=>wk.games.map(g=>g.id+(g.w||'')+g.as+'-'+g.hs))]);
  if(statsCache.key===key)return statsCache.value;
  const out=Object.fromEntries(ps.map(p=>[p.id,{p,points:0,poPoints:0,champ:0,spoon:0,perfect:0,upsets:0,wizard:0,bestStreak:0,streak:0,right:0,wrong:0,weeks:{},
    lone:0,dogpile:0,sharp:0,comeback:0,b2b:0,slayer:0,soclose:0,fullWeeks:0,scoredWeeks:0,dynasty:0,landslide:0,immaculate:0,untouchable:0,
    champion:0,longgame:0,wire:0,ring:0,postseason:0,photo:0,heart:0,bullseye:0,perfectsun:0,grain:0,chalk:0,rockbottom:0,icecold:0,loyalist:0,jinx:0,loyalTeam:'',jinxTeam:''}]));
  const seq=Object.fromEntries(ps.map(p=>[p.id,[]]));
  // where each player finished in the previous scored week, for the badges that span two weeks
  let was={};
  const champRun={},spoonRun={},poWins={},teams={};
  // standings as they stood each week, for the badges that only settle in January
  let leaders=new Set(ps.map(p=>p.id)),halfLast=[],regScored=0;
  for(let w=1;w<=MAX_WEEK;w++){
    const games=weekGames(w);if(!games.length)continue;
    const lines=S.lines['w'+w]||{};
    const roster=rosterFor(w);
    const wkUpsets=Object.fromEntries(roster.map(p=>[p.id,0]));
    const wkDogs=Object.fromEntries(roster.map(p=>[p.id,0]));
    const wkChalk=Object.fromEntries(roster.map(p=>[p.id,0]));
    const sunRight=Object.fromEntries(roster.map(p=>[p.id,0]));
    let sunGames=0;
    for(const g of games){
      if(isSundayDay(g))sunGames++;
      for(const p of roster){
        const pick=picksFor(w,p.id)[g.id];if(!pick)continue;
        const fav=lines[g.id];
        if(fav&&fav.fav){if(pick===fav.fav)wkChalk[p.id]++;else wkDogs[p.id]++}
        if(isSundayDay(g)&&pick===g.w)sunRight[p.id]++;
        const mine=teams[p.id]||(teams[p.id]={});
        const rec=(ab)=>mine[ab]||(mine[ab]={backed:0,against:0,lost:0});
        const r=rec(pick);r.backed++;if(g.w&&g.w!=='TIE'&&g.w!==pick)r.lost++;
        rec(pick===g.h.ab?g.a.ab:g.h.ab).against++;
      }
    }
    for(const g of games){
      if(!g.w||g.w==='TIE')continue;
      const fav=lines[g.id];
      let right=[],made=0;
      for(const p of roster){
        const pick=picksFor(w,p.id)[g.id],o=out[p.id],ok=pick===g.w;
        if(pick)made++;
        if(ok)o.right++;else o.wrong++;
        if(ok)right.push(p.id);
        seq[p.id].push(ok);
        if(ok&&fav&&fav.fav&&pick!==fav.fav){
          o.upsets++;wkUpsets[p.id]++;
          if(fav.line>=10)o.slayer++;
        }
      }
      // standing alone only counts when there was a crowd to stand apart from
      if(right.length===1&&made>1)out[right[0]].lone++;
    }
    const sc=weekScore(w);if(!sc.complete)continue;
    // how far clear the winner finished, for the Landslide badge
    const tops=sc.rows.map(r=>r.right).sort((a,b)=>b-a);
    const margin=tops.length>1?tops[0]-tops[1]:0;
    const next={};
    for(const r of sc.rows){
      const o=out[r.p.id];
      if(w<=18)o.points+=r.pts;else o.poPoints+=r.pts;
      o.weeks[w]={pts:r.pts,place:r.place,right:r.right,wrong:r.wrong};
      o.scoredWeeks++;
      if(r.made===games.length)o.fullWeeks++;
      if(r.place===1)o.champ++;
      if(r.place===1&&margin>=4)o.landslide++;
      if(sc.byTiebreak&&r.right===sc.rows[0].right){if(r.place===1)o.photo++;else o.heart++}
      if(r.place===1&&r.tb!==null&&sc.actual!==null&&r.tb===sc.actual)o.bullseye++;
      if(r.place===1&&wkDogs[r.p.id]>=6)o.grain++;
      if(r.place===1&&r.made===games.length&&wkChalk[r.p.id]===games.length)o.chalk++;
      if(sunGames>0&&sunGames<games.length&&r.wrong>0&&sunRight[r.p.id]===sunGames)o.perfectsun++;
      if(r.made===games.length&&r.right<4)o.icecold++;
      spoonRun[r.p.id]=r.place===sc.rows.length?(spoonRun[r.p.id]||0)+1:0;
      if(spoonRun[r.p.id]===3)o.rockbottom++;
      if(w>18){if(r.place===1)poWins[r.p.id]=(poWins[r.p.id]||0)+1;
        if(w===22&&r.place===1)o.ring++;
        if(w===22&&poWins[r.p.id]===4)o.postseason++;}
      if(r.place===sc.rows.length)o.spoon++;
      if(r.wrong===0&&r.right>0)o.perfect++;
      if(r.wrong>0&&r.right/(r.right+r.wrong)>=.85)o.sharp++;
      if(wkUpsets[r.p.id]>=5)o.dogpile++;
      champRun[r.p.id]=r.place===1?(champRun[r.p.id]||0)+1:0;
      if(champRun[r.p.id]===3)o.dynasty++;
      if(champRun[r.p.id]===5)o.untouchable++;
      if(r.wrong===0&&r.right>0&&r.tb!==null&&sc.actual!==null&&Math.abs(r.tb-sc.actual)<=3)o.immaculate++;
      if(r.place===1&&was[r.p.id]==='first')o.b2b++;
      if(r.place===1&&was[r.p.id]==='last')o.comeback++;
      next[r.p.id]=r.place===1?'first':r.place===sc.rows.length?'last':'mid';
      if(r.tb!==null&&sc.actual!==null&&r.tb===sc.actual)o.wizard++;
      if(r.tb!==null&&sc.actual!==null&&Math.abs(r.tb-sc.actual)===1)o.soclose++;
    }
    was=next;
    if(w<=18){
      regScored++;
      const best=Math.max(...ps.map(p=>out[p.id].points));
      const atop=ps.filter(p=>out[p.id].points===best&&best>0).map(p=>p.id);
      leaders=new Set(atop.filter(id=>leaders.has(id)));
      if(regScored===9){const low=Math.min(...ps.map(p=>out[p.id].points));halfLast=ps.filter(p=>out[p.id].points===low).map(p=>p.id)}
    }
  }
  // the season prizes, awarded only once all 18 weeks are on the board
  if(regScored===18){
    const best=Math.max(...ps.map(p=>out[p.id].points));
    for(const p of ps){
      const o=out[p.id];
      if(o.points===best){o.champion++;if(halfLast.includes(p.id))o.longgame++}
      if(leaders.has(p.id)&&o.points===best)o.wire++;
    }
  }
  // the team you never picked against, and the one that never repaid the favour
  for(const p of ps){
    const o=out[p.id],mine=teams[p.id]||{};
    for(const [ab,r] of Object.entries(mine)){
      if(r.backed>=10&&r.against===0&&!o.loyalist){o.loyalist++;o.loyalTeam=ab}
      if(r.backed>=5&&r.lost===r.backed&&!o.jinx){o.jinx++;o.jinxTeam=ab}
    }
  }
  for(const p of ps){let cur=0,best=0;for(const ok of seq[p.id]){cur=ok?cur+1:0;best=Math.max(best,cur)}out[p.id].streak=cur;out[p.id].bestStreak=best}
  statsCache={key,value:out};
  return out;
}

function recapCard(w,sc){
  const ps=rosterFor(w),games=weekGames(w).filter(g=>g.w&&g.w!=='TIE'),lines=S.lines['w'+w]||{};
  const names=(list)=>list.map(p=>esc(p.name)).join(list.length===2?' and ':', ');
  const item=(b,label,text)=>`<li>${badgeIcon(b)}<div><b>${label}</b><span>${text}</span></div></li>`;
  const top=sc.rows.slice(0,3),order=[top[1],top[0],top[2]].filter(Boolean);
  let h=`<section class="recap"><p class="eyebrow">${weekName(w)} recap</p><div class="podium3">${order.map(r=>`<div class="pd pd${r.place}" style="--c:${esc(r.p.color)}"><span class="jersey av-${r.p.id}">${initial(r.p)}</span><b>${esc(r.p.name)}</b><small class="num">${r.right}–${r.wrong}</small><div class="pd-step"><span>${PLACE_LABEL[r.place-1]}</span><em class="num">+${r.pts}</em></div></div>`).join('')}</div><ul class="hl">`;
  let best=null;
  for(const g of games){
    const right=ps.filter(p=>picksFor(w,p.id)[g.id]===g.w);
    if(right.length&&right.length<ps.length&&(!best||right.length<best.right.length))best={g,right};
  }
  if(best){
    const t=best.g.w===best.g.a.ab?best.g.a:best.g.h,o=t===best.g.a?best.g.h:best.g.a;
    h+=item(BADGE.perfect,'Best pick',best.right.length===1?`${esc(best.right[0].name)} was the only one to take the ${esc(t.name)} over the ${esc(o.name)}`:`${names(best.right)} took the ${esc(t.name)} over the ${esc(o.name)}`);
  }
  let up=null;
  for(const g of games){const f=lines[g.id];if(f&&f.fav&&f.fav!==g.w&&(!up||(f.line||0)>(up.f.line||0)))up={g,f}}
  if(up){
    const t=up.g.w===up.g.a.ab?up.g.a:up.g.h,o=t===up.g.a?up.g.h:up.g.a;
    const called=ps.filter(p=>picksFor(w,p.id)[up.g.id]===up.g.w);
    h+=item(BADGE.upset,'Biggest upset',`The ${esc(t.name)} beat the favored ${esc(o.name)}${up.f.line?` (+${up.f.line})`:''} · ${called.length?`called by ${names(called)}`:'nobody saw it coming'}`);
  }
  if(sc.actual!==null){
    const guessed=sc.rows.filter(r=>r.tb!==null);
    if(guessed.length){
      const c=guessed.reduce((a,b)=>Math.abs(b.tb-sc.actual)<Math.abs(a.tb-sc.actual)?b:a);
      h+=item(BADGE.wizard,'Closest tiebreaker',`${esc(c.p.name)} guessed ${c.tb}; the final total was ${sc.actual}`);
    }
  }
  const last=sc.rows[sc.rows.length-1];
  h+=item(BADGE.spoon,'Wooden Spoon',`${esc(last.p.name)} takes home the spoon at ${last.right}–${last.wrong}. There’s always next week.`);
  return h+'</ul>'+satOutNote(w)+'</section>';
}

let chartModel=null;
function seasonChart(stats,done){
  const ps=players(),W=Math.round(Math.max(260,Math.min(720,((document.getElementById('app')||{}).clientWidth||360)-30))),H=216,m={l:30,r:40,t:22,b:26};
  const series=ps.map(p=>{let t=0;return {p,vals:[0,...done.map(k=>t+=((stats[p.id].weeks[k]||{}).pts||0))]}});
  const maxV=Math.max(3,...series.flatMap(x=>x.vals)),step=maxV<=6?1:maxV<=15?3:maxV<=30?5:10,top=Math.ceil(maxV/step)*step;
  const n=done.length,px=(i)=>m.l+i*(W-m.l-m.r)/n,py=(v)=>m.t+(1-v/top)*(H-m.t-m.b);
  let svg=`<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Season points after each week">`;
  for(let v=0;v<=top;v+=step)svg+=`<line class="grid" x1="${m.l}" x2="${W-m.r}" y1="${py(v)}" y2="${py(v)}"/><text class="axis" x="${m.l-8}" y="${py(v)+4}" text-anchor="end">${v}</text>`;
  const every=n>12?3:n>6?2:1;
  for(let i=0;i<=n;i++)if(i===0||i===n||i%every===0)svg+=`<text class="axis" x="${px(i)}" y="${H-8}" text-anchor="${i===0?'start':i===n?'end':'middle'}">${i===0?'Start':'Wk '+done[i-1]}</text>`;
  svg+=`<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H-m.b}" visibility="hidden"/>`;
  [...series].sort((a,b)=>a.vals[n]-b.vals[n]).forEach(x=>{
    svg+=`<path d="${x.vals.map((v,i)=>`${i?'L':'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${esc(x.p.color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    x.vals.forEach((v,i)=>{if(i)svg+=`<circle class="dot" cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="4" fill="${esc(x.p.color)}"/>`});
  });
  // Initials at the line ends, nudged apart so tied lines stay identifiable without relying on color
  const ends=[...series].sort((a,b)=>b.vals[n]-a.vals[n]).map(x=>({x,y:py(x.vals[n])}));
  for(let i=1;i<ends.length;i++)if(ends[i].y-ends[i-1].y<17)ends[i].y=ends[i-1].y+17;
  const overflow=ends.length?ends[ends.length-1].y-(H-m.b):0;
  if(overflow>0)ends.forEach(e=>e.y-=overflow);
  ends.forEach(({x,y})=>{
    const ex=px(n)+18;
    svg+=`<line class="leader" x1="${(px(n)+5).toFixed(1)}" y1="${py(x.vals[n]).toFixed(1)}" x2="${(ex-8).toFixed(1)}" y2="${y.toFixed(1)}"/><circle cx="${ex}" cy="${y.toFixed(1)}" r="8" fill="${esc(x.p.color)}" class="dot"/><text class="endlbl" x="${ex}" y="${(y+3.5).toFixed(1)}" text-anchor="middle">${initial(x.p)}</text>`;
  });
  svg+='</svg>';
  chartModel={px:Array.from({length:n+1},(_,i)=>px(i)),labels:['Start',...done.map(k=>weekName(k))],series:series.map(x=>({name:x.p.name,color:x.p.color,vals:x.vals}))};
  const legend=[...series].sort((a,b)=>b.vals[n]-a.vals[n]).map(x=>`<span class="lgd"><span class="jersey mini av-${x.p.id}" style="--c:${esc(x.p.color)}">${initial(x.p)}</span>${esc(x.p.name)} <b class="num">${x.vals[n]}</b></span>`).join('');
  return `<div class="chart-legend">${legend}</div><div class="chart" data-chart>${svg}<div class="chart-tip" hidden></div></div>`;
}
function chartHover(e){
  const box=e.target.closest('[data-chart]');if(!box||!chartModel)return;
  const svg=box.querySelector('svg'),r=svg.getBoundingClientRect(),vw=svg.viewBox.baseVal.width;
  const x=(e.clientX-r.left)*vw/r.width;
  let i=0,best=Infinity;chartModel.px.forEach((p,k)=>{const d=Math.abs(p-x);if(d<best){best=d;i=k}});
  const cross=svg.querySelector('.cross');cross.setAttribute('x1',chartModel.px[i]);cross.setAttribute('x2',chartModel.px[i]);cross.setAttribute('visibility','visible');
  const tip=box.querySelector('.chart-tip');
  tip.innerHTML=`<b>${i?'After '+esc(chartModel.labels[i]):'Start of the season'}</b>`+[...chartModel.series].sort((a,b)=>b.vals[i]-a.vals[i]).map(x=>`<span><i style="background:${esc(x.color)}"></i>${esc(x.name)}<b class="num">${x.vals[i]}</b></span>`).join('');
  tip.hidden=false;
  const at=chartModel.px[i]*r.width/vw;
  tip.style.left=Math.max(0,Math.min(at>box.clientWidth/2?at-tip.offsetWidth-12:at+12,box.clientWidth-tip.offsetWidth))+'px';
}
function hideChartTip(){
  const tip=document.querySelector('[data-chart] .chart-tip');
  if(tip&&!tip.hidden){tip.hidden=true;const c=document.querySelector('[data-chart] .cross');if(c)c.setAttribute('visibility','hidden')}
}
document.addEventListener('pointermove',(e)=>{if(e.target.closest&&e.target.closest('[data-chart]'))chartHover(e);else hideChartTip()});
document.addEventListener('pointerdown',(e)=>{if(e.target.closest&&e.target.closest('[data-chart]'))chartHover(e)});
let resizeTimer=null;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(S.tab==='standings')render()},200)});

function seasonSection(stats,po){
  const ps=players(),range=po?[19,20,21,22]:Array.from({length:18},(_,i)=>i+1);
  const done=range.filter(k=>weekScore(k).complete);
  const total=(o)=>po?o.poPoints:o.points;
  const rows=ps.map(p=>stats[p.id]).sort((a,b)=>total(b)-total(a));
  rows.forEach((r,i)=>r.rank=i>0&&total(r)===total(rows[i-1])?rows[i-1].rank:i+1);
  const over=done.length===range.length,champs=rows.filter(r=>r.rank===1),champNames=champs.map(r=>esc(r.p.name)).join(' & ');
  const title=po?(over?`Playoff ${champs.length>1?'co-champions':'champion'} · ${champNames}`:`Playoff points · ${done.length} of 4 rounds final`)
    :(over?`Season ${champs.length>1?'co-champions':'champion'} · ${champNames}`:`Season points · ${done.length} of 18 weeks final`);
  let h=`<section class="card"><p class="eyebrow">${title}</p>`;
  if(!po)h+=done.length>1?seasonChart(stats,done):`<p class="muted">The points chart starts once ${done.length?'a second week is':'Week 1 is'} final.</p>`;
  h+=`<div class="scroll"><table class="num season"><thead><tr><th>Player</th><th>Pts</th>${done.map(k=>`<th>${po?ROUNDS[k].short:'Wk '+k}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach(r=>{
    h+=`<tr data-profile="${r.p.id}"><td><span class="pcell"><span class="rk">${r.rank}</span><span class="jersey mini av-${r.p.id}" style="--c:${esc(r.p.color)}">${initial(r.p)}</span><span>${esc(r.p.name)}</span>${over&&r.rank===1?'<span class="crown">★</span>':''}</span></td><td class="tot">${total(r)}</td>${done.map(k=>{const c=r.weeks[k];return `<td>${c?`<span class="plc plc${c.place}${c.place===ps.length?' last':''}" title="${PLACE_LABEL[c.place-1]}">${c.pts}</span>`:'–'}</td>`}).join('')}</tr>`;
  });
  return h+'</tbody></table></div></section>';
}

function trophyCase(stats){
  const rows=players().map(p=>stats[p.id]).sort((a,b)=>b.points-a.points||b.champ-a.champ);
  let h='<section class="card"><p class="eyebrow">Trophy case</p>';
  rows.forEach(o=>{
    const earned=BADGES.filter(b=>b.count(o)).sort((a,b)=>tierRank(b)-tierRank(a));
    h+=`<button type="button" class="tc-row" data-profile="${o.p.id}" style="--c:${esc(o.p.color)}"><span class="jersey av-${o.p.id}">${initial(o.p)}</span><b>${esc(o.p.name)}</b><span class="tc-badges">${earned.length?earned.map(b=>`<span class="tc-b" title="${b.name}">${badgeIcon(b)}${b.count(o)>1?`<small>${b.count(o)}</small>`:''}</span>`).join(''):'<small class="muted">No badges yet</small>'}</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`;
  });
  return h+'</section>';
}

/* ---- profiles, avatars and PINs (a family lock, not real security) ---- */
function applyAvatarCss(){
  let el=document.getElementById('avatarCss');
  if(!el){el=document.createElement('style');el.id='avatarCss';document.head.appendChild(el)}
  const css=Object.entries(S.profiles)
    .filter(([id,pr])=>/^p[1-5]$/.test(id)&&typeof pr.avatar==='string'&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(pr.avatar))
    .map(([id,pr])=>`.av-${id}{background-image:url("${pr.avatar}");background-size:cover;background-position:center;color:transparent!important}`).join('\n');
  if(el.textContent!==css)el.textContent=css;
}
async function makeAvatar(file){
  const src=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src});
    const size=192,c=document.createElement('canvas');c.width=c.height=size;
    const side=Math.min(img.naturalWidth,img.naturalHeight);
    c.getContext('2d').drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,size,size);
    return c.toDataURL('image/jpeg',.82);
  }finally{URL.revokeObjectURL(src)}
}
async function saveProfile(pid,changes,okMsg){
  const cur=S.profiles[pid]||{};
  const next={color:cur.color||'',avatar:cur.avatar||'',pinHash:cur.pinHash||'',pinSalt:cur.pinSalt||'',...changes,updatedAt:new Date().toISOString()};
  S.profiles={...S.profiles,[pid]:next};applyAvatarCss();render();renderProfile();
  try{await S.db.doc('profiles/'+pid).set(next);if(okMsg)toast(okMsg);return true}
  catch{S.profiles={...S.profiles,[pid]:cur};applyAvatarCss();render();renderProfile();toast('That didn’t save. Check your connection and try again.');return false}
}

const UNLOCK_MS=10*60e3;
let pin={pid:null,mode:'enter',entry:'',first:'',why:'',action:null,fails:0,blockedUntil:0,busy:false};
function unlockInfo(){try{return JSON.parse(store.get('unlock')||'null')}catch{return null}}
function isUnlocked(pid){const u=unlockInfo();return !!u&&u.pid===pid&&u.until>Date.now()}
function setUnlocked(pid){store.set('unlock',JSON.stringify({pid,until:Date.now()+UNLOCK_MS}))}
function signOutPin(){store.set('unlock','null');render();renderProfile();toast('Signed out on this device')}
async function hashPin(code,salt){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+':'+code));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function newSalt(){const a=new Uint8Array(8);crypto.getRandomValues(a);return [...a].map(b=>b.toString(16).padStart(2,'0')).join('')}
function requirePin(pid,why,action){
  if(!S.db){toast('Changes can’t be saved right now.');return}
  if(S.parent){action();return}
  if(isUnlocked(pid)){setUnlocked(pid);action();return}
  openPin(pid,(S.profiles[pid]||{}).pinHash?'enter':'create',why,action);
}
function changePin(pid){
  if(!(S.profiles[pid]||{}).pinHash){openPin(pid,'create','',null);return}
  // the database only lets a parent replace a PIN that's already set
  requireParent(`Enter the parent password to change ${player(pid).name}’s PIN.`,()=>openPin(pid,'create','',null));
}
function openPin(pid,mode,why,action){
  const p=player(pid);
  pin={...pin,pid,mode,entry:'',first:'',why,action,busy:false};
  const face=$('#pinFace');face.className='jersey av-'+pid;face.style.setProperty('--c',p.color);face.textContent=(p.name||'?').trim().charAt(0).toUpperCase();
  drawPin();
  const d=$('#pinDlg');if(!d.open)d.showModal();
}
function drawPin(msg){
  const p=player(pin.pid);
  $('#pinTitle').textContent=pin.mode==='enter'?`${p.name}’s PIN`:pin.mode==='create'?`Create a PIN for ${p.name}`:'Enter it once more';
  $('#pinWhy').textContent=pin.mode==='enter'?pin.why:pin.mode==='create'?'4 digits. Keep it to yourself, and don’t reuse your phone or bank PIN.':'Just to be sure.';
  $('#pinDots').querySelectorAll('i').forEach((dot,i)=>dot.classList.toggle('on',i<pin.entry.length));
  $('#pinErr').hidden=!msg;$('#pinErr').textContent=msg||'';
  $('#pinForgot').hidden=pin.mode!=='enter';
}
function shakePin(){const d=$('#pinDots');d.classList.remove('shake');void d.offsetWidth;d.classList.add('shake')}
function closePin(cancelled){
  const d=$('#pinDlg');if(d.open)d.close();
  pin.entry='';pin.first='';
  if(cancelled){pin.action=null;render()}
}
async function pinKey(k){
  if(k==='cancel'){closePin(true);return}
  if(pin.busy)return;
  if(Date.now()<pin.blockedUntil){drawPin(`Too many tries. Wait ${Math.ceil((pin.blockedUntil-Date.now())/1000)} seconds.`);return}
  if(k==='back'){pin.entry=pin.entry.slice(0,-1);drawPin();return}
  if(!/^\d$/.test(k)||pin.entry.length>=4)return;
  pin.entry+=k;drawPin();
  if(pin.entry.length<4)return;
  pin.busy=true;
  try{
    const pid=pin.pid,code=pin.entry;
    if(pin.mode==='enter'){
      const pr=S.profiles[pid]||{};
      if(pr.pinHash&&await hashPin(code,pr.pinSalt||'')===pr.pinHash){pin.fails=0;setUnlocked(pid);finishPin();return}
      pin.fails++;pin.entry='';
      if(pin.fails>=5){pin.fails=0;pin.blockedUntil=Date.now()+30e3}
      shakePin();drawPin(Date.now()<pin.blockedUntil?'Too many tries. Wait 30 seconds.':'That PIN didn’t match. Try again.');
    }else if(pin.mode==='create'){
      pin.first=code;pin.entry='';pin.mode='confirm';drawPin();
    }else{
      if(code!==pin.first){pin.mode='create';pin.entry='';pin.first='';shakePin();drawPin('Those didn’t match. Start again.');return}
      const salt=newSalt(),hash=await hashPin(code,salt);
      if(!await saveProfile(pid,{pinHash:hash,pinSalt:salt},'PIN saved')){pin.mode='create';pin.entry='';pin.first='';drawPin('The PIN didn’t save. Check your connection and try again.');return}
      setUnlocked(pid);finishPin();
    }
  }finally{pin.busy=false}
}
function finishPin(){
  const action=pin.action;pin.action=null;
  closePin(false);render();renderProfile();
  if(action)action();
}
document.addEventListener('keydown',(e)=>{
  if(e.key==='Escape'&&!$('#unlock').hidden){nextCelebration();return}
  if(!$('#pinDlg').open)return;
  if(/^\d$/.test(e.key)){e.preventDefault();pinKey(e.key)}
  else if(e.key==='Backspace'){e.preventDefault();pinKey('back')}
});

let profOpen=null;
function openProfile(pid){profOpen=pid;renderProfile();const d=$('#profDlg');if(!d.open)d.showModal();$('#profBody').scrollTop=0}
function closeProfile(){profOpen=null;const d=$('#profDlg');if(d.open)d.close()}
function renderProfile(){
  if(!profOpen)return;
  const p=player(profOpen),o=seasonStats()[p.id],pr=S.profiles[p.id]||{},un=isUnlocked(p.id);
  const tiles=[['Season pts',o.points],['Weekly wins',o.champ],['Best streak',o.bestStreak],['Upsets',o.upsets]];
  let h=`<div class="pf-top" style="--c:${esc(p.color)}"><span class="jersey pf-face av-${p.id}">${initial(p)}</span><div class="pf-id"><b>${esc(p.name)}</b><span class="num">${o.right}–${o.wrong} all season${o.poPoints?` · ${o.poPoints} playoff pts`:''}</span>${un?'<span class="pf-state">Signed in on this device</span>':''}</div></div>`;
  h+=`<div class="pf-tiles">${tiles.map(([label,v])=>`<div><b class="num">${v}</b><span>${label}</span></div>`).join('')}</div>`;
  const all=seasonStats();
  const sorted=[...BADGES].sort((a,b)=>tierRank(b)-tierRank(a)||b.count(o)-a.count(o));
  h+=`<section class="bx-sec"><h4>Badges</h4><div class="badges">${sorted.map(b=>{
    const n=b.count(o),holders=players().filter(x=>b.count(all[x.id])>0);
    const rarity=n?(holders.length===1?'Only you':`${holders.length} of ${players().length} have it`):(holders.length?(holders.length===1?holders[0].name+' has it':holders.length+' have it'):'Nobody yet');
    return `<div class="badge ${b.tier||'common'}${n?'':' dim'}">${badgeIcon(b)}<div><b>${b.name}${n>1?` <span class="num">×${n}</span>`:''}</b><small>${n&&b.detail?b.detail(o):b.desc}</small><span class="tier t-${b.tier||'common'}">${(TIER[b.tier]||TIER.common).label} · ${rarity}</span></div></div>`;
  }).join('')}</div></section>`;
  h+=`<section class="bx-sec"><h4>Make it yours</h4>${un||S.parent?'':`<p class="muted">Changes ask for ${esc(p.name)}’s PIN.</p>`}
    <div class="pf-row"><span class="jersey pf-small av-${p.id}" style="--c:${esc(p.color)}">${initial(p)}</span><label class="toggle">${pr.avatar?'Change photo':'Add a photo'}<input type="file" accept="image/*" data-avatar-input="${p.id}" hidden></label>${pr.avatar?`<button type="button" class="linkbtn" data-avatar-remove="${p.id}">Remove photo</button>`:''}</div>
    <div class="sw pf-sw" role="group" aria-label="Color for ${esc(p.name)}">${COLORS.map(c=>`<button type="button" style="--c:${c}" data-pcolor="${c}" data-pid="${p.id}" aria-pressed="${c===p.color}" aria-label="Color ${c}"></button>`).join('')}</div>
    <div class="pf-row"><button type="button" class="toggle" data-pin-change="${p.id}">${pr.pinHash?'Change PIN':'Set a PIN'}</button>${un?'<button type="button" class="linkbtn" data-pin-signout>Sign out</button>':''}${pr.pinHash?`<button type="button" class="linkbtn quiet" data-pin-reset="${p.id}">Forgot PIN?</button>`:''}</div></section>`;
  $('#profTitle').textContent=p.name;
  $('#profBody').innerHTML=h;
}

// Pregame favorites, saved once per game so upset badges work on every device
function favoriteOf(g){
  if(isTbd(g))return null;
  const c=spreads[g.id]||{},ml=g.ml&&g.ml.h!=null&&g.ml.a!=null?g.ml:c.ml,hl=g.hl!=null?g.hl:c.hl;
  const line=hl!=null?Math.abs(hl):null;
  if(ml&&ml.h!=null&&ml.a!=null){const ih=impliedProb(ml.h),ia=impliedProb(ml.a);if(ih!==ia)return {fav:ih>ia?g.h.ab:g.a.ab,line}}
  if(hl)return {fav:hl<0?g.h.ab:g.a.ab,line};
  return null;
}
function syncLines(){
  if(!S.db||!S.linesLoaded)return;
  for(const [w,wk] of Object.entries(S.weeks)){
    const have=S.lines['w'+w]||{},add={};
    for(const g of wk.games){if(have[g.id])continue;const f=favoriteOf(g);if(f)add[g.id]=f}
    if(!Object.keys(add).length)continue;
    const next={...have,...add};
    S.lines={...S.lines,['w'+w]:next};
    S.db.doc('lines/w'+w).set(next).catch(()=>{});
  }
  backfillLines();
}
// A game that kicked off before anyone opened the page has no favorite yet; ESPN keeps the
// closing line, so fill those in a few at a time.
const lineTried=new Set();
let backfilling=false;
async function backfillLines(){
  if(backfilling||!S.db||!S.linesLoaded)return;
  const todo=[];
  for(const [w,wk] of Object.entries(S.weeks)){
    const have=S.lines['w'+w]||{};
    for(const g of wk.games){
      if(!g.w||have[g.id]||lineTried.has(g.id)||isTbd(g))continue;
      todo.push({w,g});
      if(todo.length>=6)break;
    }
    if(todo.length>=6)break;
  }
  if(!todo.length)return;
  backfilling=true;
  try{
    const found={};
    for(const {w,g} of todo){
      lineTried.add(g.id);
      try{const f=await fetchClosingLine(g.id);if(f&&f.fav){(found[w]=found[w]||{})[g.id]=f}}catch{}
    }
    for(const [w,add] of Object.entries(found)){
      const next={...(S.lines['w'+w]||{}),...add};
      S.lines={...S.lines,['w'+w]:next};
      try{await S.db.doc('lines/w'+w).set(next)}catch{}
    }
    if(Object.keys(found).length)render();
  }finally{backfilling=false}
}

function alertsCard(){
  const on=alertsOn();
  let notify='';
  if('Notification' in window){
    if(Notification.permission==='granted')notify='<span class="muted">Notifications are on while this page is open in the background.</span>';
    else if(Notification.permission==='denied')notify='<span class="muted">Notifications are blocked in this browser’s settings.</span>';
    else notify='<button type="button" class="toggle" id="notifyBtn">Also notify me in the background</button>';
  }
  return `<section class="card"><p class="eyebrow">Score alerts · this device</p>
    <p class="muted">Pop-up banners for scores, kickoffs, finals and weekly winners while you’re watching. Tap one for the box score, or × to dismiss.</p>
    <div class="setrow"><button type="button" class="toggle" id="alertsToggle" aria-pressed="${on}">${on?'Alerts on':'Alerts off'}</button>${on?notify:''}<button type="button" class="linkbtn" id="testAlert">Show a sample alert</button></div></section>`;
}

function renderFamily(app){
  const roster=players();
  let h=`<section class="card"><p class="eyebrow">${roster.length===5?'The five of you':`Everyone · ${roster.length}`}</p><p class="muted">Tap a face for a PIN, photo or color. Adding someone or changing names needs the parent password.</p><form id="famForm">`;
  players().forEach((p,i)=>{
    const pr=S.profiles[p.id]||{};
    h+=`<div class="frow" style="--c:${esc(p.color)}"><button type="button" class="face-btn" data-profile="${p.id}" aria-label="Open ${esc(p.name)}’s profile"><span class="jersey av-${p.id}">${initial(p)}</span>${pr.pinHash?'':'<span class="setup-dot" aria-hidden="true"></span>'}</button>
      <input name="n${i}" value="${esc(p.name)}" maxlength="16" aria-label="Name for player ${i+1}" autocomplete="off">
      ${pr.pinHash?'':`<button type="button" class="toggle" data-profile="${p.id}">Set up</button>`}</div>`;
  });
  h+=`<div class="setrow"><button class="primary" id="saveNames" type="submit" disabled>Save names</button>${roster.length<MAX_PLAYERS?'<button type="button" class="toggle" id="addPerson">Add someone</button>':`<span class="muted">${MAX_PLAYERS} is the most the app holds.</span>`}</div></form></section>`;
  h+=`<section class="card"><p class="eyebrow">Big screen</p><p class="muted">Every game of the week, sized for the room. Open it on the TV or cast this tab.</p><div class="setrow"><a class="toggle" href="?tv" target="_blank" rel="noopener">Open TV mode</a></div></section>`;
  h+=alertsCard();
  if(S.parent)h+=`<section class="card"><p class="eyebrow">Parent controls</p><p class="muted">A parent is signed in on this device. <button type="button" class="linkbtn" id="parentSignOut">Sign out</button></p></section>`;
  h+=`<details class="rules"><summary>How Sunday Picks works</summary><p class="muted">Tap your face at the top of the Picks tab, then tap the team you think will win each game. The first time, you’ll create a 4-digit PIN; after that the app asks for it before anyone picks as you, and hides your picks from everyone else until they lock. It stays signed in on that device for 10 minutes. It’s a family lock rather than a password, so someone determined could get past it; don’t reuse a PIN you use for anything else. Only a parent can change or reset one. You can change a pick until kickoff; then it locks and everyone’s picks show. Each week runs Sunday through the next Thursday. When a week ends, 1st place (most correct picks) gets 3 points, 2nd gets 2 and 3rd gets 1, and last place takes home the Wooden Spoon. After Week 18 the playoffs keep going round by round with their own standings.</p></details>`;
  app.innerHTML=h;
}

/* ---- actions ---- */
async function writePickDoc(w,pid,doc,failMsg){
  const key='w'+w+'-'+pid;
  S.picks[key]=doc;render();
  try{await S.db.doc('picks/'+key).set(doc);maybeAutoLock();return true}
  catch(e){toast(failMsg);return false}
}
function savePick(g,team){
  const w=S.week,me=player(S.me),doc=pickDoc(w,me.id);
  const cur={...(doc.picks||{})};
  const taking=cur[g.id]!==team;
  if(taking){justPicked={game:g.id,team,at:Date.now()};if(!calm())navigator.vibrate?.(8)}
  if(cur[g.id]===team)delete cur[g.id]; else cur[g.id]=team;
  writePickDoc(w,me.id,{...doc,week:w,player:me.id,picks:cur},'That pick didn’t save. Check your connection and tap it again.');
}
document.addEventListener('change',async(e)=>{
  const av=e.target.closest('[data-avatar-input]');
  if(av){
    const pid=av.dataset.avatarInput,file=av.files&&av.files[0];av.value='';
    if(!file)return;
    let data;
    try{data=await makeAvatar(file)}catch{toast('That photo couldn’t be read. Try a JPG or PNG.');return}
    requirePin(pid,`Enter ${player(pid).name}’s PIN to change their photo.`,()=>saveProfile(pid,{avatar:data},'Photo saved'));
    return;
  }
  const second=e.target.closest('[data-tb2]');
  if(second){
    const w=S.week;
    if(!tb2Open(w)){toast('The second tiebreaker is closed.');render();return}
    const me=player(S.me);
    const v=second.value===''?null:Math.max(0,Math.min(150,Math.round(Number(second.value))));
    requirePin(me.id,`Enter ${me.name}’s PIN to save a tiebreaker.`,async()=>{
      if(await writePickDoc(w,me.id,{...pickDoc(w,me.id),week:w,player:me.id,tb2:v,tb2At:serverTimestamp()},'Second tiebreaker didn’t save. Try again.'))toast(v===null?'Second tiebreaker cleared':'Second tiebreaker saved: '+v+' points');
    });
    return;
  }
  const input=e.target.closest('[data-tb]');if(!input)return;
  const g=weekGames(S.week).find(x=>x.id===input.dataset.tb);if(!g)return;
  if(locked(g)){toast('The tiebreaker is locked.');render();return}
  const me=player(S.me),doc=pickDoc(S.week,me.id);
  const v=input.value===''?null:Math.max(0,Math.min(150,Math.round(Number(input.value))));
  requirePin(me.id,`Enter ${me.name}’s PIN to save a tiebreaker.`,async()=>{
    if(await writePickDoc(S.week,me.id,{...pickDoc(S.week,me.id),week:S.week,player:me.id,tb:v,tbAt:serverTimestamp()},'Tiebreaker didn’t save. Try again.'))toast(v===null?'Tiebreaker cleared':'Tiebreaker saved: '+v+' points');
  });
});

document.addEventListener('click',(e)=>{
  const bx=e.target.closest('[data-box]');
  if(bx){openBox(bx.dataset.box);return}
  if(e.target.closest('[data-box-close]')){closeBox();return}
  if(e.target.closest('[data-box-retry]')){loadBox(boxOpenId,true);return}
  if(e.target.closest('[data-tvlive]')){S.tvLive=!S.tvLive;store.set('tvlive',S.tvLive?'1':'0');render();return}
  const bt=e.target.closest('[data-boxtab]');
  if(bt){boxTab=bt.dataset.boxtab;renderBox();$('#boxBody').scrollTop=0;return}
  const key=e.target.closest('[data-key]');
  if(key){pinKey(key.dataset.key);return}
  if(e.target.closest('#meBtn')){openProfile(S.me);return}
  if(e.target.closest('[data-prof-close]')){closeProfile();return}
  const pc=e.target.closest('[data-pcolor]');
  if(pc){const pid=pc.dataset.pid,c=pc.dataset.pcolor;requirePin(pid,`Enter ${player(pid).name}’s PIN to change their color.`,()=>saveProfile(pid,{color:c},'Color saved'));return}
  const ar=e.target.closest('[data-avatar-remove]');
  if(ar){const pid=ar.dataset.avatarRemove;requirePin(pid,`Enter ${player(pid).name}’s PIN to remove their photo.`,()=>saveProfile(pid,{avatar:''},'Photo removed'));return}
  const chg=e.target.closest('[data-pin-change]');
  if(chg){changePin(chg.dataset.pinChange);return}
  if(e.target.closest('[data-pin-signout]')){signOutPin();return}
  const rs=e.target.closest('[data-pin-reset]');
  if(rs){const pid=rs.dataset.pinReset;requireParent(`Enter the parent password to reset ${player(pid).name}’s PIN.`,()=>saveProfile(pid,{pinHash:'',pinSalt:''},`PIN reset. ${player(pid).name} can set a new one next time.`));return}
  const prof=e.target.closest('[data-profile]');
  if(prof&&!e.target.closest('input')){openProfile(prof.dataset.profile);return}
  if(e.target.closest('[data-retry]')){toast('Loading the schedule…');refresh();return}
  const tab=e.target.closest('[data-tab]');
  if(tab){S.fillShown={};S.tab=tab.dataset.tab;S.results=false;store.set('tab',S.tab);withTransition(render);$('#app').scrollTop=0;return}
  const pk=e.target.closest('[data-picker]');
  if(pk){S.me=pk.dataset.picker;store.set('picker',S.me);render();return}
  if(e.target.closest('#resToggle')){S.results=!S.results;render();return}
  const wkBtn=e.target.closest('#weekStrip [data-week]');
  if(wkBtn){const k=+wkBtn.dataset.week;if(k!==S.week){S.week=k;S.results=false;withTransition(render);$('#app').scrollTop=0}return}
  if(e.target.closest('[data-jump]')){
    // Jump to the first game still waiting on a pick, rather than hunting the week for it
    const w=S.week,mine=picksFor(w,S.me),next=weekGames(w).find(g=>!locked(g)&&!isTbd(g)&&!mine[g.id]);
    const card=next&&document.querySelector(`.game[data-card="${next.id}"]`);
    if(card){
      const sc=$('#app');
      const top=card.getBoundingClientRect().top-sc.getBoundingClientRect().top+sc.scrollTop-(($('.pickbar')?.getBoundingClientRect().height||0)+18);
      sc.scrollTo({top,behavior:'smooth'});
      card.classList.remove('flash');void card.offsetWidth;card.classList.add('flash');
    }
    return}
  if(e.target.closest('#lockToggle')){
    const w=S.week;
    if(!weekLocked(w))requireParent(`Enter the parent password to lock ${weekName(w)} picks.`,()=>setLock(w,true));
    else requireParent(`Enter the parent password to unlock ${weekName(w)} picks.`,()=>setLock(w,false));
    return}
  if(e.target.closest('#alertsToggle')){store.set('alerts',alertsOn()?'off':'on');render();return}
  if(e.target.closest('#notifyBtn')){Notification.requestPermission().then(()=>render());return}
  if(e.target.closest('#testAlert')){sampleAlert();return}
  if(e.target.closest('#unlock')){nextCelebration();return}
  if(e.target.closest('[data-alert-close]')){alertQueue.length=0;nextAlert();return}
  const al=e.target.closest('#alert');
  if(al){const id=al.dataset.game;nextAlert();if(id)openBox(id);return}
  if(e.target.closest('#addPerson')){
    const base=(S.family.players||DEFAULT_FAMILY.players).slice(0,MAX_PLAYERS);
    if(base.length>=MAX_PLAYERS){toast(`${MAX_PLAYERS} is the most the app holds.`);return}
    const taken=new Set(base.map(p=>p.id));
    let slot=1;while(taken.has('p'+slot))slot++;
    const usedColors=new Set(base.map(p=>p.color));
    const next={players:[...base,{id:'p'+slot,name:'Player '+slot,color:COLORS.find(c=>!usedColors.has(c))||COLORS[base.length%COLORS.length]}]};
    requireParent('Enter the parent password to add someone.',async()=>{
      const prev=S.family;S.family=next;render();
      try{await S.db.doc('config/family').set(next);toast('Added. Tap their face to set a name, PIN and photo.')}
      catch{S.family=prev;render();toast('Couldn’t add them. Publish the updated database rules first.')}
    });
    return}
  if(e.target.closest('#parentSignOut')){signOut(S.auth).then(()=>toast('Parent signed out on this device'));return}
  const tb=e.target.closest('.team[data-game]');
  if(tb){const g=weekGames(S.week).find(x=>x.id===tb.dataset.game);if(!g)return;
    if(locked(g)){openBox(g.id);return}
    if(isTbd(g)){toast('This matchup isn’t set yet.');return}
    const who=player(S.me);
    requirePin(who.id,`Enter ${who.name}’s PIN to make picks.`,()=>savePick(g,tb.dataset.team))}
});
// Save only wakes up once a name actually changed, so the orange button always means something
document.addEventListener('input',(e)=>{
  if(!e.target.closest('#famForm'))return;
  const btn=$('#saveNames');if(!btn)return;
  const base=(S.family.players||DEFAULT_FAMILY.players).slice(0,MAX_PLAYERS);
  btn.disabled=[...document.querySelectorAll('#famForm input[name^="n"]')].every((inp,i)=>inp.value.trim()===(base[i]||{}).name);
});
document.addEventListener('submit',async(e)=>{
  if(e.target.id!=='famForm')return;e.preventDefault();
  const fd=new FormData(e.target);
  const base=(S.family.players||DEFAULT_FAMILY.players).slice(0,MAX_PLAYERS);
  const next={players:base.map((p,i)=>({id:p.id,name:(fd.get('n'+i)||'').trim().slice(0,16)||'Player '+(i+1),color:p.color||COLORS[i]}))};
  requireParent('Enter the parent password to change names.',async()=>{
    const prev=S.family;S.family=next;
    try{await S.db.doc('config/family').set(next);toast('Family saved');S.tab='picks';store.set('tab','picks');render()}
    catch{S.family=prev;render();toast('Only a parent can change names.')}
  });
});


/* ---- data ---- */
// Firestore behind the small doc/collection surface the page was written against
function makeDb(fs){
  return {
    doc:(p)=>({
      set:(d)=>setDoc(doc(fs,p),d),
      onSnapshot:(next,err)=>onSnapshot(doc(fs,p),s=>next({id:s.id,exists:s.exists(),data:()=>s.data(),metadata:s.metadata}),err),
    }),
    collection:(p)=>({
      onSnapshot:(next,err)=>onSnapshot(collection(fs,p),s=>next({docs:s.docs.map(d=>({id:d.id,data:()=>d.data()})),metadata:s.metadata}),err),
    }),
  };
}

const nfl={};
let lastFullLoad=0;
function applySchedule(){
  const regular={};for(let w=1;w<=18;w++)if(nfl[w])regular[w]=nfl[w];
  S.weeks=groupIntoPickWeeks(regular);
  for(const [w,r] of Object.entries(ROUNDS))S.weeks[w]={week:+w,games:(nfl[100+r.espn]||[]).slice().sort((x,y)=>x.t.localeCompare(y.t)||x.id.localeCompare(y.id))};
  rememberAllLines();syncLines();S.ready=true;S.updatedAt=new Date();S.scoreError=false;
  if(!S.week)S.week=currentWeek();
  render();maybeAutoLock();
  if(boxOpenId)renderBox();
}
// nfl keys: 1-18 regular season weeks, 101/102/103/105 ESPN playoff rounds
const PLAYOFF_KEYS=[101,102,103,105];
function fetchNfl(k){return k>100?fetchWeek(k-100,3):fetchWeek(k)}
async function loadAllWeeks(){
  const keys=[...Array.from({length:18},(_,i)=>i+1),...PLAYOFF_KEYS];
  const all=await Promise.all(keys.map(k=>fetchNfl(k).catch(e=>{if(k>100)return nfl[k]||[];throw e})));
  all.forEach((games,i)=>nfl[keys[i]]=games);
  lastFullLoad=Date.now();
}
// NFL weeks with a game about to start, live, or recently kicked off without a final
function activeNflWeeks(){
  const now=Date.now(),out=[];
  for(const [w,games] of Object.entries(nfl)){
    if(games.some(g=>{const t=new Date(g.t).getTime();return !g.w&&!g.tbd&&now>=t-10*60e3&&now<=t+6*3600e3}))out.push(+w);
  }
  return out;
}
/* ---- score alerts ---- */
let lastSeen=null,lastDetectAt=0;
// A refresh this long after the previous one is a catch-up (page was closed, hidden or offline): update quietly
const STALE_MS=75e3,ALERT_TTL=45e3;
S.flash={};
function flashing(g,side){const f=S.flash[g.id];return !!f&&f.until>Date.now()&&(!side||f[side])}
function alertsOn(){return store.get('alerts')!=='off'}
function pickWeekOf(id){for(const [w,wk] of Object.entries(S.weeks))if(wk.games.some(g=>g.id===id))return +w;return null}
function scoreKind(pts){return pts>=6&&pts<=8?'Touchdown':pts===3?'Field goal':pts===2?'Two points':pts===1?'Extra point':'Score'}
function nameList(list){return list.map(p=>`<b style="color:inherit">${esc(p.name)}</b>`).join(', ')}

function detectEvents(){
  const now=new Map();
  for(const games of Object.values(nfl))for(const g of games)now.set(g.id,g);
  const before=lastSeen;lastSeen=new Map([...now].map(([id,g])=>[id,{as:g.as,hs:g.hs,st:g.st,w:g.w}]));
  const gap=Date.now()-lastDetectAt;lastDetectAt=Date.now();
  if(!before||gap>STALE_MS)return;
  const shown=currentWeek(),events=[];
  for(const g of now.values()){
    const b=before.get(g.id);if(!b||pickWeekOf(g.id)!==shown)continue;
    const da=g.as-b.as,dh=g.hs-b.hs;
    if(da>0||dh>0)S.flash[g.id]={a:da>0,h:dh>0,until:Date.now()+3000};
    if(b.st==='pre'&&g.st==='in')events.push({kind:'kickoff',g});
    if(da>0)events.push({kind:'score',g,side:'a',pts:da});
    if(dh>0)events.push({kind:'score',g,side:'h',pts:dh});
    if(!b.w&&g.w){
      events.push({kind:'final',g});
      const sc=weekScore(shown);
      if(sc.complete&&sc.winner&&sc.last&&sc.last.id===g.id)events.push({kind:'week',w:shown,sc});
    }
  }
  if(events.length)setTimeout(()=>render(),3100);
  if(document.hidden){events.forEach(systemNotify);return}
  events.forEach(queueAlert);
}

const alertQueue=[];let alertShowing=false,alertTimer=null;
// One nudge per person per week, so nobody loses a tie by never noticing the second guess
const nudged=new Set();
function nudgeSecondGuess(){
  const w=S.week;if(!S.ready||!tb2Open(w))return;
  const me=player(S.me);if(!me)return;
  const key=w+':'+me.id;if(nudged.has(key))return;
  if(typeof pickDoc(w,me.id).tb2==='number')return;
  nudged.add(key);
  queueAlert({kind:'tb2',who:me,g:mondayGame(w)});
}
function queueAlert(ev){
  if(!alertsOn())return;
  ev.at=Date.now();
  // Newer news about a game replaces anything about it still waiting
  if(ev.g)for(let i=alertQueue.length-1;i>=0;i--)if(alertQueue[i].g&&alertQueue[i].g.id===ev.g.id&&alertQueue[i].kind!=='final')alertQueue.splice(i,1);
  alertQueue.push(ev);
  if(alertQueue.length>3)alertQueue.splice(0,alertQueue.length-3);
  if(!alertShowing)nextAlert();
}
function alertView(ev){
  if(ev.kind==='badge'){
    const t=TIER[ev.badge.tier]||TIER.common;
    return {tc:t.color,tc2:'rgba(0,0,0,.25)',tx:'#fff',title:ev.badge.name,meta:t.label+' badge',
      score:`<span>${esc(ev.who.name)}</span>`,people:`<span>${esc(ev.badge.desc)}</span>`,
      plain:`${ev.who.name} unlocked ${ev.badge.name} (${t.label})`};
  }
  if(ev.kind==='tb2'){
    const g=ev.g;
    return {tc:'#FF6A2B',tc2:'rgba(0,0,0,.25)',tx:'#fff',title:'Monday night tiebreaker',
      meta:`${g.a.ab} @ ${g.h.ab} · ${fmtTime.format(new Date(g.t))}`,
      score:`<span>${esc(ev.who.name)}</span>`,
      people:'<span>Open the Monday game and guess the total points</span>',
      plain:`${ev.who.name}: enter your Monday night tiebreaker guess`};
  }
  if(ev.kind==='week'){
    const r=ev.sc.winner;
    return {tc:r.p.color,tc2:'rgba(0,0,0,.25)',tx:'#fff',title:`${weekName(ev.w)} winner`,meta:'+3 points',
      score:`<span>${esc(r.p.name)}</span>`,people:ev.sc.rows.slice(0,3).map(x=>`<span>${PLACE_LABEL[x.place-1]} <b>${esc(x.p.name)}</b> +${x.pts}</span>`).join(''),
      plain:`${r.p.name} wins ${weekName(ev.w)} with ${r.right} correct`};
  }
  const g=ev.g,w=pickWeekOf(g.id);
  const team=ev.kind==='score'?g[ev.side]:ev.kind==='final'&&g.w&&g.w!=='TIE'?(g.w===g.a.ab?g.a:g.h):g.h;
  const title=ev.kind==='score'?`${scoreKind(ev.pts)} ${team.name}`:ev.kind==='final'?(g.w==='TIE'?'Final · tie':`Final · ${team.name} win`):'Kickoff';
  const meta=ev.kind==='final'?`${g.a.ab} @ ${g.h.ab}`:(g.d||`${g.a.ab} @ ${g.h.ab}`);
  const picks=players().map(p=>({p,st:pickState(g,picksFor(w,p.id)[g.id])}));
  const groups=ev.kind==='final'?[['Right','ok'],['Wrong','no']]:[['Winning','up'],['Losing','down'],['Tied','even']];
  const people=groups.map(([label,st])=>{const list=picks.filter(x=>x.st===st).map(x=>x.p);return list.length?`<span>${label}: ${nameList(list)}</span>`:''}).join('');
  return {tc:team.c,tc2:team.c2,tx:textOn(team.c),title,meta,game:g.id,logo:ev.kind==='kickoff'?'':team.logo,
    score:`<span class="${g.as<g.hs?'lo':''}">${esc(g.a.ab)} ${g.as}</span><span class="lo">–</span><span class="${g.hs<g.as?'lo':''}">${g.hs} ${esc(g.h.ab)}</span>`,
    people,plain:`${title}: ${g.a.ab} ${g.as}, ${g.h.ab} ${g.hs}`};
}
function nextAlert(){
  clearTimeout(alertTimer);
  const el=$('#alert');
  let ev=alertQueue.shift();
  while(ev&&Date.now()-(ev.at||0)>ALERT_TTL)ev=alertQueue.shift();
  if(!ev){alertShowing=false;el.hidden=true;return}
  alertShowing=true;
  const v=alertView(ev);
  el.style.setProperty('--tc',v.tc);el.style.setProperty('--tc2',v.tc2);el.style.setProperty('--tx',v.tx);
  el.dataset.game=v.game||'';
  el.innerHTML=`<div class="al-head">${v.logo?`<img class="al-logo" src="${esc(v.logo)}" alt="">`:''}<span class="al-kind">${esc(v.title)}</span><span class="al-meta">${esc(v.meta)}</span><button type="button" class="al-close" data-alert-close aria-label="Dismiss alerts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="al-score num">${v.score}</div>${v.people?`<div class="al-people">${v.people}</div>`:''}`;
  el.hidden=false;el.classList.remove('in');void el.offsetWidth;el.classList.add('in');
  alertTimer=setTimeout(nextAlert,6000);
}
function systemNotify(ev){
  try{
    if(!document.hidden||!('Notification' in window)||Notification.permission!=='granted')return;
    const v=alertView(ev);
    new Notification('Sunday Picks',{body:v.plain,tag:v.game||('week'+ev.w)});
  }catch{}
}
// A badge that wasn't there last time this device looked is worth announcing
function badgeUnlocks(){
  if(!S.picksLoaded)return;
  const stats=seasonStats();
  for(const p of players()){
    const o=stats[p.id],key='badges:'+p.id;
    const earned=BADGES.filter(b=>b.count(o)).map(b=>b.name);
    let seen=null;
    try{seen=JSON.parse(store.get(key)||'null')}catch{}
    store.set(key,JSON.stringify(earned));
    if(!Array.isArray(seen))continue;                    // first look on this device: just remember
    for(const name of earned){
      if(seen.includes(name))continue;
      const badge=BADGES.find(b=>b.name===name);
      if(!badge)continue;
      if(tierRank(badge)>=3&&alertsOn())celebrate(badge,p);
      else queueAlert({kind:'badge',badge,who:p});
    }
  }
}
// Legendary and mythic get the whole screen; everything else gets the banner
const bigQueue=[];let bigShowing=false,bigTimer=null;
function celebrate(badge,who){
  bigQueue.push({badge,who});
  if(!bigShowing)nextCelebration();
}
function nextCelebration(){
  clearTimeout(bigTimer);
  const el=$('#unlock'),item=bigQueue.shift();
  if(!item){bigShowing=false;el.hidden=true;el.innerHTML='';el.classList.remove('in');return}
  bigShowing=true;
  const t=TIER[item.badge.tier]||TIER.common;
  el.style.setProperty('--bc',t.color);
  el.innerHTML=`<div class="unlock-in"><span class="rays" aria-hidden="true"></span>${badgeIcon(item.badge)}<p class="unlock-tier">${esc(t.label)} unlocked</p><h2>${esc(item.badge.name)}</h2><p class="unlock-desc">${esc(item.badge.desc)}</p><p class="unlock-who">${esc(item.who.name)}</p><button type="button" class="toggle" data-unlock-close>Nice</button></div>`;
  el.hidden=false;el.classList.remove('in');void el.offsetWidth;el.classList.add('in');
  if(!calm())navigator.vibrate?.([14,60,14]);
  bigTimer=setTimeout(nextCelebration,7500);
}
function sampleAlert(){
  const w=S.week||currentWeek(),gs=weekGames(w);
  const g=gs.find(x=>x.st==='in')||gs.find(x=>x.w&&x.w!=='TIE')||gs[0];
  if(!g){toast('No games to show yet.');return}
  const side=g.as>=g.hs?'a':'h';
  const was=alertsOn();store.set('alerts','on');
  queueAlert({kind:'score',g,side,pts:7});
  if(g.w&&g.w!=='TIE')queueAlert({kind:'final',g});
  if(!was)store.set('alerts','off');
}

async function refreshLiveProbs(){
  const now=Date.now(),live=[];
  for(const games of Object.values(nfl))for(const g of games)if(g.st==='in'&&g.liveProb==null)live.push(g);
  await Promise.all(live.filter(g=>!S.liveProb[g.id]||now-S.liveProb[g.id].at>120e3).map(async g=>{
    try{const p=await fetchWinProb(g.id);if(p!=null)S.liveProb[g.id]={p,at:now}}catch{}
  }));
}
function rememberAllLines(){
  let changed=false;
  for(const games of Object.values(nfl))for(const g of games)changed=rememberLine(g)||changed;
  if(changed)store.set('spreads',JSON.stringify(spreads));
}

/* ---- box score sheet ---- */
const boxCache=new Map();
let boxOpenId=null,boxTimer=null;
function gameById(id){for(const games of Object.values(nfl))for(const g of games)if(g.id===id)return g;return null}
const boxDrives=new Map();
let boxTab='live';
function openBox(id){
  if(!gameById(id))return;
  boxOpenId=id;boxTab='live';renderBox();
  const dlg=$('#boxDlg');if(!dlg.open)dlg.showModal();
  $('#boxBody').scrollTop=0;
  loadBox(id,false);
}
function closeBox(){boxOpenId=null;clearTimeout(boxTimer);const dlg=$('#boxDlg');if(dlg.open)dlg.close()}
async function loadBox(id,force){
  if(!id)return;
  clearTimeout(boxTimer);
  const cached=boxCache.get(id);
  if(force||!cached||Date.now()-cached.at>30e3){
    if(force&&cached)boxCache.set(id,{...cached,err:false});
    try{
      const data=await fetchGameSummary(id);
      boxCache.set(id,{data,at:Date.now(),err:false});
      const g=gameById(id);
      if(g&&g.st==='in'&&data.homeWinProb!=null)S.liveProb[id]={p:data.homeWinProb,at:Date.now()};
    }catch{boxCache.set(id,{data:cached?cached.data:null,at:Date.now(),err:true})}
  }
  if(boxOpenId!==id)return;
  renderBox();
  const g=gameById(id);
  if(g&&g.st==='in')boxTimer=setTimeout(()=>loadBox(id,true),30e3);
}
function boxTeam(g,side,w,lk){
  const t=g[side];
  const who=lk?players().filter(p=>picksFor(w,p.id)[g.id]===t.ab):[];
  return `<div class="bx-team"><span class="logo" style="--tc:${esc(t.c)}">${t.logo?`<img src="${esc(t.logo)}" alt="" width="42" height="42">`:`<span class="ab">${esc(t.ab)}</span>`}</span><b>${esc(t.name)}</b><small class="num">${esc(t.rec||t.loc)}</small><div class="pips">${who.map(p=>`<span class="pip ${pickState(g,t.ab)} av-${p.id}" style="--c:${esc(p.color)}" title="${esc(p.name)}" aria-label="${esc(p.name)}">${initial(p)}</span>`).join('')}</div></div>`;
}
// Team colour darkened toward black, as a plain rgb() string: some phones ignore a
// color-mix() background on these blocks, and an empty end zone reads as a bug.
function shade(hex,k){
  const h=String(hex||'').replace('#','');
  if(h.length!==6)return '#555555';
  const c=(i)=>Math.round(parseInt(h.substr(i,2),16)*k);
  return `rgb(${c(0)},${c(2)},${c(4)})`;
}
// A very dark team colour (Packers green, Jets green, Ravens purple) disappears against the
// turf, so lift it toward white before it is used for the arrow.
function lift(hex){
  const h=String(hex||'').replace('#','');
  if(h.length!==6)return '#9aa3b0';
  const p=[0,2,4].map((i)=>parseInt(h.substr(i,2),16));
  const luma=(.2126*p[0]+.7152*p[1]+.0722*p[2])/255;
  if(luma>=.22)return `rgb(${p.join(',')})`;
  const k=.4;
  return `rgb(${p.map((c)=>Math.round(c+(255-c)*k)).join(',')})`;
}
// Live field: away defends the left end zone, home the right, matching the score above.
// g.sit.yl counts up from the home goal line, so the ball sits at 100 - yl from the left
// and the shaded band runs from the ball to the line to gain, which shows the drive's way.
function fieldView(g){
  const s=g.sit;
  if(!s||!s.pos||s.yl==null)return '';
  const t=g[s.pos],x=100-s.yl;
  const fdYl=s.dist==null?null:s.pos==='h'?s.yl+s.dist:s.yl-s.dist;
  const fdX=fdYl==null?null:100-Math.min(100,Math.max(0,fdYl));
  const tos=(sd)=>{const n=s.to[sd];return n==null?'':`<span>${esc(g[sd].ab)}<i class="${n>0?'on':''}"></i><i class="${n>1?'on':''}"></i><i class="${n>2?'on':''}"></i></span>`};
  const vars=[`--ball:${x}%`,`--tc:${esc(t.c)}`];
  if(fdX!=null)vars.push(`--togo-x:${Math.min(x,fdX)}%`,`--togo-w:${Math.abs(x-fdX)}%`);
  // no line to gain on goal to go: the band already runs to the goal line
  const fd=fdYl!=null&&fdYl>0&&fdYl<100?`<i class="bx-fd" style="--fd:${fdX}%"></i>`:'';
  const alt=`${t.name} ball${s.spot?` at ${s.spot}`:''}, moving toward the ${s.pos==='h'?'left':'right'} end zone`;
  return `<section class="bx-sec bx-drive">
    <div class="bx-poss">${t.logo?`<img src="${esc(t.logo)}" alt="" width="20" height="20">`:''}<b>${esc(t.ab)} ball</b><span class="dd">${esc(s.dd||s.spot)}</span>${s.rz?'<span class="rzflag">RED ZONE</span>':''}</div>
    <div class="bx-field" role="img" aria-label="${esc(alt)}"><span class="bx-ez" style="background:${esc(shade(g.a.c,.95))}"></span><div class="bx-turf" style="${vars.join(';')}"><i class="bx-yards"></i>${fdX==null?'':'<i class="bx-togo"></i>'}${fd}<i class="bx-los"></i><svg class="bx-mark" viewBox="0 0 19 15" aria-hidden="true"><path d="${s.pos==='h'?'M17 1.5L2.5 7.5 17 13.5Z':'M2 1.5L16.5 7.5 2 13.5Z'}" fill="${esc(lift(t.c))}"/></svg></div><span class="bx-ez" style="background:${esc(shade(g.h.c,.95))}"></span></div>
    <div class="bx-to">${tos('a')}${tos('h')}</div>
  </section>`;
}
function statBetter(key,a,b){if(key==='turnovers'||key==='totalPenaltiesYards')return a<b;return a>b}
function renderBox(){
  const g=gameById(boxOpenId);if(!g)return;
  const w=pickWeekOf(g.id)||S.week,lk=locked(g,w),cached=boxCache.get(g.id),d=cached&&cached.data;
  const started=g.st!=='pre'||!!g.w;
  const status=g.w?(g.w==='TIE'?'Final · Tie':'Final'):g.st==='in'?(g.d||'Live'):g.tbd?'Time TBD':`${fmtDay.format(new Date(g.t))} · ${fmtTime.format(new Date(g.t))}`;
  let h=`<div class="bx-hero" style="--ca:${esc(g.a.c)};--ch:${esc(g.h.c)}"><div class="bx-score">${boxTeam(g,'a',w,lk)}<div class="bx-mid">${started?`<div class="bx-nums num"><span class="${g.as<g.hs?'lo':''}">${g.as}</span><span class="dash">–</span><span class="${g.hs<g.as?'lo':''}">${g.hs}</span></div>`:'<div class="bx-at">@</div>'}<div class="st ${g.w?'final':g.st==='in'?'live':''}">${esc(status)}</div></div>${boxTeam(g,'h',w,lk)}</div></div>`;
  if(g.st==='in'&&boxTab==='live')h+=fieldView(g);
  if(!started){
    const facts=[lk?spreadText(g):'',d&&d.venue].filter(Boolean);
    h+=`<section class="bx-sec"><div class="bx-facts">${facts.map(f=>`<span>${esc(f)}</span>`).join('')}</div><p class="muted">The box score fills in once the game kicks off.</p></section>`;
  }else if(!d){
    h+=cached&&cached.err?'<p class="bx-msg">The box score isn’t available right now. <button type="button" class="linkbtn" data-box-retry>Try again</button></p>':'<p class="bx-msg">Loading box score…</p>';
  }else{
    const liveNow=g.st==='in';
    h+=`<nav class="bx-tabs" role="tablist" aria-label="Game sheet">${[['live',liveNow?'Live':'Box score'],['scoring','Scoring'],['plays','Plays']].map(([k,label])=>`<button type="button" role="tab" class="${liveNow&&k==='live'?'live':''}" data-boxtab="${k}" aria-selected="${boxTab===k}">${esc(label)}</button>`).join('')}</nav>`;
    const n=Math.max(4,d.lines.a.length,d.lines.h.length);
    const qs=Array.from({length:n},(_,i)=>i<4?String(i+1):n===5?'OT':'OT'+(i-3));
    if(boxTab==='live')h+=`<section class="bx-sec"><table class="bx-lines num"><thead><tr><th></th>${qs.map(q=>`<th>${q}</th>`).join('')}<th>T</th></tr></thead><tbody>${['a','h'].map(sd=>`<tr><td>${esc(g[sd].ab)}</td>${qs.map((q,i)=>`<td>${esc(d.lines[sd][i]??'')}</td>`).join('')}<td class="tot">${sd==='a'?g.as:g.hs}</td></tr>`).join('')}</tbody></table></section>`;
    if(boxTab==='scoring'){
      if(!d.plays.length)h+='<p class="bx-msg">Nobody has scored yet.</p>';
      else h+=`<section class="bx-sec"><h4>Scoring</h4><ol class="bx-plays">${d.plays.map(pl=>{
        const t=pl.team===g.a.ab?g.a:pl.team===g.h.ab?g.h:null;
        return `<li><span class="bx-q">${pl.q>4?'OT':'Q'+pl.q} · ${esc(pl.clock)}</span><span class="bx-type" style="--tc:${esc(t?t.c:'#555555')}">${esc(pl.type||'•')}</span><span class="bx-text">${t&&t.logo?`<img src="${esc(t.logo)}" alt="" width="18" height="18">`:''}<span>${esc(pl.text)}</span></span><span class="bx-run num">${pl.as}–${pl.hs}</span></li>`;
      }).join('')}</ol></section>`;
    }
    if(boxTab==='plays'){
      if(!d.drives||!d.drives.length)h+='<p class="bx-msg">No plays yet.</p>';
      else{
      const live=g.st==='in';
      h+=`<section class="bx-sec"><h4>Play by play</h4><div class="bx-drives">${d.drives.slice().reverse().map((dr,i)=>{
        const t=dr.team===g.a.ab?g.a:dr.team===g.h.ab?g.h:null,key=g.id+':'+dr.id;
        // the drive in progress opens itself; after that it is whatever the reader last did
        const open=boxDrives.has(key)?boxDrives.get(key):(live&&i===0);
        return `<details class="bx-dr${dr.scored?' scored':''}" data-dr="${esc(key)}" style="--tc:${esc(t?t.c:'#555555')}"${open?' open':''}><summary>${t&&t.logo?`<img src="${esc(t.logo)}" alt="">`:''}<span class="bx-dr-r">${esc(dr.result||'Drive')}</span><small>${esc(dr.desc||dr.start)}</small></summary><ol class="bx-pbp">${dr.plays.slice().reverse().map(pl=>`<li class="${esc(pl.flag)}"><span class="bx-pclock">${esc((pl.q>4?'OT':'Q'+pl.q)+' '+pl.clock)}</span><span class="bx-ptxt">${pl.dd?`<i>${esc(pl.dd)}</i>`:''}${esc(pl.text)}</span>${pl.score?`<span class="bx-run num">${pl.score.a}–${pl.score.h}</span>`:''}</li>`).join('')}</ol></details>`;
      }).join('')}</div></section>`;
      }
    }
    if(boxTab==='live'&&d.stats.length){
      h+=`<section class="bx-sec"><h4>Team stats</h4><div class="bx-cols"><span>${esc(g.a.ab)}</span><span></span><span>${esc(g.h.ab)}</span></div>${d.stats.map(st=>{
        const na=parseFloat(st.a),nh=parseFloat(st.h),num=Number.isFinite(na)&&Number.isFinite(nh)&&!/Eff$|possession|Penalties/.test(st.key);
        const bar=num&&na+nh>0&&st.key!=='turnovers';
        return `<div class="bx-stat"><b class="num${num&&statBetter(st.key,na,nh)?' hi':''}">${esc(st.a)}</b><span>${esc(st.label)}</span><b class="num${num&&statBetter(st.key,nh,na)?' hi':''}">${esc(st.h)}</b>${bar?`<div class="bx-statbar" style="--pa:${Math.round(na/(na+nh)*100)}%;--ca:${esc(g.a.c)};--ch:${esc(g.h.c)}"></div>`:''}</div>`;
      }).join('')}</section>`;
    }
    if(boxTab==='live'&&d.leaders.length){
      const who=(x)=>x?`<b>${esc(x.who)}</b><small>${esc(x.v)}</small>`:'<small>–</small>';
      h+=`<section class="bx-sec"><h4>Leaders</h4>${d.leaders.map(l=>`<div class="bx-leader"><div>${who(l.a)}</div><span>${esc(l.label)}</span><div class="r">${who(l.h)}</div></div>`).join('')}</section>`;
    }
    if(boxTab==='live'&&d.venue)h+=`<p class="bx-venue">${esc(d.venue)}</p>`;
  }
  $('#boxTitle').textContent=`${g.a.name} at ${g.h.name}`;
  // a live game redraws every 30s, which must not throw the reader back to the top
  const body=$('#boxBody'),keep=body.scrollTop;
  body.innerHTML=h;
  body.scrollTop=keep;
  body.querySelectorAll('details[data-dr]').forEach(el=>el.addEventListener('toggle',()=>boxDrives.set(el.dataset.dr,el.open)));
}

let pollTimer=null;
async function refresh(){
  clearTimeout(pollTimer);
  const active=activeNflWeeks();
  try{
    if(!lastFullLoad||Date.now()-lastFullLoad>30*60e3)await loadAllWeeks();
    else for(const w of active)nfl[w]=await fetchNfl(w);
    await refreshLiveProbs();
    applySchedule();
    detectEvents();
  }catch(e){S.ready=true;S.scoreError=true;render()}
  pollTimer=setTimeout(refresh,activeNflWeeks().length?30e3:10*60e3);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&S.updatedAt&&Date.now()-S.updatedAt>60e3)refresh()});

// A television shouldn't fall asleep mid-drive, and a mouse pointer has no business
// parked on the living room screen. Neither is essential, so both fail quietly.
if(S.tv){
  let lock=null;
  const keepAwake=async()=>{try{lock=await navigator.wakeLock.request('screen')}catch{}};
  keepAwake();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&(!lock||lock.released))keepAwake()});
  let idle;
  const stir=()=>{document.documentElement.classList.remove('nocursor');clearTimeout(idle);idle=setTimeout(()=>document.documentElement.classList.add('nocursor'),4000)};
  ['mousemove','mousedown','keydown','touchstart'].forEach(ev=>document.addEventListener(ev,stir,{passive:true}));
  stir();
}

render();
if(!firebaseConfig||!firebaseConfig.projectId||firebaseConfig.projectId.startsWith('YOUR')){
  S.offline=true;render();
}else{
  const app=initializeApp(firebaseConfig);
  S.auth=getAuth(app);
  onAuthStateChanged(S.auth,(user)=>{S.parent=!!user;render()});
  const db=makeDb(getFirestore(app));
  S.db=db;
  db.doc('config/family').onSnapshot(s=>{if(s.exists){S.family=s.data();render()}},()=>{});
  db.collection('profiles').onSnapshot(s=>{
    const next={};s.docs.forEach(d=>next[d.id]=d.data());S.profiles=next;applyAvatarCss();render();renderProfile();
  },()=>{});
  db.collection('lines').onSnapshot(s=>{
    const next={};s.docs.forEach(d=>next[d.id]=d.data());S.lines=next;
    if(!s.metadata.fromCache&&!S.linesLoaded){S.linesLoaded=true;syncLines()}
    render();
  },()=>{});
  db.collection('locks').onSnapshot(s=>{
    const next={};s.docs.forEach(d=>next[d.id]=d.data());S.locks=next;
    if(!s.metadata.fromCache)S.locksLoaded=true;render();maybeAutoLock();
  },()=>{});
  db.collection('picks').onSnapshot(s=>{
    const next={};s.docs.forEach(d=>next[d.id]=d.data());S.picks=next;
    if(!s.metadata.fromCache)S.picksLoaded=true;render();maybeAutoLock();badgeUnlocks();
  },()=>toast('Live updates stopped. Reload the page to see new picks.'));
  refresh();
}
// Local testing only: lets a preview inspect state without touching the family's data
if(location.hostname==='localhost')window.__sp={S,sparks,nfl,BADGE,celebrate,player,render,weekScore,seasonStats,recapCard,makeAvatar,hashPin,openProfile,openPin,applyAvatarCss,isUnlocked,openBox,renderBox,loadBox};
