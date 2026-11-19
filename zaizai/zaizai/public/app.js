const $ = selector => document.querySelector(selector);
const app = $('#app');
const dialog = $('#modal');
const PALETTE = ['#c4f582', '#94c5ff', '#ffb78d', '#d2b6ff', '#ffabc6', '#87d9d2', '#e7d78f', '#b6baff'];
const FALLBACK_MOVES = {
  charge: {name:'仔',icon:'✦',description:'积蓄力量，获得 1 个仔。',cost:{},color:'mint'},
  guard: {name:'防',icon:'◇',description:'抵挡枪与火球的攻击，并获得 1 个防。',cost:{},color:'blue'},
  hammer: {name:'锤',icon:'⚒',description:'获得锤，克制防御。',cost:{},color:'amber'},
};
let moves = FALLBACK_MOVES;
let reflectable = [];
let resourceNames = {energy:'仔',hammers:'锤',shields:'圣盾',guards:'防'};
let token = sessionStorage.getItem('zaizai-token');
let self = null;
let state = {rooms:[],room:null};
let events;
let timeOffset = 0;
let lastRound = '';
let toastTimer;
let audioContext;
let inviteHandled = false;
let rulesReady;
let pollingStateKey;
let deferredRender = false;
let renderedSelection = null;
const ui = {move:null,target:null,reflect:'gun',interruptTarget:null,busy:false,search:'',filter:'all',sound:localStorage.getItem('zaizai-sound')==='true',statusOpen:{}};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, size = 20) => {
  const paths = {
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>', plus:'<path d="M12 5v14M5 12h14"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    check:'<path d="m5 12 4 4L19 6"/>', lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    exit:'<path d="M9 5H5v14h4m6-14 7 7-7 7m-6-7h13"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sound:'<path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    mute:'<path d="m11 5-6 4H2v6h3l6 4V5Zm5 4 6 6m0-6-6 6"/>',
    crown:'<path d="m2 7 5 4 5-7 5 7 5-4-3 12H5L2 7Zm3 15h14"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.arrow}</svg>`;
};
function avatar(index = 0, variant = 'normal') {
  const color = PALETTE[index % PALETTE.length];
  const eyes = variant==='dead' ? '<path d="m30 36 7 7m0-7-7 7m23-7 7 7m0-7-7 7" stroke="#17201a" stroke-width="3" stroke-linecap="round"/>' : '<ellipse cx="34" cy="39" rx="3" ry="4" fill="#17201a"/><ellipse cx="56" cy="39" rx="3" ry="4" fill="#17201a"/><path d="M40 49q5 5 10 0" fill="none" stroke="#17201a" stroke-width="2.5" stroke-linecap="round"/>';
  const ears = index%3===0 ? '<path d="M24 24 20 8q12-3 19 14M52 22Q62 3 70 10l-4 20" fill="currentColor"/>' : index%3===1 ? '<path d="m23 25 2-18 16 13m13 0L69 8l-2 21" fill="currentColor"/>' : '<ellipse cx="26" cy="21" rx="12" ry="12" fill="currentColor"/><ellipse cx="64" cy="21" rx="12" ry="12" fill="currentColor"/>';
  return `<svg viewBox="0 0 90 80" class="creature" style="color:${color}" aria-hidden="true">${ears}<path d="M13 48c0-24 14-32 32-32s32 8 32 32c0 20-14 24-32 24S13 68 13 48Z" fill="currentColor"/><ellipse cx="24" cy="48" rx="5" ry="3" fill="#fff" opacity=".27"/><ellipse cx="66" cy="48" rx="5" ry="3" fill="#fff" opacity=".27"/>${eyes}</svg>`;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3500);
}
async function api(route, body) {
  const res = await fetch(`/api${route}`, {method:body===undefined?'GET':'POST', headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await res.json();
  if (!res.ok) {
    if(res.status===401) { token=null; sessionStorage.removeItem('zaizai-token'); events?.close(); self=null; render(); }
    throw new Error(data.error || '连接失败，请重试。');
  }
  return data;
}
async function command(route, body={}) {
  if(ui.busy) return;
  ui.busy=true; render();
  try { await api(route,body); acceptState(await api('/state')); } catch(e){toast(e.message);} finally {ui.busy=false;render();}
}
function sound(type='tick') {
  if(!ui.sound) return;
  try {
    audioContext ||= new (window.AudioContext||window.webkitAudioContext)();
    audioContext.resume();
    const osc=audioContext.createOscillator(), gain=audioContext.createGain();
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.frequency.setValueAtTime(type==='damage'?180:type==='win'?660:440,audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(type==='damage'?65:880,audioContext.currentTime+.18);
    gain.gain.setValueAtTime(.065,audioContext.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audioContext.currentTime+.25);
    osc.start();osc.stop(audioContext.currentTime+.25);
  }catch{}
}
function acceptState(next) {
  const key=next.room?`${next.room.id}:${next.room.round}:${next.room.phase}`:'';
  const previous=state.room;
  if(key!==lastRound) {
    if(next.room?.phase==='selecting') {ui.move=null;ui.target=null;ui.interruptTarget=null;sound();}
    if(next.room?.phase==='reveal') sound(next.room.result?.hasDamage?'damage':'tick');
    if(next.room?.phase==='finished'&&next.room.result?.winnerId===self?.id) sound('win');
    if(next.room?.phase==='interrupt') {ui.interruptTarget=null;toast('全场已亮招！流星锤玩家现在可以选择封锁目标。');}
    if(previous?.id!==next.room?.id) {ui.move=null;ui.target=null;}
    lastRound=key;
  }
  state=next;self=next.self;timeOffset=next.serverTime-Date.now();
  if(document.activeElement?.matches('select')&&!canPatchSelection())deferredRender=true;
  else {deferredRender=false;render();}
  maybeJoinInvite();
}
async function login(name) {
  const data=await api('/session',{name,token});
  token=data.token;self=data.self;moves=data.moves;reflectable=data.reflectable;resourceNames=data.resourceNames;
  sessionStorage.setItem('zaizai-token',token);
  const usePolling = location.hostname.endsWith('.trycloudflare.com');
  events?.close();
  acceptState(await api(usePolling?'/state?poll=1':'/state'));
  if (usePolling) {
    pollingStateKey=JSON.stringify({self:state.self,room:state.room,rooms:state.rooms});
    let closed=false, timer;
    const controller=new AbortController();
    events={close(){closed=true;clearTimeout(timer);controller.abort();}};
    const poll=async()=>{
      try {
        const response=await fetch('/api/state?poll=1',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]),cache:'no-store'});
        if(response.status===401){events.close();token=null;self=null;sessionStorage.removeItem('zaizai-token');render();return;}
        if(!response.ok)throw new Error('State request failed');
        const next=await response.json();
        if(!closed){
          timeOffset=next.serverTime-Date.now();
          const key=JSON.stringify({self:next.self,room:next.room,rooms:next.rooms});
          if(key!==pollingStateKey){pollingStateKey=key;acceptState(next);}
          setConnection(true);
        }
      } catch(error) {if(!closed)setConnection(false);}
      if(!closed)timer=setTimeout(poll,500);
    };
    poll();
    return;
  }
  events=new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener('state',event=>{try{acceptState(JSON.parse(event.data));}catch(e){console.error(e);}});
  events.onopen=()=>setConnection(true);
  events.onerror=()=>setConnection(false);
}
function setConnection(connected) {
  $('#connection').classList.toggle('offline',!connected);
  $('#connection span').textContent=connected?'已连接 · 实时同步':'连接中 · 自动重连';
}
function maybeJoinInvite() {
  if(inviteHandled||!self) return;
  const roomId=new URLSearchParams(location.search).get('room');
  inviteHandled=true;
  if(roomId&&!state.room) {history.replaceState({},'',location.pathname);command('/rooms/join',{roomId});}
}
function openModal(content, width='normal') {
  $('#modal-content').innerHTML=content;dialog.className=width;
  if(!dialog.open)dialog.showModal();
}
function modalHeader(eyebrow,title){return `<div class="modal-header"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><button class="icon-button" data-act="close-modal" aria-label="关闭弹窗">${icon('close')}</button></div>`;}
function costLabel(move) {
  const entries=Object.entries(move.cost);
  return entries.length?entries.map(([key,value])=>`${value} ${resourceNames[key]}`).join(' · '):'免费';
}
// Bold numbers inside rule descriptions, applied before esc() so entities stay intact.
const emphasized = value => esc(String(value??'').replace(/\d+/g,m=>'\x01'+m+'\x02')).replace(/\x01/g,'<b>').replace(/\x02/g,'</b>');
function disabled(value) {return value?'disabled':'';}

