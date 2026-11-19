import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server/index.js';

test('多局胜场只累计一次，亮招后及结束后胜者离房不会改成平局，重进不丢胜场且序号唯一', {timeout:25000},async t=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`,controllers=[];
  t.after(async()=>{controllers.forEach(c=>c.abort());server.closeAllConnections();await new Promise(r=>server.close(r));});
  async function api(route,token,body){
    const response=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
  }
  async function client(name){
    const session=await api('/session',null,{name}),controller=new AbortController();controllers.push(controller);
    const stream=await fetch(base+'/api/events?token='+session.token,{signal:controller.signal});await stream.body.getReader().read();
    return {...session,post:(route,body={})=>api(route,session.token,body),state:async()=>(await api('/state',session.token)).room};
  }
  async function wait(player,phase,round){
    const deadline=Date.now()+6500;
    while(Date.now()<deadline){const room=await player.state();if(room?.phase===phase&&(!round||room.round===round))return room;await new Promise(r=>setTimeout(r,40));}
    throw new Error('等待阶段超时 '+phase);
  }
  const a=await client('胜者'),b=await client('乙'),c=await client('丙');
  await a.post('/rooms/create',{capacity:3});const roomId=(await a.state()).id;
  await b.post('/rooms/join',{roomId});await c.post('/rooms/join',{roomId});
  for(const p of [a,b,c])await p.post('/rooms/ready');
  for(const p of [a,b,c])await p.post('/game/action',{round:1,move:'charge'});
  await wait(a,'selecting',2);
  await a.post('/game/action',{round:2,move:'gun',target:b.self.id});
  await b.post('/game/action',{round:2,move:'charge'});
  await c.post('/game/action',{round:2,move:'gun',target:a.self.id});
  // c wins while a and b die in the same round. Lock immediately, before display timer.
  let room=await b.state();assert.equal(room.phase,'reveal');assert.equal(room.lastMatch.winnerId,c.self.id);
  assert.equal(room.leaderboard.find(p=>p.id===c.self.id).wins,1);
  const locked=structuredClone(room.lastMatch);
  await c.post('/rooms/leave');
  room=await wait(b,'finished');assert.deepEqual(room.lastMatch,locked);assert.equal(room.result.winnerId,c.self.id);
  assert.equal(room.result.winnerName,'丙');assert.equal(room.leaderboard.find(p=>p.id===c.self.id).wins,1);
  await c.post('/rooms/join',{roomId});
  for(const p of [a,b,c])await p.post('/rooms/ready');
  room=await a.state();assert.equal(room.gameNumber,2);assert.equal(room.lastMatch.winnerId,c.self.id);
  for(const p of [a,b,c])await p.post('/game/action',{round:1,move:'charge'});
  await wait(a,'selecting',2);
  await a.post('/game/action',{round:2,move:'gun',target:b.self.id});
  await b.post('/game/action',{round:2,move:'charge'});
  await c.post('/game/action',{round:2,move:'gun',target:a.self.id});
  room=await wait(b,'finished');assert.equal(room.leaderboard.find(p=>p.id===c.self.id).wins,2);
  assert.ok(room.leaderboard.every(p=>p.games===2));assert.ok(room.history.some(r=>r.gameNumber===1));
  await c.post('/rooms/leave');room=await b.state();assert.equal(room.result.winnerId,c.self.id);assert.equal(room.lastMatch.winnerName,'丙');
  assert.equal(room.leaderboard.find(p=>p.id===c.self.id).present,false);
  await b.post('/rooms/ready');assert.equal((await a.state()).players.find(p=>p.id===b.self.id).ready,true);
  await b.post('/rooms/ready');
  await a.post('/rooms/leave');
  const d=await client('丁');await d.post('/rooms/join',{roomId});
  room=await b.state();assert.equal(new Set(room.players.map(p=>p.seat)).size,room.players.length);
  assert.equal(room.players.find(p=>p.id===b.self.id).seat,1,'未离开的玩家保留原序号');
  assert.equal(room.lastMatch.winnerId,c.self.id);
  await b.post('/rooms/leave');await d.post('/rooms/leave');
});
