import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3100';
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const errors = [];
const contexts = [];
const pages = [];
await mkdir('test-results', { recursive: true });
async function screenshot(page, name) { await page.screenshot({ path: `test-results/${name}.png`, fullPage: true }); }
async function clickMove(page, move, target) {
  await page.locator(`[data-act=move][data-id="${move}"]`).click();
  if (target) await page.locator(`[data-act=target][data-id="${target}"]`).click();
  await page.locator('[data-act=submit-action]').click();
}
async function info(page) { return page.evaluate(async () => { const r = await fetch('/api/state', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('zaizai-token') } }); return r.json(); }); }
async function checkRing(page,count){
  const ring=await page.evaluate(()=>[...document.querySelectorAll('.seat[data-seat]')].map(el=>({seat:Number(el.dataset.seat),x:parseFloat(el.style.left),y:parseFloat(el.style.top),me:el.classList.contains('is-me')})).sort((a,b)=>a.seat-b.seat));
  assert.equal(ring.length,count);const me=ring.find(p=>p.me);assert.ok(me);
  assert.ok(Math.abs(me.x-50)<.001&&Math.abs(me.y-86)<.001,'每一名玩家的视角都把自己置于环形底部');
  const angles=ring.map(p=>(Math.atan2((50-p.y)/36,(p.x-50)/39)+Math.PI*2)%(Math.PI*2));
  const total=angles.reduce((sum,a,i)=>sum+(angles[(i+1)%angles.length]-a+Math.PI*2)%(Math.PI*2),0);
  assert.ok(Math.abs(total-Math.PI*2)<.001,'所有视角中序号小到大逆时针排列');
}
async function checkArenaCorners(page){
  const corners=await page.evaluate(()=>{
    const arena=document.querySelector('.arena'),r=arena.getBoundingClientRect();
    return [['show-leaderboard',false],['show-history',true]].map(([act,bottom])=>{
      const button=arena.querySelector('[data-act="'+act+'"]');if(!button)return false;
      const b=button.getBoundingClientRect();
      return button.parentElement===arena&&b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom&&(bottom?b.right>r.left+r.width/2&&b.top>r.top+r.height/2:b.right<r.left+r.width/2&&b.bottom<r.top+r.height/2);
    });
  });
  assert.deepEqual(corners,[true,true],'排行榜与战况按钮直接位于战场内部左上角和右下角');
}

async function checkArenaFooter(page){
  const centers=await page.evaluate(()=>{
    const label=document.querySelector('.match-progress').getBoundingClientRect();
    const me=document.querySelector('.seat.is-me').getBoundingClientRect();
    return {label:label.left+label.width/2,me:me.left+me.width/2};
  });
  assert.ok(Math.abs(centers.label-centers.me)<1,'局数与回合数位于己方角色正下方');
}

