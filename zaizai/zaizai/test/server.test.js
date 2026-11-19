import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server/index.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('联机服务：身份、权限、2–8 人房间、招式保密、阵亡、展示时长和重新准备', { timeout: 45000 }, async t => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  const clients = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  async function request(route, token, body) {
    const response = await fetch(base + '/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function client(name) {
    const { data } = await request('/session', null, { name });
    const controller = new AbortController(); controllers.push(controller);
    const stream = await fetch(base + '/api/events?token=' + data.token, { signal: controller.signal });
    assert.match(stream.headers.get('content-type'), /event-stream/);
    const reader = stream.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /retry: 1500/);
    const c = { ...data, request: (route, body) => request(route, data.token, body), state: async () => (await request('/state', data.token)).data };
    clients.push(c);
    return c;
  }
  async function until(client, predicate, ms = 6500) {
    const start = Date.now();
    while (Date.now() - start < ms) { const state = await client.state(); if (predicate(state)) return state; await delay(35); }
    throw new Error('等待房间阶段超时');
  }
  const a = await client('仔仔');
  const b = await client('小蓝');
  const c = await client('橘子');
  assert.equal((await request('/state', 'bad-token')).status, 401);
  assert.equal((await a.request('/rooms/create', { capacity: 9 })).status, 400);
  assert.equal((await a.request('/rooms/create', { name: '测试竞技场', capacity: 3 })).status, 200);
  const id = (await a.state()).room.id;
  assert.equal((await b.request('/rooms/join', { roomId: id.toLowerCase() })).status, 200);
  assert.equal((await c.request('/rooms/join', { roomId: id })).status, 200);
  assert.equal((await b.request('/rooms/capacity', { capacity: 8 })).status, 400);
  assert.equal((await a.request('/rooms/capacity', { capacity: 2 })).status, 400);
  assert.equal((await a.request('/rooms/capacity', { capacity: 8 })).status, 200);
  assert.equal((await a.state()).room.capacity, 8);
  await a.request('/rooms/ready', {}); await b.request('/rooms/ready', {});
  assert.equal((await a.state()).room.phase, 'waiting');
  await c.request('/rooms/ready', {});
  const first = (await a.state()).room;
  assert.equal(first.phase, 'selecting'); assert.equal(first.round, 1);
  assert.ok(first.players.every(p => p.hp === 1 && p.energy === 0 && p.hammers === 0 && p.shields === 0));
  assert.equal((await a.request('/rooms/capacity', { capacity: 4 })).status, 400);
  assert.equal((await a.request('/game/action', { round: 1, move: 'gun', target: b.self.id })).status, 400);
  await a.request('/game/action', { round: 1, move: 'charge' });
  const secret = (await b.state()).room;
  assert.equal(secret.actions, null); assert.equal(secret.ownAction, null); assert.deepEqual(secret.submitted, [a.self.id]);
  assert.equal((await a.request('/game/action', { round: 1, move: 'guard' })).status, 400);
  await b.request('/game/action', { round: 1, move: 'charge' });
  await c.request('/game/action', { round: 1, move: 'charge' });
  const reveal1 = (await a.state()).room;
  assert.equal(reveal1.phase, 'reveal'); assert.equal(reveal1.result.hasDamage, false);
  assert.ok(reveal1.deadline - Date.now() <= 2000 && reveal1.deadline - Date.now() > 1500);
  await until(a, s => s.room.phase === 'selecting' && s.room.round === 2);
  assert.equal((await a.request('/game/action', { round: 1, move: 'charge' })).status, 400);
  await a.request('/game/action', { round: 2, move: 'gun', target: b.self.id });
  await b.request('/game/action', { round: 2, move: 'charge' });
  await c.request('/game/action', { round: 2, move: 'charge' });
  const reveal2 = (await a.state()).room;
  assert.equal(reveal2.result.hasDamage, true); assert.equal(reveal2.players.find(p => p.id === b.self.id).hp, 0);
  assert.ok(reveal2.deadline - Date.now() <= 5000 && reveal2.deadline - Date.now() > 4500);
  await until(a, s => s.room.phase === 'selecting' && s.room.round === 3);
  assert.equal((await b.request('/game/action', { round: 3, move: 'charge' })).status, 400);
  await a.request('/game/action', { round: 3, move: 'charge' });
  await c.request('/game/action', { round: 3, move: 'guard' });
  assert.equal((await a.state()).room.phase, 'reveal'); // Dead player is not awaited.
  await until(a, s => s.room.phase === 'selecting' && s.room.round === 4);
  await a.request('/game/action', { round: 4, move: 'gun', target: c.self.id });
  await c.request('/game/action', { round: 4, move: 'charge' });
  assert.equal((await a.state()).room.result.winnerId, a.self.id);
  const finished = await until(a, s => s.room.phase === 'finished');
  assert.ok(finished.room.players.every(p => p.ready === false));
  assert.equal(finished.room.lastMatch.winnerId,a.self.id);
  assert.equal(finished.room.lastMatch.winnerName,'仔仔');
  assert.equal(finished.room.leaderboard.find(p=>p.id===a.self.id).wins,1);
  assert.ok(finished.room.leaderboard.every(p=>p.games===1));
  await a.request('/rooms/ready', {}); await b.request('/rooms/ready', {});
  assert.equal((await a.state()).room.phase, 'finished');
  await c.request('/rooms/ready', {});
  const rematch = (await a.state()).room;
  assert.equal(rematch.phase, 'selecting'); assert.equal(rematch.round, 1);
  assert.ok(rematch.players.every(p => p.hp === 1 && p.energy === 0 && p.hammers === 0 && p.shields === 0));
  assert.equal(rematch.gameNumber,2);
  assert.ok(rematch.history.length>0,'新对局保留房间历史战报');
  assert.equal(rematch.leaderboard.find(p=>p.id===a.self.id).wins,1);
  await a.request('/rooms/leave', {});
  assert.equal((await b.state()).room.hostId, b.self.id);
  await b.request('/rooms/leave', {}); await c.request('/rooms/leave', {});
  const eight = [];
  for (let i = 0; i < 9; i++) eight.push(await client('玩家' + i));
  await eight[0].request('/rooms/create', { capacity: 8 });
  const room8 = (await eight[0].state()).room.id;
  for (let i = 1; i < 8; i++) assert.equal((await eight[i].request('/rooms/join', { roomId: room8 })).status, 200);
  assert.equal((await eight[8].request('/rooms/join', { roomId: room8 })).status, 400);
  assert.equal((await eight[0].state()).room.players.length, 8);
  for(let i=0;i<8;i++)await eight[i].request('/rooms/ready',{});
  assert.equal((await eight[0].state()).room.phase,'selecting');
  for(let i=0;i<8;i++)await eight[i].request('/game/action',{round:1,move:'charge'});
  const eightReveal=(await eight[7].state()).room;
  assert.equal(eightReveal.phase,'reveal');
  assert.equal(Object.keys(eightReveal.actions).length,8);
  assert.ok(eightReveal.players.every(p=>p.energy===1));
  for (const player of eight) await player.request('/rooms/leave', {});
});


