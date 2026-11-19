import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';

// Isolate browser checks from the live room and allow time for delayed requests.
process.env.SELECTION_MS='60000';
const { createServer }=await import('../server/index.js');
const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const local='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const errors=[];
async function snapshot(page){
  await page.evaluate(()=>{
    window.stableNodes=[document.querySelector('.arena'),document.querySelector('.battle-toolbar'),document.querySelector('[data-timer]'),...document.querySelectorAll('.seat[data-id],.seat .creature')];
    window.stableControls=document.querySelector('.arena-controls').firstElementChild;
    window.stableMove=document.querySelector('.move-card.selected');
    window.stableSelect=document.querySelector('#reflect-select');
    window.stableBubble=document.querySelector('.action-bubble.locked');
  });
}
async function stable(page,{controls=true,select=false,bubble=false}={}){
  assert.equal(await page.evaluate(()=>window.stableNodes.every(el=>el.isConnected)),true,'战场、头像、工具栏和计时器保持原节点');
  if(controls)assert.equal(await page.evaluate(()=>window.stableControls.isConnected),true,'中央控件没有重建');
  if(select)assert.equal(await page.evaluate(()=>window.stableSelect===document.querySelector('#reflect-select')&&document.activeElement===window.stableSelect),true,'下拉框保持节点与焦点');
  if(bubble)assert.equal(await page.evaluate(()=>window.stableBubble.isConnected),true,'已有锁定提示不重建、不重新播放动画');
}
async function post(page,path,body={}){
  return page.evaluate(async({path,body})=>{
    const r=await fetch('/api'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessionStorage.getItem('zaizai-token')},body:JSON.stringify(body)});
    return {status:r.status,data:await r.json()};
  },{path,body});
}
async function selecting(page,round){
  await page.waitForFunction(round=>state.room?.phase==='selecting'&&state.room.round===round,round);
}
try{
  for(const transport of ['sse','polling']){
    const contexts=[],pages=[];
    const base=transport==='sse'?local:'http://selection-sync.trycloudflare.com';
    try{
      for(let i=0;i<3;i++){
        const context=await browser.newContext({viewport:{width:1440,height:1050}});
        if(transport==='polling')await context.route(base+'/**',async route=>{
          const request=route.request(),headers={...request.headers()};
          if(headers.origin)headers.origin=local;
          delete headers.host;
          const response=await route.fetch({url:local+new URL(request.url()).pathname+new URL(request.url()).search,headers});
          await route.fulfill({response});
        });
        const page=await context.newPage();
        page.on('pageerror',e=>errors.push(e.message));
        contexts.push(context);pages.push(page);
        await page.goto(base);
        await page.getByLabel('临时昵称').fill('同步测试'+i);
        await page.getByRole('button',{name:'进入大厅'}).click();
        await page.getByRole('heading',{name:'游戏大厅'}).waitFor();
      }
      const [a,b,c]=pages;
      const created=await post(a,'/rooms/create',{capacity:3});assert.equal(created.status,200);
      await a.waitForFunction(()=>!!state.room);
      const roomId=await a.evaluate(()=>state.room.id);
      for(const page of [b,c])assert.equal((await post(page,'/rooms/join',{roomId})).status,200);
      for(const page of pages){await page.waitForFunction(()=>state.room?.players.length===3);await post(page,'/rooms/ready');}
      for(const page of pages)await selecting(page,1);
      const idA=await a.evaluate(()=>self.id),idC=await c.evaluate(()=>self.id);
      await a.locator('[data-act=move][data-id=charge]').click();
      await b.locator('[data-act=move][data-id=hammer]').click();
      await b.locator('.seat[data-id="'+idC+'"]').click();
      await snapshot(a);await snapshot(b);
      await a.locator('[data-act=submit-action]').click();
      await a.locator('.locked-selection').waitFor();
      await b.locator('.seat[data-id="'+idA+'"] .locked').waitFor();
      await stable(a,{controls:false});await stable(b);
      assert.equal(await b.evaluate(()=>window.stableMove===document.querySelector('.move-card.selected')),true,'他人锁定不改变选中招式');
      assert.equal(await b.locator('.seat.target-selected').getAttribute('data-id'),idC,'他人锁定不改变选中目标');
      await snapshot(a);await snapshot(b);
      let release;
      const gate=new Promise(r=>release=r);
      await b.route('**/api/game/action',async route=>{await gate;await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'模拟提交失败'})});});
      await b.locator('[data-act=submit-action]').click();
      await b.waitForFunction(()=>ui.busy);
      await stable(b);
      assert.equal(await b.locator('[data-act=submit-action]').isDisabled(),true,'提交中禁用锁定，防止重复提交');
      release();
      await b.waitForFunction(()=>!ui.busy);
      await stable(b);
      assert.equal(await b.locator('[data-act=submit-action]').isEnabled(),true,'提交失败恢复锁定按钮');
      await b.unroute('**/api/game/action');
      await b.locator('[data-act=submit-action]').click();
      await b.locator('.locked-selection').waitFor();
      await a.waitForFunction(()=>state.room.submitted.length===2);
      await stable(a,{bubble:true});await stable(b,{controls:false,bubble:true});
      await c.locator('[data-act=move][data-id=charge]').click();
      await c.locator('[data-act=submit-action]').click();
      for(const page of pages)await selecting(page,2);

      // Gold's native dropdown remains focused and keeps the chosen reflection.
      await a.locator('[data-act=move][data-id=gold]').click();
      await a.locator('#reflect-select').selectOption('fireball');
      await a.locator('#reflect-select').focus();
      await snapshot(a);
      await b.locator('[data-act=move][data-id=charge]').click();
      await b.locator('[data-act=submit-action]').click();
      await a.waitForFunction(()=>state.room.submitted.length===1);
      await stable(a,{select:true});
      assert.equal(await a.locator('#reflect-select').inputValue(),'fireball');
      assert.equal(await a.locator('.seat .locked').count(),1,'即使下拉框有焦点也即时显示他人锁定');
      let proceed;
      const ownGate=new Promise(r=>proceed=r);
      await a.route('**/api/game/action',async route=>{await ownGate;await route.fallback();});
      await a.locator('[data-act=submit-action]').click();
      await a.waitForFunction(()=>ui.busy);await stable(a);
      proceed();await a.locator('.locked-selection').waitFor();
      await stable(a,{controls:false});
      assert.match(await a.locator('.locked-selection').textContent(),/反弹：火球/);
      await c.locator('[data-act=move][data-id=charge]').click();
      await c.locator('[data-act=submit-action]').click();
      await selecting(a,3);
      assert.equal(await a.locator('.seat .locked').count(),0,'下一回合清除上回合锁定标记');
      assert.equal(await a.locator('[data-act=submit-action]').isDisabled(),true,'下一回合需要重新选择招式');
      console.log(transport+': passed other/self lock, target/dropdown preservation, failed retry, next round');
    }finally{
      for(const page of pages){try{await post(page,'/rooms/leave');}catch{}}
      for(const context of contexts)await context.close();
    }
  }
  assert.deepEqual(errors,[],'浏览器无 JavaScript 错误');
  console.log(JSON.stringify({ok:true,transports:['sse','polling'],errors}));
}finally{
  await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));
}