async function checkPlayViewport(page){
  const result=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();const arena=rect('.battle-panel'),controls=rect('.arsenal');return {arenaVisible:arena.top>=0&&arena.bottom<=innerHeight,controlsVisible:controls.top>=0&&controls.bottom<=innerHeight,inside:controls.left>=arena.left&&controls.right<=arena.right&&controls.top>=arena.top&&controls.bottom<=arena.bottom};});
  assert.ok(result.arenaVisible&&result.controlsVisible&&result.inside,'环形战场与中央可用招式完整同屏，无需滚动');
}
async function waitPhase(page, phase, round) {
  await page.waitForFunction(async ({ phase, round }) => {
    const response = await fetch('/api/state', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('zaizai-token') } });
    const { room } = await response.json();
    return room?.phase === phase && (!round || room.round === round);
  }, { phase, round }, { timeout: 15000 });
  const selector = { selecting: '.arena-controls .arsenal', interrupt: '.interrupt-panel', reveal: '.arena-hud .center-badge', finished: '.center-welcome' }[phase];
  if(selector)await page.locator(selector).waitFor();
}
try {
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    contexts.push(context); pages.push(page);
  }
  const [a, b, c] = pages;
  await a.goto(base);
  await a.getByRole('heading', { name: /蓄一手/ }).waitFor();
  await a.locator('#rules-open').click();
  await a.locator('#modal .rule-move').last().waitFor();
  assert.equal(await a.locator('#modal .rule-move').count(),14,'未登录也能查看全部 14 个招式');
  await a.locator('[data-act=close-modal]').click();
  await screenshot(a, '01-welcome-desktop');
  await a.setViewportSize({ width: 390, height: 844 });
  await screenshot(a, '02-welcome-mobile');
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '手机首页没有横向溢出');
  await a.setViewportSize({ width: 1440, height: 1050 });
  for (const [i, page] of pages.entries()) {
    if (i) await page.goto(base);
    await page.getByLabel('临时昵称').fill(['仔仔测试', '小蓝测试', '橘子测试'][i]);
    await page.getByRole('button', { name: '进入大厅' }).click();
    await page.getByRole('heading', { name: '游戏大厅' }).waitFor();
  }
  await screenshot(a, '03-lobby');
  await a.locator('.page-heading [data-act=create]').click();
  await a.getByLabel('房间名称').fill('今晚见招拆招');
  await a.locator('#room-capacity').selectOption('3');
  await a.locator('#create-form button[type=submit]').click();
  await a.locator('.battle-room-name').filter({hasText:'今晚见招拆招'}).waitFor();
  const roomId = (await info(a)).room.id;
  for (const page of [b,c]) {
    await page.getByLabel('房间号', { exact: true }).fill(roomId);
    await page.locator('#join-form button').click();
    await page.locator('.battle-room-name').filter({hasText:'今晚见招拆招'}).waitFor();
  }
  await a.getByLabel('调整房间人数').selectOption('8');
  await a.waitForTimeout(150);
  assert.equal((await info(b)).room.capacity, 8);
  for(const page of pages){await checkRing(page,3);assert.equal(await page.locator('.not-ready-bubble').count(),3);}
  await checkArenaCorners(a);await checkArenaFooter(a);
  await screenshot(a, '04-room-waiting');
  await a.setViewportSize({ width: 390, height: 844 });
  await checkArenaCorners(a);await checkArenaFooter(a);
  await screenshot(a, '05-room-mobile');
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '手机房间没有横向溢出');
  await a.setViewportSize({ width: 1440, height: 1050 });
  for (const page of pages) await page.locator('.arena-controls [data-act=ready]').click();
  await waitPhase(a, 'selecting', 1);
  await a.locator('[data-act=move][data-id=charge]').waitFor();
  const idA = (await info(a)).self.id, idB = (await info(b)).self.id, idC = (await info(c)).self.id;
  for(const page of pages)await checkRing(page,3);
  await a.locator('[data-act=move][data-id=hammer]').click();
  assert.equal(await a.locator('[data-act=submit-action]').isDisabled(),true,'三名存活玩家时仍须手动选择目标');
  assert.equal(await a.locator('.seat.target-selected').count(),0);
  await a.locator('[data-act=move][data-id=charge]').click();
  assert.equal(await a.locator('.move-card').count(),3,'初始只显示仔、防、锤三种可用招式');
  assert.equal(await a.locator('.log-tabs').count(),0,'战报不再区分本回合和历史标签');
  await a.setViewportSize({width:1366,height:768});await checkPlayViewport(a);await screenshot(a,'12-compact-desktop');
  // Layout stress: all 14 moves available and eight seats, without mutating the server.
  const savedRoom=await a.evaluate(()=>structuredClone(state.room));
  await a.evaluate(()=>{const me=state.room.players.find(p=>p.id===self.id);Object.assign(me,{energy:20,hammers:6,shields:6,guards:6});while(state.room.players.length<8){const i=state.room.players.length;state.room.players.push({...me,id:'layout-'+i,name:'玩家'+(i+1),seat:i});}render();});
  assert.equal(await a.locator('.move-card').count(),14);await checkPlayViewport(a);await checkRing(a,8);

  assert.equal(await a.locator('.seat-resources').count(),8,'所有头像公开资源');
  await a.evaluate(()=>{const me=state.room.players.find(p=>p.id===self.id);me.bannedMove='charge';ui.move='charge';render();});
  assert.equal(await a.locator('[data-act=move][data-id=charge]').count(),0,'雪崩禁招从可选列表移除');
  assert.equal(await a.locator('[data-act=submit-action]').isDisabled(),true,'禁招不能保留为待提交选择');
  assert.equal(await a.locator('.arsenal-heading,.selected-description,.action-detail').count(),0,'选招区只保留招式和锁定控件');
  assert.match(await a.locator('.seat.is-me .seat-ban').textContent(),/雪崩禁用：仔/);
  await a.evaluate(()=>{state.room.players.forEach(p=>p.bannedMove='charge');render();});
  assert.equal(await a.locator('.seat-ban').count(),8);

  await a.evaluate(()=>{state.room.players.forEach(p=>p.bannedMove=null);render();});
  await screenshot(a,'15-eight-players-all-moves');
  await a.locator('[data-act=move][data-id=shieldHammer]').click();
  assert.equal(await a.locator('[data-act=submit-action]').isDisabled(),true,'多人存活时锤带盾需要指定目标');
  await a.locator('.seat[data-id="'+idB+'"]').click();
  assert.equal(await a.locator('[data-act=submit-action]').isEnabled(),true);
  for(const id of await a.locator('.move-card').evaluateAll(els=>els.map(el=>el.dataset.id))){
    await a.evaluate(id=>{ui.move=id;render();},id);
    await checkPlayViewport(a);
    const overlaps=await a.evaluate(()=>{const c=document.querySelector('.arena-controls').getBoundingClientRect();return [...document.querySelectorAll('.seat[data-seat]')].filter(el=>{const r=el.getBoundingClientRect();return Math.min(r.right,c.right)>Math.max(r.left,c.left)&&Math.min(r.bottom,c.bottom)>Math.max(r.top,c.top);}).map(el=>el.dataset.seat);});
    if(overlaps.length)await screenshot(a,'layout-desktop-failure-'+id);
    assert.deepEqual(overlaps,[],'Desktop selecting '+id+' keeps avatars clear');
  }
  await a.setViewportSize({width:390,height:844});await checkPlayViewport(a);
  await screenshot(a,'16-eight-players-mobile');
  const overlaps=await a.evaluate(()=>{const c=document.querySelector('.arena-controls').getBoundingClientRect();return [...document.querySelectorAll('.seat[data-seat]')].filter(el=>{const r=el.getBoundingClientRect();return Math.min(r.right,c.right)>Math.max(r.left,c.left)&&Math.min(r.bottom,c.bottom)>Math.max(r.top,c.top);}).map(el=>el.dataset.seat);});
  assert.deepEqual(overlaps,[],'手机上 14 种招式与 8 名玩家头像不重叠');
  for(const id of await a.locator('.move-card').evaluateAll(els=>els.map(el=>el.dataset.id))){
    await a.evaluate(id=>{ui.move=id;ui.target=null;render();},id);
    await checkPlayViewport(a);
    const intersecting=await a.evaluate(()=>{const c=document.querySelector('.arena-controls').getBoundingClientRect();return [...document.querySelectorAll('.seat[data-seat]')].filter(el=>{const r=el.getBoundingClientRect();return Math.min(r.right,c.right)>Math.max(r.left,c.left)&&Math.min(r.bottom,c.bottom)>Math.max(r.top,c.top);}).map(el=>el.dataset.seat);});
    if(intersecting.length)await screenshot(a,'layout-failure-'+id);
    assert.deepEqual(intersecting,[],'Selecting '+id+' keeps all avatars clear');
  }
  for(const [energy,hammers,shields,guards] of [[0,0,0,0],[1,0,0,0],[2,0,0,0],[3,0,0,0],[4,0,0,0],[5,0,0,0],[5,3,0,0],[0,0,0,3],[0,0,1,0]]){
    await a.evaluate(({energy,hammers,shields,guards})=>{Object.assign(state.room.players.find(p=>p.id===self.id),{energy,hammers,shields,guards});ui.move=null;render();},{energy,hammers,shields,guards});
    for(const id of await a.locator('.move-card').evaluateAll(els=>els.map(el=>el.dataset.id))){
      await a.evaluate(id=>{ui.move=id;render();},id);
      await checkPlayViewport(a);
      const overlaps=await a.evaluate(()=>{const c=document.querySelector('.arena-controls').getBoundingClientRect();return [...document.querySelectorAll('.seat[data-seat]')].filter(el=>{const r=el.getBoundingClientRect();return Math.min(r.right,c.right)>Math.max(r.left,c.left)&&Math.min(r.bottom,c.bottom)>Math.max(r.top,c.top);}).map(el=>el.dataset.seat);});
      if(overlaps.length)await screenshot(a,'layout-failure-'+energy+'-'+id);
      assert.deepEqual(overlaps,[],'Resources '+energy+'/'+hammers+'/'+shields+', selecting '+id+' keeps avatars clear');
    }
  }

  const shownResources=await a.locator('.seat.is-me .seat-resources').textContent();
  assert.match(shownResources,/圣盾 1.*锤 0.*防 0/,'头像公开显示当前资源，随资源变化更新');
  const selectingRoom=await a.evaluate(()=>structuredClone(state.room));
  for(const move of ['gun','hammer','darkAngel','fireball','shieldHammer']){
    await a.evaluate(({move,idB,idC})=>{
      state.room.phase='reveal';state.room.actions={[self.id]:{move,target:idB},[idB]:{move:'gold',reflect:'fireball'},[idC]:{move:'guard'}};
      state.room.players.forEach(p=>p.bannedMove='charge');render();
    },{move,idB,idC});
    assert.match(await a.locator('.seat.is-me .action-bubble').textContent(),new RegExp(move==='shieldHammer'?'锤带盾 → 小蓝测试':({gun:'枪',hammer:'锤',darkAngel:'黑天使',fireball:'火球'}[move])+' → 小蓝测试'));
    assert.match(await a.locator('.seat[data-id="'+idB+'"] .action-bubble').textContent(),/金盾：火球/);
    assert.equal(await a.locator('.seat-ban').count(),8);
  }
  await a.setViewportSize({width:390,height:844});await screenshot(a,'18-revealed-targets-and-resources-mobile');
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const bubbled=await a.locator('.action-bubble').evaluateAll(els=>els.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&el.scrollWidth<=el.clientWidth+1;}));
  assert.equal(bubbled,true,'亮招目标与金盾反弹信息完整显示且不超出屏幕');
  await a.evaluate(room=>{state.room=room;render();},selectingRoom);
  await a.setViewportSize({width:1366,height:768});
  await a.evaluate(room=>{state.room=room;render();},savedRoom);
  await a.setViewportSize({width:1440,height:1050});
  for (let round = 1; round <= 3; round++) {
    await waitPhase(a, 'selecting', round);
    await clickMove(a, 'hammer', idB);
    await clickMove(b, 'charge');
    await clickMove(c, 'charge');
    await waitPhase(a, 'reveal', round);
    if (round === 1) await screenshot(a, '06-round-reveal');
  }
  await waitPhase(a, 'selecting', 4);
  await clickMove(a, 'meteor');
  await clickMove(b, 'holy');
  await clickMove(c, 'charge');
  await waitPhase(a, 'interrupt', 4);
  await a.locator('.interrupt-panel').waitFor();
  await screenshot(a, '07-meteor-interrupt');
  await a.locator(`[data-act=target][data-id="${idC}"]`).click();
  await a.locator('[data-act=interrupt]').click();
  await waitPhase(a, 'reveal', 4);
  let room = (await info(a)).room;
  assert.equal(room.players.find(p=>p.id===idB).hp, 0);
  assert.equal(room.players.find(p=>p.id===idC).energy, 3, '封锁仔后不增加资源');
  assert.equal(await b.locator('.seat.is-dead').count(), 1);
  await b.locator('.spectator-banner').waitFor();
  assert.equal(await b.locator('[data-act=submit-action]').count(), 0, '死亡玩家没有操作入口');
  await screenshot(a, '08-damage-reveal');
  await waitPhase(a, 'selecting', 5);
  await a.reload();
  await a.locator('[data-act=move][data-id=charge]').waitFor();
  assert.equal((await info(a)).self.id, idA, '刷新后恢复相同身份');
  const duelResources=await a.evaluate(()=>{const me=state.room.players.find(p=>p.id===self.id);const resources={energy:me.energy,shields:me.shields};me.energy=20;me.shields=1;render();return resources;});
  for(const move of ['hammer','shieldHammer','gun','fireball','darkAngel']){
    await a.locator('[data-act=move][data-id="'+move+'"]').click();
    assert.equal(await a.locator('.seat.target-selected').getAttribute('data-id'),idC,'两人存活时 '+move+' 自动指定对手，跳过死者');
    assert.equal(await a.locator('[data-act=submit-action]').isEnabled(),true);
  }
  await a.evaluate(resources=>{Object.assign(state.room.players.find(p=>p.id===self.id),resources);ui.move=null;ui.target=null;render();},duelResources);
  await clickMove(a,'charge');await clickMove(c,'charge');
  await waitPhase(a,'selecting',6);
  await screenshot(a,'09-battle-desktop');
  await a.setViewportSize({width:390,height:844});
  await checkPlayViewport(a);
  await screenshot(a,'10-battle-mobile');
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true,'手机对战没有横向溢出');
  await a.locator('[data-act=move][data-id=gun]').click();
  assert.equal(await a.locator('.seat.target-selected').getAttribute('data-id'),idC);
  const box=await a.locator('.action-bar').boundingBox();
  assert.ok(box.y>=0&&box.y+box.height<=844,'手机选中目标后，锁定按钮保持在可见区域');
  await a.locator('[data-act=submit-action]').click();await clickMove(c,'charge');
  await a.setViewportSize({width:1440,height:1050});
  await waitPhase(a,'finished',6);
  room=(await info(a)).room;assert.equal(room.result.winnerId,idA);
  await screenshot(a,'11-victory');
  assert.equal(room.leaderboard.find(p=>p.id===idA).wins,1);
  await a.locator('[data-act=show-leaderboard]').click();
  await a.locator('#modal .leaderboard').waitFor();
  assert.equal(await a.locator('#modal .ranking-list li').count(),3,'排行榜按钮打开本局结果和全员排名');
  assert.equal(await a.locator('#modal .match-result').count(),1);
  await a.locator('#modal [data-act=close-modal]').click();
  await a.locator('[data-act=show-history]').click();
  await a.locator('#modal .battle-log').waitFor();
  assert.ok(await a.locator('#modal .log-round').count()>0,'战况记录弹窗只显示已结算的历史回合');
  await a.locator('#modal [data-act=close-modal]').click();
  for(const page of pages){assert.equal(await page.locator('.not-ready-bubble').count(),3);assert.equal(await page.locator('.seat.is-dead').count(),0);}
  await a.locator('.arena-controls [data-act=ready]').click();
  await b.locator('.seat[data-id="'+idA+'"] .ready-bubble').waitFor();
  assert.equal(await b.locator('.not-ready-bubble').count(),2,'第二局前准备状态正确显示在每个人头像上方');
  await screenshot(b,'13-rematch-readiness');
  await b.locator('.arena-controls [data-act=ready]').click();await c.locator('.arena-controls [data-act=ready]').click();
  await waitPhase(a,'selecting',1);
  assert.ok((await info(a)).room.players.every(p=>p.hp===1&&p.energy===0&&p.shields===0&&p.hammers===0&&p.guards===0&&p.bannedMove===null));
  assert.equal((await info(c)).room.leaderboard.find(p=>p.id===idA).wins,1,'重新开局保留胜场');
  for(const page of [a,b])await page.evaluate(async()=>{await fetch('/api/rooms/leave',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessionStorage.getItem('zaizai-token')},body:'{}'});});
  await waitPhase(c,'finished');
  assert.equal((await info(c)).room.lastMatch.winnerId,idC);
  // Join after a forfeit win, then the winner leaves: every remaining viewer keeps the locked outcome.
  for(const page of [a,b])await page.evaluate(async roomId=>{await fetch('/api/rooms/join',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessionStorage.getItem('zaizai-token')},body:JSON.stringify({roomId})});},roomId);
  await c.locator('[data-act=leave]').click();
  await a.locator('.final-winner').filter({hasText:'橘子测试 获胜'}).waitFor();
  assert.equal((await info(a)).room.lastMatch.winnerId,idC);
  await a.locator('[data-act=show-leaderboard]').click();
  assert.match(await a.locator('#modal .match-result').textContent(),/橘子测试 获胜/);
  await a.locator('#modal [data-act=close-modal]').click();
  await screenshot(a,'14-locked-winner-left');
  for(const page of [a,b])await page.locator('.arena-controls [data-act=ready]').click();
  await waitPhase(a,'selecting',1);
  await clickMove(a,'charge');await clickMove(b,'charge');
  await waitPhase(a,'selecting',2);
  await clickMove(a,'gun');await clickMove(b,'gun');
  await waitPhase(a,'reveal',2);
  room=(await info(a)).room;
  assert.ok(room.players.every(p=>p.hp===1&&p.energy===0),'枪对枪彼此抵消，消耗照扣且无人阵亡');
  assert.equal(room.result.hasDamage,false);assert.equal(room.result.finished,false);
  await a.locator('.arena-hud h2').filter({hasText:'无人受伤'}).waitFor();
  await screenshot(a,'17-equal-attacks-cancel');
  await waitPhase(a,'selecting',3);
  assert.ok((await info(a)).room.players.every(p=>p.hp===1),'抵消后继续下一回合');
  assert.deepEqual(errors,[],'浏览器无 JavaScript 或资源错误');
  console.log(JSON.stringify({ok:true,checks:['桌面与移动端同屏布局','所有视角自己居底、序号逆时针','8 人及全部 14 招式布局','精简选招区与底部局数居中','雪崩禁招选项过滤','战场内部左上排行榜与右下战报','两人自动选择对手、多人手动选目标','3 个独立浏览器实时同步','创建/加入/调整房间','准备状态及自动开局','仅展示可用招式','历史战报','流星锤亮招后封锁','伤害与阵亡禁用','刷新重连','胜利与房间胜场排行','重新准备与连续对局','胜者离房后结果保持不变','枪对枪抵消且继续对局','公开资源和雪崩禁招','亮招目标与金盾反弹信息'],screenshots:18,errors},null,2));
} finally {
  for(const page of pages) {
    try { await page.evaluate(async()=>{const token=sessionStorage.getItem('zaizai-token');if(token)await fetch('/api/rooms/leave',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}'});}); } catch {}
  }
  for(const context of contexts)await context.close();
  await browser.close();
}