test('polling clients cancel equal attacks, continue rounds and resolve shieldHammer', { timeout: 15000 }, async t => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = [];
  async function request(route, token, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  t.after(async () => {
    for (const token of tokens) await request('/rooms/leave', token, {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  for (const name of ['Polling A', 'Polling B']) {
    const client = await request('/session', null, { name });
    tokens.push(client.token);
    await request('/state?poll=1', client.token);
  }
  const [a, b] = tokens;
  await request('/rooms/create', a, { capacity: 2 });
  const roomId = (await request('/state?poll=1', a)).room.id;
  await request('/rooms/join', b, { roomId });
  const joined = await request('/state?poll=1', a);
  assert.equal(joined.room.players.length, 2);
  assert.ok(joined.room.players.every(player => player.connected));
  await request('/rooms/ready', a, {});
  assert.equal((await request('/state?poll=1', b)).room.players[0].ready, true);
  await request('/rooms/ready', b, {});
  assert.equal((await request('/state?poll=1', a)).room.phase, 'selecting');
  await request('/game/action', a, { round: 1, move: 'charge' });
  const secret = await request('/state?poll=1', b);
  assert.equal(secret.room.actions, null);
  assert.equal(secret.room.submitted.length, 1);
  await request('/game/action', b, { round: 1, move: 'charge' });
  const revealed = await request('/state?poll=1', a);
  assert.equal(revealed.room.phase, 'reveal');
  assert.ok(revealed.room.players.every(player => player.energy === 1));

  async function nextRound(round) {
    const end=Date.now()+4000;
    while(Date.now()<end){
      const room=(await request('/state?poll=1',a)).room;
      if(room.phase==='selecting'&&room.round===round)return room;
      await delay(25);
    }
    throw Error('等待锤带盾测试回合超时');
  }
  await nextRound(2);
  await request('/game/action',a,{round:2,move:'gun',target:secret.self.id});
  await request('/game/action',b,{round:2,move:'gun',target:joined.self.id});
  const cancelled=(await request('/state?poll=1',a)).room;
  assert.equal(cancelled.phase,'reveal');
  assert.equal(cancelled.result.hasDamage,false);
  assert.equal(cancelled.result.finished,false);
  assert.equal(cancelled.lastMatch,null);
  assert.ok(cancelled.players.every(p=>p.hp===1&&p.energy===0));
  assert.ok(cancelled.result.logs.some(l=>l.type==='clash'&&l.text.includes('抵消')));
  assert.ok(cancelled.deadline-Date.now()>1500&&cancelled.deadline-Date.now()<=2000);
  await nextRound(3);
  for(const token of [a,b])await request('/game/action',token,{round:3,move:'charge'});
  await nextRound(4);
  for(const token of [a,b])await request('/game/action',token,{round:4,move:'holy'});
  await nextRound(5);
  await request('/game/action',a,{round:5,move:'shieldHammer',target:secret.self.id});
  await request('/game/action',b,{round:5,move:'hammer',target:joined.self.id});
  const combined=(await request('/state?poll=1',a)).room;
  const caster=combined.players.find(p=>p.id===joined.self.id);
  assert.equal(combined.phase,'reveal');
  assert.equal(caster.shields,0);assert.equal(caster.hammers,0);assert.equal(caster.guards,0);
  assert.equal(caster.hp,0,'锤带盾在无仔时被普通锤扣血');
  assert.equal(combined.result.winnerId,secret.self.id);

});


test('雪崩联机：下一回合禁招、覆盖、持久化、施放者离房和新局清空', { timeout: 40000 }, async t => {
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port+'/api',clients=[];
  async function request(route,token,body,status=200){
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
  }
  t.after(async()=>{
    for(const c of clients)await request('/rooms/leave',c.token,{});
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  });
  for(const name of ['雪崩甲','雪崩乙','雪崩丙']){
    const client=await request('/session',null,{name});clients.push(client);
    await request('/state?poll=1',client.token);
  }
  const [a,b,c]=clients;
  const state=async client=>(await request('/state?poll=1',client.token)).room;
  const post=(client,route,body={},status=200)=>request(route,client.token,body,status);
  const player=(room,client)=>room.players.find(p=>p.id===client.self.id);
  async function selecting(round){
    const deadline=Date.now()+6500;
    while(Date.now()<deadline){const room=await state(a);if(room.phase==='selecting'&&room.round===round)return room;await delay(30);}
    throw Error('雪崩测试等待回合超时 '+round);
  }
  async function turn(round,moves){
    await selecting(round);
    for(const [i,move] of moves.entries())await post(clients[i],'/game/action',{round,move});
    return state(a);
  }
  await post(a,'/rooms/create',{capacity:3});const roomId=(await state(a)).id;
  await post(b,'/rooms/join',{roomId});await post(c,'/rooms/join',{roomId});
  for(const client of clients)await post(client,'/rooms/ready');
  assert.ok((await state(a)).players.every(p=>p.guards===0&&p.bannedMove===null));
  for(let round=1;round<=3;round++){
    const room=await turn(round,['guard','guard','guard']);
    assert.ok(room.players.every(p=>p.guards===round));
  }
  let room=await turn(4,['avalanche','charge','guard']);
  assert.equal(player(room,a).guards,0);assert.equal(player(room,b).energy,1);
  assert.ok(room.players.every(p=>p.bannedMove===null),'展示阶段本回合不提前禁招');
  assert.ok(room.history[0].logs.some(l=>l.type==='avalanche'));
  room=await selecting(5);
  assert.deepEqual(room.players.map(p=>p.bannedMove),['guard','charge','guard']);
  await post(a,'/game/action',{round:5,move:'guard'},400);
  await post(b,'/game/action',{round:5,move:'charge'},400);
  room=await turn(5,['charge','guard','avalanche']);
  assert.equal(player(room,b).guards,4);
  assert.equal(player(room,c).guards,1);
  assert.deepEqual(room.players.map(p=>p.bannedMove),['guard','charge','guard'],'覆盖也从下一回合开始');
  room=await selecting(6);
  assert.deepEqual(room.players.map(p=>p.bannedMove),['charge','guard','guard']);
  await post(b,'/game/action',{round:6,move:'guard'},400);
  room=await turn(6,['guard','charge','charge']);
  room=await selecting(7);
  assert.deepEqual(room.players.map(p=>p.bannedMove),['charge','guard','guard'],'没有新雪崩则持续生效');
  await post(c,'/rooms/leave');
  room=await state(a);
  assert.equal(player(room,a).bannedMove,'charge','施放者离房后限制仍在');
  assert.equal(player(room,b).bannedMove,'guard');
  await post(a,'/game/action',{round:7,move:'hammer',target:b.self.id});
  await post(b,'/game/action',{round:7,move:'gun',target:a.self.id});
  const deadline=Date.now()+6500;
  while((await state(a)).phase!=='finished'){assert.ok(Date.now()<deadline);await delay(30);}
  await post(a,'/rooms/ready');await post(b,'/rooms/ready');
  room=await state(a);assert.equal(room.gameNumber,2);assert.equal(room.round,1);
  assert.ok(room.players.every(p=>p.guards===0&&p.bannedMove===null&&p.energy===0));
});


test('流星锤联机：封锁对方圣盾后不破盾，双方均不受伤', {timeout:18000}, async t=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port+'/api',clients=[];
  async function req(route,token,body){
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
  }
  t.after(async()=>{for(const c of clients)await req('/rooms/leave',c.token,{});server.closeAllConnections();await new Promise(r=>server.close(r));});
  for(const name of ['流星','圣盾']){const c=await req('/session',null,{name});clients.push(c);await req('/state?poll=1',c.token);}
  const [a,b]=clients,post=(c,route,body={})=>req(route,c.token,body),state=async()=>(await req('/state?poll=1',a.token)).room;
  await post(a,'/rooms/create',{capacity:2});const roomId=(await state()).id;
  await post(b,'/rooms/join',{roomId});await post(a,'/rooms/ready');await post(b,'/rooms/ready');
  async function wait(phase,round){
    const end=Date.now()+4000;
    while(Date.now()<end){const room=await state();if(room.phase===phase&&room.round===round)return room;await delay(25);}
    throw Error('等待流星锤阶段超时');
  }
  for(let round=1;round<=3;round++){
    await wait('selecting',round);
    await post(a,'/game/action',{round,move:'hammer',target:b.self.id});
    await post(b,'/game/action',{round,move:'charge'});
  }
  await wait('selecting',4);
  await post(a,'/game/action',{round:4,move:'meteor'});
  await post(b,'/game/action',{round:4,move:'holy'});
  await wait('interrupt',4);
  await post(a,'/game/interrupt',{round:4,target:b.self.id});
  const room=await wait('reveal',4);
  assert.ok(room.players.every(p=>p.hp===1));
  assert.equal(room.players.find(p=>p.id===b.self.id).shields,0);
  assert.equal(room.result.hasDamage,false);assert.equal(room.result.finished,false);
});

test('选招默认 15 秒，超时自动出招后正常进入结算', {timeout:21000}, async t=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port+'/api',clients=[];
  async function req(route,token,body){
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,200);return data;
  }
  t.after(async()=>{for(const c of clients)await req('/rooms/leave',c.token,{});server.closeAllConnections();await new Promise(r=>server.close(r));});
  for(const name of ['超时甲','超时乙']){const c=await req('/session',null,{name});clients.push(c);await req('/state?poll=1',c.token);}
  const [a,b]=clients;
  await req('/rooms/create',a.token,{capacity:2});
  const state=async()=>(await req('/state?poll=1',a.token)).room;
  const roomId=(await state()).id;await req('/rooms/join',b.token,{roomId});
  await req('/rooms/ready',a.token,{});await req('/rooms/ready',b.token,{});
  const first=await state(),start=Date.now();
  assert.ok(first.deadline-start<=15000&&first.deadline-start>14000);
  let room;
  while(Date.now()-start<17500){room=await state();if(room.phase==='reveal')break;await delay(50);}
  assert.equal(room.phase,'reveal');assert.equal(room.round,1);
  assert.ok(Date.now()-start>=14000);
  assert.ok(Object.values(room.actions).every(a=>a.move==='charge'&&a.automatic));
  assert.ok(room.players.every(p=>p.energy===1));
});