// Other players locking a move must not rebuild the arena or native controls.
function selectionKey(){
  const room=state.room;
  if(!self||room?.phase!=='selecting')return null;
  return JSON.stringify({self,room:{...room,submitted:null,ownAction:null},move:ui.move,target:ui.target,reflect:ui.reflect,sound:ui.sound,statusOpen:ui.statusOpen});
}
function canPatchSelection(){
  return renderedSelection!==null&&renderedSelection.key===selectionKey();
}
function validSelection(room,me){
  const move=moves[ui.move],target=room.players.find(p=>p.id===ui.target);
  return !!move&&ui.move!==me.bannedMove&&(!move.target||target?.hp>0)&&(!move.reflect||ui.reflect);
}
function patchSelection(){
  if(!canPatchSelection())return false;
  const room=state.room,me=room.players.find(p=>p.id===self.id);
  const submitted=new Set(room.submitted);
  for(const seat of app.querySelectorAll('.seat[data-id]')){
    const id=seat.dataset.id,player=room.players.find(p=>p.id===id);
    let bubble=seat.querySelector('.action-bubble.locked');
    if(submitted.has(id)&&!bubble){
      bubble=document.createElement('span');bubble.className='action-bubble locked';
      bubble.innerHTML=icon('lock',11)+' 已锁定';seat.prepend(bubble);
    }else if(!submitted.has(id)&&bubble)bubble.remove();
    const canTarget=me.hp>0&&!room.ownAction&&!!moves[ui.move]?.target&&id!==self.id&&player.hp>0;
    // Seats stay clickable at all times (status bar toggle); guard targeting via data-can-target.
    seat.dataset.canTarget=canTarget?'1':'0';
    seat.classList.toggle('targetable',canTarget);
    if(!canTarget)seat.querySelector('.target-check')?.remove();
  }
  const title=app.querySelector('.hud-timer-row h2');
  const heading=me.hp<=0?'正在观战':room.ownAction?'已锁定':'秘密选招';
  if(title.textContent!==heading)title.textContent=heading;
  const count=app.querySelector('.hud-timer-row p');
  const progress=room.players.filter(p=>p.hp>0&&submitted.has(p.id)).length+' / '+room.players.filter(p=>p.hp>0).length+' 已锁定';
  if(count.textContent!==progress)count.textContent=progress;
  const ownAction=JSON.stringify(room.ownAction);
  if(renderedSelection.ownAction!==ownAction){
    app.querySelector('.arena-controls').innerHTML=arsenal(room,me);
    const instruction=app.querySelector('.battle-instruction');
    instruction.textContent=room.ownAction||me.hp<=0?'序号逆时针排列 · 自己始终在最下方':room.players.filter(p=>p.hp>0).length===2?'选择招式 → 默认对手 → 锁定':'选择招式 → 点击目标 → 锁定';
    renderedSelection.ownAction=ownAction;
  }
  for(const button of app.querySelectorAll('.move-card')){
    if(button.disabled!==ui.busy)button.disabled=ui.busy;
  }
  const lock=app.querySelector('[data-act="submit-action"]');
  const lockDisabled=ui.busy||!validSelection(room,me);
  if(lock&&lock.disabled!==lockDisabled)lock.disabled=lockDisabled;
  tick();
  return true;
}
function render() {
  const focused=document.activeElement;
  const focusId=focused?.id;const selectionStart=focused?.selectionStart;const selectionEnd=focused?.selectionEnd;
  const preserved=[...app.querySelectorAll('[data-preserve]')].map(el=>[el.id,el.value]);
  if(state.room?.phase==='selecting'&&!state.room.ownAction&&meAlive(state.room)&&moves[ui.move]?.target){
    const alive=state.room.players.filter(p=>p.hp>0&&!p.left);
    if(alive.length===2)ui.target=alive.find(p=>p.id!==self.id).id;
  }
  if(state.room?.phase==='selecting'&&!state.room.ownAction){
    const me=state.room.players.find(p=>p.id===self.id),move=moves[ui.move];
    if(move&&(me.bannedMove===ui.move||!Object.entries(move.cost).every(([key,n])=>(me[key]??0)>=n))){ui.move=null;ui.target=null;}
  }
  if(patchSelection())return;
  document.body.classList.toggle('in-room',!!self&&!!state.room);
  app.innerHTML=!self?landing():state.room?arenaPage(state.room):lobby();
  const key=selectionKey();
  renderedSelection=key?{key,ownAction:JSON.stringify(state.room.ownAction)}:null;
  for(const [id,value] of preserved){const el=document.getElementById(id);if(el)el.value=value;}
  if(focusId&&document.getElementById(focusId)&&app.contains(document.getElementById(focusId))){
    const el=document.getElementById(focusId);el.focus({preventScroll:true});
    try{el.setSelectionRange(selectionStart,selectionEnd);}catch{}
  }
  $('#user-button').classList.toggle('hidden',!self);
  $('#user-button').innerHTML=self?`<span class="tiny-avatar">${avatar(0)}</span><span>${esc(self.name)}</span>`:'';
  document.title=state.room?`${state.room.name} · 仔仔竞技场`:'仔仔 · ZAIZAI ARENA';
  tick();
}

function landing(){
  return `<section class="welcome"><div class="welcome-copy"><div class="pill"><i class="live-dot"></i> 随时开一局，朋友即对手</div><h1>蓄一手。<br>等一个<span class="accent">好时机<span class="title-star">✳</span></span>。</h1><p class="welcome-description">看似简单的出招，意想不到的反击。<br>叫上朋友，在这一回合，猜透彼此。</p><form id="login-form" class="login-card"><label for="nickname">先给自己起个名字<span>无需注册，即刻开玩</span></label><div class="login-input-row"><span class="input-icon">${icon('users')}</span><input id="nickname" name="nickname" data-preserve placeholder="你的临时昵称" maxlength="12" required autocomplete="nickname" aria-label="临时昵称"></div><div class="login-actions"><button class="primary-button login-enter" type="submit">进入大厅 ${icon('arrow',18)}</button><button class="rules-highlight" type="button" data-act="rules"><span class="nav-icon">▤</span> 玩法手册</button></div><small>这个名字只会显示在对局中，刷新页面可继续连接。</small></form><div class="welcome-facts"><span>${icon('users',17)} 2–8 人同场</span><span>${icon('clock',17)} 同时出招</span><span>♧ 好友联机</span></div></div><div class="welcome-art"><div class="art-grid"></div><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><span class="art-coordinate">ARENA_001 / READY TO PLAY</span><span class="floating-tag tag-top">✦ 蓄力中…</span><div class="hero-mascot mascot-one">${avatar(0)}<span class="hero-name">仔仔 <i>READY</i></span></div><div class="hero-mascot mascot-two">${avatar(1)}<span class="hero-name">小蓝 <i>READY</i></span></div><div class="hero-mascot mascot-three">${avatar(2)}<span class="hero-name">橘子 <i>READY</i></span></div><div class="hero-burst">✹</div><span class="floating-tag tag-bottom">下一招，你猜？ ${icon('arrow',16)}</span><div class="art-caption"><span class="live-dot"></span> EVERY ROUND IS A MIND GAME.</div></div></section><section class="onboarding-strip"><div class="strip-heading"><span class="eyebrow">EASY TO PLAY. HARD TO PREDICT.</span><h2>三步，就入局。</h2></div><div><span class="step-number">01</span><h3>叫上你的搭子</h3><p>创建房间，分享链接，集合。</p></div><div><span class="step-number">02</span><h3>悄悄锁定招式</h3><p>蓄力、防御或攻击，同时亮招。</p></div><div><span class="step-number">03</span><h3>活到最后一刻</h3><p>见招拆招，成为最后的幸存者。</p></div></section>`;
}
function lobby(){
  const rooms=state.rooms.filter(r=>(ui.filter==='all'||['waiting','finished'].includes(r.phase))&&`${r.name} ${r.id} ${r.hostName}`.toLowerCase().includes(ui.search.toLowerCase()));
  const waiting=state.rooms.filter(r=>['waiting','finished'].includes(r.phase)&&r.count<r.capacity).length;
  return `<div class="page-heading"><div><span class="eyebrow">THE LOBBY</span><h1>游戏大厅<span class="heading-star">✳</span></h1><p>你好，${esc(self.name)}。找个房间，让这回合有点意思。</p></div><button class="primary-button" data-act="create">${icon('plus')} 创建房间</button></div><div class="lobby-layout"><section class="room-list-section"><div class="section-toolbar"><div class="tabs"><button data-act="filter" data-value="all" class="${ui.filter==='all'?'active':''}">全部房间 <span>${state.rooms.length}</span></button><button data-act="filter" data-value="waiting" class="${ui.filter==='waiting'?'active':''}">等待加入 <span>${waiting}</span></button></div><label class="search-box">${icon('search',17)}<input id="search" data-preserve placeholder="搜索房间 / 房间号" value="${esc(ui.search)}" aria-label="搜索房间"></label></div><div class="rooms-grid">${rooms.length?rooms.map(roomCard).join(''):`<div class="empty-state"><span class="empty-illustration">${avatar(0)}</span><h2>${ui.search?'没有找到这个房间':'第一间房，等你来开'}</h2><p>${ui.search?'试试其他名字，或使用房间号加入。':'这里还很安静。创建一个房间，叫朋友来热闹一下。'}</p><button class="secondary-button" data-act="create">${icon('plus',17)} 创建你的房间</button></div>`}</div><div class="lobby-note"><span class="live-dot"></span> 房间状态实时更新 · 所有玩家准备后自动开局</div></section><aside class="lobby-sidebar"><section class="panel quick-join"><span class="eyebrow">GOT AN INVITE?</span><h2>朋友在等你？</h2><p>输入 6 位房间号，直接集合。</p><form id="join-form"><input id="join-code" data-preserve placeholder="例如 A1B2C3" maxlength="6" required autocomplete="off" aria-label="房间号"><button class="secondary-button" type="submit">加入房间 ${icon('arrow',17)}</button></form></section><section class="panel how-to"><span class="eyebrow">A LITTLE HEAD START</span><h2>第一回合，怎么出？</h2><div class="tip-move"><b class="move-mini mint">✦</b><div><strong>仔 · 先蓄力</strong><p>获得 1 个仔，解锁更多招式。</p></div></div><div class="tip-move"><b class="move-mini blue">◇</b><div><strong>防 · 稳一手</strong><p>预判攻击，挡住枪和火球。</p></div></div><div class="tip-move"><b class="move-mini amber">⚒</b><div><strong>锤 · 破防专家</strong><p>敲击防御，还能积攒流星锤。</p></div></div><button class="text-button accent" data-act="rules">查看全部 14 种招式 ${icon('arrow',16)}</button></section><div class="sidebar-quote">“再来一局，这次我肯定猜到。”<span>—— 每一个仔仔玩家</span></div></aside></div>`;
}
function roomCard(room,index){
  const playing=['selecting','interrupt','reveal'].includes(room.phase), full=room.count>=room.capacity;
  return `<article class="room-card"><div class="room-card-top"><span class="room-symbol" style="--room-color:${PALETTE[index%8]}">${['✳','◈','✹','⬡'][index%4]}</span><span class="status-pill ${playing?'playing':full?'full':''}"><i></i>${playing?'对局中':full?'已满员':'等待加入'}</span></div><h2>${esc(room.name)}</h2><p class="room-owner">${esc(room.hostName)} 的主场 <span>#${room.id}</span></p><div class="room-card-bottom"><span>${icon('users',17)} <b>${room.count}</b> / ${room.capacity}</span><button class="join-button" data-act="join" data-id="${room.id}" ${disabled(playing||full||ui.busy)}>${playing?`第 ${room.round} 回合`:full?'房间已满':'加入房间'} ${icon('arrow',16)}</button></div></article>`;
}
function arenaPage(room){
  const me=room.players.find(p=>p.id===self.id);
  const inGame=['selecting','interrupt','reveal'].includes(room.phase);
  const alive=room.players.filter(p=>p.hp>0);
  const host=room.hostId===self.id;
  const phaseNames={waiting:'等待玩家',selecting:'秘密选招',interrupt:'流星锤封锁',reveal:'亮招 · 结算',finished:'本局结束'};
  return `<div class="game-room"><div class="game-layout"><section class="battle-panel"><div class="battle-toolbar"><div class="battle-toolbar-main"><span class="battle-round"><i class="live-dot"></i> ${inGame?'ROUND '+String(room.round).padStart(2,'0'):'THE ARENA'} <b>/</b> ${inGame?alive.length+' 人存活':room.players.filter(p=>!p.left).length+' / '+room.capacity+' 人'} <small>${phaseNames[room.phase]}</small></span><span class="battle-instruction">${room.phase==='selecting'&&!room.ownAction&&me.hp>0?(alive.length===2?'选择招式 → 默认对手 → 锁定':'选择招式 → 点击目标 → 锁定'):room.phase==='interrupt'&&room.ownAction?.move==='meteor'?'点击头像选择封锁目标（包括自己）':'序号逆时针排列 · 自己始终在最下方'}</span></div><div class="battle-room-tools"><span class="battle-room-name" title="${esc(room.name)}">${esc(room.name)}</span>${!inGame&&host?'<select id="capacity-select" aria-label="调整房间人数" '+disabled(ui.busy)+'>'+Array.from({length:7},(_,i)=>i+2).map(n=>'<option value="'+n+'" '+(n===room.capacity?'selected':'')+' '+disabled(n>0&&n<room.players.filter(p=>!p.left).length)+'>'+n+' 人</option>').join('')+'</select>':''}<button class="icon-button" data-act="sound" title="${ui.sound?'关闭':'开启'}音效" aria-label="${ui.sound?'关闭':'开启'}音效">${icon(ui.sound?'sound':'mute')}</button><button class="icon-button" data-act="invite" title="邀请朋友" aria-label="邀请朋友">${icon('copy')}</button><button class="icon-button" data-act="leave" title="退出房间" aria-label="退出房间">${icon('exit')}</button></div></div><div class="arena ${room.phase==='reveal'&&room.result?.hasDamage?'arena-damage':''}"><button class="arena-panel-button" data-act="show-leaderboard">${icon('trophy',15)} 排行榜</button><button class="history-button" data-act="show-history">${icon('clock',15)} 战况记录</button><div class="arena-circle circle-outer"></div><div class="arena-circle circle-inner"></div><div class="arena-cross horizontal"></div><div class="arena-cross vertical"></div><span class="arena-wordmark">ZAIZAI / ARENA</span>${renderSeats(room,inGame)}<div class="arena-hud">${renderCenter(room,me)}</div><div class="arena-controls">${inGame?arsenal(room,me):`<div class="center-welcome"><span class="center-symbol">✳</span><h2>${room.phase==='finished'?'好戏，还可以再来一场':'人齐了，就开场'}</h2><p>所有在房玩家准备后自动开局</p><button class="${me.ready?'secondary-button prepared':'primary-button'}" data-act="ready" ${disabled(ui.busy)}>${icon(me.ready?'check':'arrow',16)} ${me.ready?'已准备 · 点击取消':'我准备好了'}</button></div>`}</div></div><div class="battle-caption"><span>↶ 序号从小到大 · 逆时针环绕</span><span class="match-progress">第 ${room.gameNumber||1} 局 · ${inGame?'第 '+room.round+' 回合':'全员准备自动开局'}</span><div class="battle-caption-actions"><button class="text-button" data-act="rules">全部招式 ${icon('arrow',12)}</button></div></div></section></div></div>`;
}

function roomPage(room){
  const me=room.players.find(p=>p.id===self.id);
  const inGame=['selecting','interrupt','reveal'].includes(room.phase);
  const alive=room.players.filter(p=>p.hp>0);
  const phaseNames={waiting:'等待玩家',selecting:'秘密选招',interrupt:'流星锤封锁',reveal:'亮招 · 结算',finished:'本局结束'};
  return `<div class="game-room"><div class="room-heading"><div class="room-heading-left"><button class="icon-button back-button" data-act="leave" aria-label="返回大厅">${icon('exit')}</button><div><div class="room-breadcrumb">游戏大厅 ${icon('chevron',12)} <span>房间 #${room.id}</span></div><h1>${esc(room.name)} <span class="status-pill ${inGame?'playing':''}"><i></i>${phaseNames[room.phase]}</span></h1></div></div><div class="room-tools"><button class="icon-button" data-act="sound" title="${ui.sound?'关闭':'开启'}音效" aria-label="${ui.sound?'关闭':'开启'}音效">${icon(ui.sound?'sound':'mute')}</button><button class="secondary-button small" data-act="invite">${icon('copy',16)} 邀请朋友</button></div></div><div class="game-layout"><section class="battle-panel"><div class="battle-toolbar"><span><i class="live-dot"></i> ${inGame?'ROUND '+String(room.round).padStart(2,'0'):'THE ARENA'} <b>/</b> ${inGame?alive.length+' 人存活':room.players.filter(p=>!p.left).length+' / '+room.capacity+' 位玩家'}</span><span class="battle-instruction">${room.phase==='selecting'&&!room.ownAction&&me.hp>0?'选择招式 → 点击目标 → 锁定':room.phase==='interrupt'&&room.ownAction?.move==='meteor'?'点击头像选择封锁目标（包括自己）':'序号逆时针排列 · 自己始终在最下方'}</span></div><div class="arena ${room.phase==='reveal'&&room.result?.hasDamage?'arena-damage':''}"><div class="arena-circle circle-outer"></div><div class="arena-circle circle-inner"></div><div class="arena-cross horizontal"></div><div class="arena-cross vertical"></div><span class="arena-wordmark">ZAIZAI / ARENA</span>${renderSeats(room,inGame)}<div class="arena-hud">${renderCenter(room,me)}</div><div class="arena-controls">${inGame?arsenal(room,me):`<div class="center-welcome"><span class="center-symbol">✳</span><h2>${room.phase==='finished'?'好戏，还可以再来一场':'人齐了，就开场'}</h2><p>所有在房玩家准备后自动开局</p><button class="${me.ready?'secondary-button prepared':'primary-button'}" data-act="ready" ${disabled(ui.busy)}>${icon(me.ready?'check':'arrow',16)} ${me.ready?'已准备 · 点击取消':'我准备好了'}</button></div>`}</div></div><div class="battle-caption"><span>↶ 序号从小到大 · 逆时针环绕</span><span>第 ${room.gameNumber||1} 局 · ${inGame?'第 '+room.round+' 回合':'全员准备自动开局'}</span><button class="text-button" data-act="rules">全部招式 ${icon('arrow',12)}</button></div></section><aside class="battle-sidebar">${inGame?combatSidebar(room,me):waitingSidebar(room,me)}</aside></div></div>`;
}
function playerStatus(player,open){
  const extra='<span class="seat-extra'+(open?'':' hidden')+'"><span class="seat-resources">圣盾 '+(player.shields??0)+' · 锤 '+(player.hammers??0)+' · 防 '+(player.guards??0)+'</span>'+(player.bannedMove?'<span class="seat-ban">雪崩禁用：'+esc(moves[player.bannedMove]?.name||player.bannedMove)+'</span>':'')+'</span>';
  return '<span class="seat-vitals"><span class="heart">♥</span> '+Math.max(0,player.hp)+' <span class="seat-dot">·</span> ✦ '+player.energy+'</span><span class="seat-toggle" aria-hidden="true">其他资源：'+(open?'▾':'▸')+'</span>'+extra;
}
function revealedMove(room,action){
  let label=moves[action.move]?.name||action.move;
  if(action.reflect)label+='：'+(moves[action.reflect]?.name||action.reflect);
  else if(action.target&&Object.keys(room.actions||{}).length>2)label+=' → '+(room.players.find(p=>p.id===action.target)?.name||'已离场玩家');
  return label;
}
function renderSeats(room,inGame){
  const players=[...room.players].filter(p=>inGame||!p.left).sort((a,b)=>a.seat-b.seat);
  const slots=inGame?players.length:Math.max(room.capacity,players.length);
  const selfIndex=Math.max(0,players.findIndex(p=>p.id===self.id));
  return Array.from({length:slots},(_,i)=>{
    // CSS y points down: decreasing angles draw increasing numbers counterclockwise.
    const angle=Math.PI/2-(i-selfIndex)/slots*Math.PI*2;
    const x=50+Math.cos(angle)*39,y=50+Math.sin(angle)*36;
    const p=players[i];
    if(!p)return `<div class="seat empty-seat" style="left:${x}%;top:${y}%"><span class="avatar-shell empty-avatar">${icon('plus',20)}</span><span>等待加入</span></div>`;
    const isMe=p.id===self.id,dead=inGame&&p.hp<=0;
    const canTarget=meAlive(room)&&((room.phase==='selecting'&&!room.ownAction&&moves[ui.move]?.target&&!isMe&&!dead)||(room.phase==='interrupt'&&room.ownAction?.move==='meteor'&&!room.interruptSubmitted.includes(self.id)&&!dead));
    const selected=inGame&&(room.phase==='interrupt'?ui.interruptTarget:ui.target)===p.id;
    const action=['interrupt','reveal'].includes(room.phase)?room.actions?.[p.id]:null;
    const muted=inGame&&room.result?.muted?.includes(p.id);
    const delta=room.phase==='reveal'?room.result?.changes?.[p.id]:null;
    let bubble='';
    if(!inGame)bubble=`<span class="action-bubble readiness-bubble ${p.ready?'ready-bubble':'not-ready-bubble'}" data-ready="${p.ready}">${icon(p.ready?'check':'clock',11)} ${p.ready?'已准备':'未准备'}</span>`;
    else if(action)bubble=`<span class="action-bubble ${moves[action.move]?.color} ${muted?'muted':''}">${esc(moves[action.move]?.icon)} ${esc(revealedMove(room,action))}${action.automatic?' · 自动':''}${muted?' ×':''}</span>`;
    else if(room.phase==='selecting'&&room.submitted.includes(p.id))bubble=`<span class="action-bubble locked">${icon('lock',11)} 已锁定</span>`;
    return `<button class="seat ${isMe?'is-me':''} ${dead?'is-dead':''} ${canTarget?'targetable':''} ${selected?'target-selected':''} ${muted?'is-muted':''}" style="left:${x}%;top:${y}%;--player-color:${PALETTE[p.seat%8]}" data-act="target" data-id="${p.id}" data-seat="${p.seat+1}" data-can-target="${canTarget?1:0}" aria-label="${p.seat+1}号 ${esc(p.name)}${isMe?'，你':''}${dead?'，已阵亡':inGame?'，生命 '+p.hp:p.ready?'，已准备':'，未准备'}">${bubble}<span class="avatar-shell">${avatar(p.seat,dead?'dead':'normal')}${room.hostId===p.id?'<span class="host-badge" title="房主">'+icon('crown',12)+'</span>':''}${!p.connected?'<span class="disconnected-badge" title="连接中">!</span>':''}${selected&&canTarget?'<span class="target-check">'+icon('check',12)+'</span>':''}</span><span class="seat-name"><span class="seat-number">${p.seat+1}号</span> ${esc(p.name)} ${isMe?'<b>你</b>':''}</span><span class="seat-detail" data-act="toggle-status" data-id="${p.id}" title="展开 / 收起状态栏">${playerStatus(p,!!ui.statusOpen[p.id])}</span>${delta?.damage?'<span class="damage-float">−'+delta.damage+' ♥</span>':delta?.healing?'<span class="heal-float">+'+delta.healing+' ♥</span>':''}</button>`;
  }).join('');
}
function meAlive(room){return room.players.some(p=>p.id===self.id&&p.hp>0);}
function renderCenter(room,me){
  if(room.phase==='waiting')return '<span class="eyebrow">WAITING FOR PLAYERS</span><h2>等待开场</h2><span class="center-badge">'+room.players.filter(p=>p.ready&&!p.left).length+' / '+room.players.filter(p=>!p.left).length+' 已准备</span>';
  if(room.phase==='finished'){
    const result=room.lastMatch;
    return '<span class="eyebrow">MATCH '+room.gameNumber+' / FINISHED</span><h2 class="final-winner">'+(result?.winnerId?'♛ '+esc(result.winnerName)+' 获胜！':'◇ 本局平局')+'</h2><p>结果已锁定 · 共 '+(result?.round||room.round)+' 回合</p><span class="center-badge">'+room.players.filter(p=>p.ready&&!p.left).length+' / '+room.players.filter(p=>!p.left).length+' 已准备再来</span>';
  }
  if(room.phase==='selecting')return '<span class="eyebrow">ROUND '+String(room.round).padStart(2,'0')+'</span><div class="hud-timer-row"><span class="center-timer" data-timer>15</span><div><h2>'+(me.hp<=0?'正在观战':room.ownAction?'已锁定':'秘密选招')+'</h2><p>'+room.submitted.filter(id=>room.players.some(p=>p.id===id&&p.hp>0)).length+' / '+room.players.filter(p=>p.hp>0).length+' 已锁定</p></div></div>';
  if(room.phase==='interrupt')return '<span class="eyebrow">INTERRUPT PHASE</span><h2>✹ 流星锤封锁</h2><span class="center-badge"><span data-timer>12</span>s 后自动结算</span>';
  return '<span class="eyebrow">ROUND '+String(room.round).padStart(2,'0')+' / REVEAL</span><h2>'+(room.result?.finished?(room.lastMatch?.winnerId?'♛ '+esc(room.lastMatch.winnerName)+' 获胜！':'◇ 本局平局'):room.result?.hasDamage?'⚔ 交锋已结算':'✦ 无人受伤')+'</h2><span class="center-badge"><span data-timer>2</span>s 后'+(room.result?.finished?'进入准备':'进入下一回合')+'</span>';
}
function waitingSidebar(room,me){
  const members=room.players.filter(p=>!p.left),host=room.hostId===self.id;
  return `<section class="panel room-settings"><div class="panel-title-row"><h2>${room.phase==='finished'?'再来一局':'房间设置'}</h2><span class="eyebrow">${host?'HOST':'PLAYER'}</span></div><div class="setting-row"><span>房间人数</span>${host?'<select id="capacity-select" aria-label="调整房间人数" '+disabled(ui.busy)+'>'+Array.from({length:7},(_,i)=>i+2).map(n=>'<option value="'+n+'" '+(n===room.capacity?'selected':'')+' '+disabled(n<members.length)+'>'+n+' 人</option>').join('')+'</select>':'<b>'+room.capacity+' 人</b>'}</div><div class="setting-row"><span>准备进度</span><b>${members.filter(p=>p.ready).length} / ${members.length}</b></div><button class="${me.ready?'secondary-button prepared':'primary-button'} full-width" data-act="ready" ${disabled(ui.busy)}>${icon(me.ready?'check':'arrow',16)} ${me.ready?'已准备 · 点击取消':room.phase==='finished'?'准备，再来一局':'我准备好了'}</button><p class="helper-text">${members.length<2?'邀请至少一位朋友开始吧。':'所有在房玩家准备后自动开局。'}</p></section>${logPanel(room)}${leaderboardPanel(room)}`;
}
function combatSidebar(room,me){
  const action=room.ownAction;
  return `<section class="panel my-status"><div class="panel-title-row"><h2>我的状态</h2><span class="status-pill ${me.hp<=0?'full':''}"><i></i>${me.hp<=0?'观战中':'存活'}</span></div><div class="resource-grid"><div><span class="heart">♥</span><b>${Math.max(me.hp,0)}</b><small>生命</small></div><div><span class="mint-text">✦</span><b>${me.energy}</b><small>仔</small></div><div><span class="amber-text">⚒</span><b>${me.hammers}</b><small>锤</small></div><div><span class="blue-text">⬡</span><b>${me.shields}</b><small>圣盾</small></div></div><div class="turn-status">${icon(action?'lock':'clock',16)} ${me.hp<=0?'本局已阵亡，等待下一局':room.phase==='selecting'?action?`已锁定：${esc(moves[action.move].name)}${action.target?' → '+esc(room.players.find(p=>p.id===action.target)?.name):''}`:`等待出招 · ${room.submitted.length}/${room.players.filter(p=>p.hp>0).length} 已锁定`:room.phase==='interrupt'?'流星锤封锁阶段':'本回合已结算'}</div></section>${logPanel(room)}${leaderboardPanel(room)}`;
}
function logPanel(room){
  const entries=room.history||[];
  return '<section class="panel battle-log"><div class="panel-title-row"><h2>战况速递</h2><span class="eyebrow">历史战报</span></div><div class="log-content">'+(entries.length?entries.map(entry=>'<div class="log-round"><span>第 '+(entry.gameNumber||room.gameNumber)+' 局 · ROUND '+String(entry.round).padStart(2,'0')+'</span>'+entry.logs.map(l=>'<p class="log-entry log-'+l.type+'"><i>'+({damage:'↗',death:'×',block:'◇',reflect:'↩',heal:'♥',gain:'✦',avalanche:'❄',mute:'✹',clash:'⚔',drain:'⚒'}[l.type]||'·')+'</i><span>'+esc(l.text)+'</span></p>').join('')+'</div>').join(''):'<div class="empty-log"><span>⌁</span><p>交锋之后，自有答案。</p><small>已结算的回合战报会自动记录于此。</small></div>')+'</div></section>';
}
function leaderboardPanel(room){
  const result=room.lastMatch,current=result?.gameNumber===room.gameNumber;
  return '<section class="panel leaderboard"><div class="panel-title-row"><h2>排行榜</h2><span class="eyebrow">房间累计胜场</span></div>'+(result?'<div class="match-result" data-game="'+result.gameNumber+'"><span>第 '+result.gameNumber+' 局'+(current?' · 本局结果':' · 上局结果')+'</span><strong>'+(result.winnerId?'♛ '+esc(result.winnerName)+' 获胜':'◇ 平局')+'</strong><small>'+result.round+' 回合 · 结果已锁定</small></div>':'<p class="ranking-note">每局结束实时更新，重新开局继续累计。</p>')+'<ol class="ranking-list">'+(room.leaderboard||[]).map((p,i)=>'<li class="'+(p.id===self.id?'ranking-self':'')+'" data-player="'+p.id+'"><span class="rank-number">'+String(i+1).padStart(2,'0')+'</span><span class="rank-name">'+esc(p.name)+(p.id===self.id?' <b>你</b>':'')+(!p.present?' <small>已离开</small>':'')+'</span><strong class="rank-wins">'+p.wins+' <small>胜</small></strong></li>').join('')+'</ol></section>';
}
function arsenal(room,me){
  if(me.hp<=0)return '<section class="spectator-banner"><span>'+avatar(me.seat,'dead')+'</span><div><h2>正在观战</h2><p>你已阵亡，本局无法操作。<br>结束后准备即可重新加入。</p></div></section>';
  if(room.phase==='interrupt'){
    const can=room.ownAction?.move==='meteor'&&!room.interruptSubmitted.includes(self.id);
    return '<section class="interrupt-panel"><span class="eyebrow">METEOR HAMMER</span><h2>'+(can?'封锁谁的招式？':'等待流星锤封锁')+'</h2><p>'+(can?'点击存活玩家头像，也可以选自己。':'全部招式已亮出，封锁结束后结算。')+'</p>'+(can?'<div class="interrupt-controls"><span>'+(ui.interruptTarget?'目标：'+esc(room.players.find(p=>p.id===ui.interruptTarget)?.name):'请选择封锁目标')+'</span><button class="primary-button" data-act="interrupt" '+disabled(!ui.interruptTarget||ui.busy)+'>确认封锁 '+icon('arrow',13)+'</button><button class="text-button" data-act="skip-interrupt">跳过</button></div>':'<span class="center-badge">'+(room.interruptSubmitted.includes(self.id)?'已确认':'等待选择')+'</span>')+'</section>';
  }
  if(room.phase==='reveal')return '';
  if(room.ownAction){
    const move=moves[room.ownAction.move],target=room.players.find(p=>p.id===room.ownAction.target);
    return '<section class="locked-selection '+move.color+'"><span class="move-glyph">'+move.icon+'</span><span class="eyebrow">MOVE LOCKED</span><h2>已锁定 · '+esc(move.name)+'</h2><p>'+(target?'目标：'+esc(target.name):room.ownAction.reflect?'反弹：'+esc(moves[room.ownAction.reflect].name):'等待其他玩家出招')+'</p><span class="center-badge">'+icon('lock',11)+' 全员锁定后同时亮招</span></section>';
  }
  const selectedMove=moves[ui.move];
  const valid=validSelection(room,me);
  const available=Object.entries(moves).filter(([id,move])=>id!==me.bannedMove&&Object.entries(move.cost).every(([key,n])=>(me[key]??0)>=n));
  return '<section class="arsenal'+(available.length>6?' many-moves':'')+'"><div class="moves-grid">'+available.map(([id,move])=>'<button class="move-card '+move.color+' '+(ui.move===id?'selected':'')+'" data-act="move" data-id="'+id+'" '+disabled(ui.busy)+' title="'+esc(move.description)+'" aria-pressed="'+(ui.move===id)+'"><span class="move-glyph">'+move.icon+'</span><strong>'+move.name+'</strong><span class="move-cost">'+costLabel(move)+'</span></button>').join('')+'</div><div class="action-bar">'+(selectedMove?.reflect?'<select id="reflect-select" aria-label="金盾反弹招式">'+reflectable.map(id=>'<option value="'+id+'" '+(id===ui.reflect?'selected':'')+'>反弹 · '+moves[id].name+'</option>').join('')+'</select>':'')+'<button class="primary-button lock-button" data-act="submit-action" '+disabled(!valid||ui.busy)+'>'+icon('lock',15)+' 锁定招式</button></div></section>';
}

async function showRules(){
  try { await rulesReady; } catch { toast('玩法加载失败，请检查连接后重试。'); return; }
  openModal(`${modalHeader('THE PLAYBOOK','见招拆招 · 玩法手册')}<div class="rules-intro"><p>初始 <b>1 点生命</b>，生命无上限。所有人同时选择招式、同时结算。生命 ≤ 0 即阵亡，最后一名幸存者获胜；同时全部阵亡为平局。</p><div><span>✦ 仔</span><span>⚒ 锤</span><span>⬡ 圣盾</span><span>◇ 防</span><small>四种资源独立累积，用于支付不同招式。</small></div></div><div class="rules-moves">${Object.entries(moves).map(([,move])=>`<div class="rule-move"><span class="move-mini ${move.color}">${move.icon}</span><div><strong>${move.name}</strong><span class="rule-cost">${costLabel(move)}</span><p>${emphasized(move.description)}</p></div></div>`).join('')}</div><div class="rules-notes"><h3>每回合如何推进</h3><p>选招最多 15 秒，所有存活玩家锁定后立即亮招。超时自动使用「仔」；若「仔」被雪崩禁用，则自动使用「防」。有人使用流星锤时，先留出 12 秒选择封锁目标，再统一结算；超时视为跳过封锁。</p><p>无人受伤展示 2 秒；有人受到实际伤害展示 5 秒，随后自动进入下一回合。阵亡玩家只能观战。对局结束后，所有在房玩家再次准备即可开新局。</p><h3>雪崩与防</h3><p>每次有效使用防获得 1 个防，雪崩消耗 3 个防。雪崩本回合不禁招：从下回合起，施放者禁用防，其他玩家各自禁用施放回合所选招式，持续到新的有效雪崩整体覆盖旧限制。限制不随施放者阵亡或离房消失，新一局重置。</p><p>同回合多人施放雪崩时合并为一次覆盖：所有有效施放者禁用防，其他玩家禁用各自所选招式。被流星锤封锁的雪崩仍消耗防，但不覆盖限制；被封锁的防不获得防次数。头像下方公开展示生命、仔、圣盾、锤与防的当前数量，以及雪崩禁用的招式。</p><h3>锤带盾与多锤结算</h3><p>锤带盾消耗 1 个圣盾，需指定一名其他存活玩家，同时具备锤和防的防御效果。锤与锤带盾都能敲击使用防或锤带盾的目标；每把锤分别结算，有仔扣 1 仔，无仔扣 1 生命。例如 1 个仔被 3 把锤指定，扣 1 仔和 2 生命。</p><p>锤带盾是独立招式，不增加锤或防次数，也不视为使用圣盾。雪崩禁用锤或防时仍可选择锤带盾；只有禁用锤带盾本身才不能选择。被流星锤封锁后仍消耗圣盾，但攻击和防御效果失效。</p><h3>边界规则说明</h3><p>火球的相邻玩家按环形站位中的存活顺序计算，去重且不伤及使用者。互相命中的有点数攻击逐对比较，低点数只对该对手失效，同点数对彼此的攻击抵消，双方不因此受伤；群攻对其他目标仍照常结算。</p><p>所有消耗先扣除，再结算效果；生命回复与伤害同时结算。天使与黑天使生效时，本回合累计受到的伤害至多 1 点；被流星锤封锁时不回复生命，也失去伤害上限保护。明确的反弹效果优先于攻击点数比较。反弹最多一次，反弹回来的攻击仍可被原施法者的防御抵挡。流星锤只对仍生效的圣盾和金盾造成 1 点破盾伤害；封锁对方的盾后不触发破盾，封锁自己则流星锤攻击失效；多把流星锤的封锁同时生效，封锁已选定后不会互相撤销，但被封锁招式的其他效果全部失效。</p><p>离线保留席位 60 秒，可刷新重连；超时后自动离房，对局中视为弃权。人数上限由房主在非对局期间调整，实际人数至少 2 人且全员准备就能开局。</p></div>`, 'wide');
}
function showCreate(){
  openModal(`${modalHeader('YOUR ROOM, YOUR GAME','开个房间，等朋友来')}<form id="create-form"><label class="field-label" for="room-name">房间名称 <span>最多 20 字</span></label><input class="form-input" id="room-name" name="name" maxlength="20" placeholder="${esc(self.name)}的房间" autocomplete="off"><label class="field-label" for="room-capacity">房间人数 <span>房主可在开局前调整</span></label><select class="form-input" id="room-capacity" name="capacity">${Array.from({length:7},(_,i)=>i+2).map(n=>`<option value="${n}" ${n===4?'selected':''}>${n} 人</option>`).join('')}</select><div class="create-note">${icon('users',18)} 2 人起玩，全员准备后自动开始。</div><button class="primary-button full-width" type="submit">创建房间 ${icon('arrow',18)}</button></form>`);
}
async function copyText(value,success){
  try{await navigator.clipboard.writeText(value);toast(success);}catch{
    openModal(`${modalHeader('INVITE YOUR FRIENDS','复制后发给朋友')}<p class="helper-text">浏览器限制了自动复制，请长按或选中下方内容手动复制。</p><input class="form-input" id="manual-copy" value="${esc(value)}" readonly aria-label="邀请信息">`);
    $('#manual-copy').select();
  }
}
function showLeave(){
  if(!['selecting','interrupt','reveal'].includes(state.room?.phase))return command('/rooms/leave');
  openModal(`${modalHeader('LEAVE THE ARENA','要先离开战场吗？')}<p class="modal-description">本局离开将视为弃权，无法重新加入正在进行的对局。</p><div class="modal-actions"><button class="secondary-button" data-act="close-modal">继续对局</button><button class="danger-button" data-act="confirm-leave">离开房间</button></div>`);
}
document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-act]');if(!el||el.disabled)return;
  const act=el.dataset.act,id=el.dataset.id;
  if(act==='close-modal')return dialog.close();
  if(act==='rules')return showRules();
  if(act==='show-history')return openModal(`${modalHeader('ROUND HISTORY','战况记录')}${logPanel(state.room)}`,'wide');
  if(act==='show-leaderboard')return openModal(`${modalHeader('ROOM RANKING','排行榜')}${leaderboardPanel(state.room)}`);
  if(act==='create')return showCreate();
  if(act==='join')return command('/rooms/join',{roomId:id});
  if(act==='filter'){ui.filter=el.dataset.value;render();return;}
  if(act==='ready')return command('/rooms/ready');
  if(act==='leave')return showLeave();
  if(act==='confirm-leave'){dialog.close();return command('/rooms/leave');}
  if(act==='invite')return copyText(`${location.origin}/?room=${state.room.id}`,'邀请链接已复制，发给朋友来集合！');
  if(act==='copy-code')return copyText(state.room.id,'房间号已复制');
  if(act==='sound'){ui.sound=!ui.sound;localStorage.setItem('zaizai-sound',String(ui.sound));sound();render();toast(ui.sound?'音效已开启':'音效已关闭');return;}
  if(act==='move'){
    ui.move=id;ui.target=null;sound();render();
    return;
  }
  if(act==='toggle-status'){ui.statusOpen[id]=!ui.statusOpen[id];render();return;}
  if(act==='target'){
    if(el.dataset.canTarget!=='1')return;
    if(state.room.phase==='interrupt')ui.interruptTarget=id;else ui.target=id;
    sound();render();
    return;
  }
  if(act==='submit-action')return command('/game/action',{round:state.room.round,move:ui.move,target:ui.target,reflect:ui.reflect});
  if(act==='interrupt')return command('/game/interrupt',{round:state.room.round,target:ui.interruptTarget});
  if(act==='skip-interrupt')return command('/game/interrupt',{round:state.room.round,target:null});
  if(act==='signout'){
    if(state.room)await command('/rooms/leave');
    if(state.room)return;
    events?.close();token=null;self=null;sessionStorage.removeItem('zaizai-token');state={rooms:[],room:null};dialog.close();render();
  }
});
document.addEventListener('submit',async event=>{
  const form=event.target;
  if(!['login-form','join-form','create-form'].includes(form.id))return;
  event.preventDefault();
  if(form.id==='login-form'){
    const name=$('#nickname').value.trim();if(!name)return;
    const button=form.querySelector('button');button.disabled=true;button.textContent='正在进入…';
    try{await login(name);}catch(e){toast(e.message);render();}return;
  }
  if(form.id==='join-form')return command('/rooms/join',{roomId:$('#join-code').value.trim()});
  if(form.id==='create-form'){
    if(ui.busy)return;
    const body={name:$('#room-name').value.trim(),capacity:Number($('#room-capacity').value)};
    ui.busy=true;const button=form.querySelector('button[type=submit]');button.disabled=true;
    try{await api('/rooms/create',body);dialog.close();}catch(e){toast(e.message);}finally{ui.busy=false;button.disabled=false;render();}
  }
});
document.addEventListener('input',event=>{if(event.target.id==='search'){ui.search=event.target.value;render();}});
document.addEventListener('change',event=>{
  if(event.target.id==='capacity-select')command('/rooms/capacity',{capacity:Number(event.target.value)});
  if(event.target.id==='reflect-select'){ui.reflect=event.target.value;render();}
});
document.addEventListener('focusout',()=>{
  if(deferredRender)setTimeout(()=>{
    if(deferredRender&&!document.activeElement?.matches('select')){deferredRender=false;render();}
  },0);
});
$('#user-button').addEventListener('click',()=>openModal(`${modalHeader('TEMPORARY IDENTITY','这一局，你是 '+esc(self.name))}<p class="modal-description">无需账号。昵称只用于对局展示，刷新页面可以重连。每个浏览器标签页使用独立的临时身份。</p><button class="secondary-button full-width" data-act="signout">${state.room?'退出房间并更换昵称':'更换临时昵称'} ${icon('arrow',17)}</button>`));
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
function tick(){
  const room=state.room;if(!room?.deadline)return;
  const left=Math.max(0,Math.ceil((room.deadline-Date.now()-timeOffset)/1000));
  document.querySelectorAll('[data-timer]').forEach(el=>{el.textContent=left;el.classList.toggle('timer-urgent',left<=5&&room.phase==='selecting');});
}
setInterval(tick,200);
rulesReady=api('/rules').then(data=>{moves=data.moves;reflectable=data.reflectable;resourceNames=data.resourceNames;}).catch(error=>{console.error(error);});
render();
if(token)login().catch(e=>{token=null;self=null;sessionStorage.removeItem('zaizai-token');render();toast(e.message);});
