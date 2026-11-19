import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVES, validateAction, payCosts, resolveRound, applyAvalanche, automaticAction } from '../server/game.js';

const p = (id, options = {}) => ({ id, name: id.toUpperCase(), hp: 1, energy: 10, hammers: 3, shields: 3, seat: id.charCodeAt(0)-97, ...options });
const act = (move, target, reflect) => ({ move, ...(target ? { target } : {}), ...(reflect ? { reflect } : {}) });
const battle = (players, actions, interrupts) => resolveRound(payCosts(players, actions), actions, interrupts);
const get = (result, id) => result.players.find(p => p.id === id);

test('文档中 14 种招式均已定义', () => { assert.equal(Object.keys(MOVES).length, 14); });
test('验证目标、资源、阵亡和反弹类型，拒绝非法输入', () => {
  const players = [p('a', { energy: 0 }), p('b'), p('c', { hp: 0 })];
  assert.throws(() => validateAction(players, 'a', act('gun', 'b')), /不足/);
  assert.throws(() => validateAction(players, 'a', act('hammer', 'a')), /目标/);
  assert.throws(() => validateAction(players, 'a', act('hammer', 'c')), /目标/);
  assert.throws(() => validateAction(players, 'c', act('charge')), /阵亡/);
  assert.throws(() => validateAction(players, 'b', act('gold', null, 'meteor')), /反弹/);
  assert.throws(() => validateAction(players, 'b', act('gold', null, 'hammer')), /.+/);
  assert.throws(() => validateAction(players, 'b', act('__proto__')), /有效/);
  assert.deepEqual(validateAction(players, 'a', { move: 'charge', target: 'b', malicious: 1 }), { move: 'charge' });
});
test('仔积攒资源，锤积攒锤，圣盾积攒圣盾且扣仔', () => {
  const r = battle([p('a'), p('b'), p('c')], {a:act('charge'),b:act('hammer','a'),c:act('holy')});
  assert.equal(get(r,'a').energy,11);assert.equal(get(r,'b').hammers,4);assert.equal(get(r,'c').shields,4);assert.equal(get(r,'c').energy,9);
  assert.equal(r.hasDamage,false);
});
test('防抵挡枪和火球', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('guard'),b:act('gun','a'),c:act('fireball','a')});
  assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').hp,0);
});
test('锤敲防：有仔扣仔，无仔扣血；多锤按站位消耗后造成伤害', () => {
  const r=battle([p('a',{energy:1}),p('b'),p('c')],{a:act('guard'),b:act('hammer','a'),c:act('hammer','a')});
  assert.equal(get(r,'a').energy,0);assert.equal(get(r,'a').hp,0);assert.equal(r.hasDamage,true);
});
test('火球溅射目标和存活邻居，跳过死者，不自伤，不重复伤害', () => {
  const r=battle([p('a'),p('b',{hp:0}),p('c'),p('d'),p('e')],{a:act('fireball','c'),c:act('charge'),d:act('charge'),e:act('charge')});
  assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').hp,0);assert.equal(get(r,'c').hp,0);assert.equal(get(r,'d').hp,0);assert.equal(get(r,'e').hp,1);
});
test('两人火球为 2 点数，压制对射的枪', () => {
  const r=battle([p('a'),p('b')],{a:act('gun','b'),b:act('fireball','a')});
  assert.equal(get(r,'a').hp,0);assert.equal(get(r,'b').hp,1);assert.equal(r.winnerId,'b');
});
test('三人火球为 1 点数，与枪互攻抵消', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('gun','b'),b:act('fireball','a'),c:act('guard')});
  assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').hp,1);assert.equal(get(r,'c').hp,1);assert.equal(r.hasDamage,false);
});
test('天使没有生命上限；治疗与伤害同时结算', () => {
  const r=battle([p('a'),p('b')],{a:act('angel'),b:act('gun','a')});
  assert.equal(get(r,'a').hp,1);
  const r2=battle([p('a',{hp:80}),p('b')],{a:act('angel'),b:act('charge')});
  assert.equal(get(r2,'a').hp,81);
});
test('地震群攻 2 伤害，锤免疫地震和海浪', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('quake'),b:act('hammer','a'),c:act('charge')});
  assert.equal(get(r,'b').hp,1);assert.equal(get(r,'c').hp,-1);assert.equal(get(r,'a').energy,6);
});
test('更低点数的攻击只对压制者失效，仍伤害其他目标', () => {
  const r=battle([p('a',{hp:5}),p('b',{hp:5}),p('c',{hp:5})],{a:act('quake'),b:act('fireball','a'),c:act('charge')});
  assert.equal(get(r,'a').hp,5);assert.equal(get(r,'b').hp,3);assert.equal(get(r,'c').hp,2);
});
test('黑天使穿圣盾，恢复生命，以 4 点数压制地震', () => {
  const r=battle([p('a'),p('b')],{a:act('darkAngel','b'),b:act('holy')});
  assert.equal(get(r,'a').hp,2);assert.equal(get(r,'b').hp,0);
  const r2=battle([p('a'),p('b')],{a:act('darkAngel','b'),b:act('quake')});
  assert.equal(get(r2,'a').hp,2);assert.equal(get(r2,'b').hp,0);
});
test('圣盾挡住地震、海浪、火球；金盾猜错不防御', () => {
  for(const move of ['quake','wave','fireball']) {
    const r=battle([p('a'),p('b')],{a:act('holy'),b:act(move,'a')});
    assert.equal(get(r,'a').hp,1,move);
  }
  const r=battle([p('a'),p('b')],{a:act('gold',null,'fireball'),b:act('gun','a')});
  assert.equal(get(r,'a').hp,0);
});
test('金盾反弹匹配攻击，反弹不无限循环', () => {
  const r=battle([p('a'),p('b')],{a:act('gold',null,'gun'),b:act('gun','a')});
  assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').hp,0);
  const r2=battle([p('a'),p('b')],{a:act('gold',null,'darkAngel'),b:act('darkAngel','a')});
  assert.equal(get(r2,'a').hp,1);assert.equal(get(r2,'b').hp,1);
});
test('海浪消耗圣盾并群攻；明确的火球反弹优先于点数压制', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('wave'),b:act('fireball','a'),c:act('charge')});
  assert.equal(get(r,'a').shields,0);assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').hp,-1);assert.equal(get(r,'c').hp,-1);
  assert.ok(r.logs.some(log=>log.type==='reflect'&&log.source==='a'&&log.target==='b'));
});
test('流星锤破圣盾和金盾，其他玩家不受破盾伤害', () => {
  const r=battle([p('a'),p('b'),p('c'),p('d')],{a:act('meteor'),b:act('holy'),c:act('gold',null,'gun'),d:act('charge')});
  assert.equal(get(r,'a').hammers,0);assert.equal(get(r,'b').hp,0);assert.equal(get(r,'c').hp,0);assert.equal(get(r,'d').hp,1);
});
test('流星锤抵挡地震海浪；可以封锁攻击，消耗照扣', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('meteor'),b:act('quake'),c:act('wave')},{a:'b'});
  assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').energy,6);assert.equal(get(r,'b').hp,0);assert.equal(get(r,'c').hp,1);
  assert.deepEqual(r.muted,['b']);
});
test('封锁圣盾：支付资源但既不产生盾也不阻挡其他伤害', () => {
  const r=battle([p('a'),p('b',{hp:5}),p('c')],{a:act('meteor'),b:act('holy'),c:act('gun','b')},{a:'b'});
  assert.equal(get(r,'b').energy,9);assert.equal(get(r,'b').shields,3);assert.equal(get(r,'b').hp,4);
});
test('流星锤可封锁自己；消耗锤但不会造成破盾伤害', () => {
  const r=battle([p('a'),p('b')],{a:act('meteor'),b:act('holy')},{a:'a'});
  assert.equal(get(r,'a').hammers,0);assert.equal(get(r,'b').hp,1);assert.equal(get(r,'b').shields,4);
});
test('多个流星锤同时封锁，不因互相封锁而产生顺序偏差', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('meteor'),b:act('meteor'),c:act('holy')},{a:'b',b:'a'});
  assert.deepEqual(r.muted,['b','a']);assert.equal(get(r,'c').hp,1);assert.equal(get(r,'a').hammers,0);assert.equal(get(r,'b').hammers,0);
});
test('同时全部阵亡为平局，死亡不抹除同时发出的攻击', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('gun','b'),b:act('gun','c'),c:act('gun','a')});
  assert.equal(r.finished,true);assert.equal(r.winnerId,null);assert.ok(r.players.every(p=>p.hp===0));
});
test('结算不修改传入数据', () => {
  const players=[p('a'),p('b')],actions={a:act('gun','b'),b:act('charge')};
  const before=structuredClone({players,actions});battle(players,actions);assert.deepEqual({players,actions},before);
});
test('目标在锁定后弃权，不导致火球结算崩溃或攻击错误玩家', () => {
  const r=battle([p('a'),p('b',{hp:0,left:true}),p('c')],{a:act('fireball','b'),b:act('charge'),c:act('charge')});
  assert.equal(get(r,'a').energy,8);assert.equal(get(r,'a').hp,1);assert.equal(get(r,'c').hp,1);assert.equal(r.hasDamage,false);
});


test('fireball power is fixed when an action is submitted', () => {
  const players = [p('a', { hp: 5 }), p('b'), p('c', { hp: 5 })];
  const fireball = validateAction(players, 'a', act('fireball', 'c'));
  assert.equal(fireball.power, 1);
  const remaining = [players[0], { ...players[1], hp: 0, left: true }, players[2]];
  const result = battle(remaining, { a: fireball, c: act('quake') });
  assert.equal(get(result, 'a').hp, 3);
  assert.equal(get(result, 'c').hp, 5);

  const duel = [p('a'), p('b')];
  assert.equal(validateAction(duel, 'a', act('fireball', 'b')).power, 2);
});


test('防记录独立资源；雪崩必须有 3 个防并准确消耗', () => {
  const players=[p('a',{guards:2}),p('b')];
  assert.throws(()=>validateAction(players,'a',act('avalanche')),/防不足/);
  assert.throws(()=>validateAction([p('a',{guards:undefined}),p('b')],'a',act('avalanche')),/防不足/);
  const guarded=battle(players,{a:act('guard'),b:act('guard')});
  assert.equal(get(guarded,'a').guards,3);
  assert.equal(guarded.changes.a.guards,1);
  const action=validateAction(guarded.players,'a',act('avalanche'));
  const result=battle(guarded.players,{a:action,b:act('charge')});
  assert.equal(get(result,'a').guards,0);
  assert.equal(get(result,'b').energy,11,'施放本回合仍正常执行仔');
  assert.equal(get(result,'b').bannedMove,undefined,'结算不提前应用下一回合限制');
  assert.deepEqual(result.avalanche.bans,{a:'guard',b:'charge'});
});

test('雪崩禁招由服务器验证；新雪崩整体覆盖旧禁招，未施放时持续保留', () => {
  const first=battle([p('a',{guards:3}),p('b',{guards:3}),p('c')],{a:act('avalanche'),b:act('charge'),c:act('holy')});
  const restricted=applyAvalanche(first.players,first.avalanche);
  assert.throws(()=>validateAction(restricted,'a',act('guard')),/雪崩/);
  assert.throws(()=>validateAction(restricted,'b',act('charge')),/雪崩/);
  assert.throws(()=>validateAction(restricted,'c',act('holy')),/雪崩/);
  const ordinary=battle(restricted,{a:act('charge'),b:act('guard'),c:act('charge')});
  assert.equal(ordinary.avalanche,null);
  assert.deepEqual(ordinary.players.map(p=>p.bannedMove),['guard','charge','holy']);
  const second=battle(ordinary.players,{a:act('charge'),b:act('avalanche'),c:act('guard')});
  const replaced=applyAvalanche(second.players,second.avalanche);
  assert.deepEqual(replaced.map(p=>p.bannedMove),['charge','guard','guard']);
  assert.equal(validateAction(replaced,'a',act('guard')).move,'guard');
  assert.equal(validateAction(replaced,'b',act('charge')).move,'charge');
  assert.equal(validateAction(replaced,'c',act('holy')).move,'holy');
  assert.deepEqual(restricted.map(p=>p.bannedMove),['guard','charge','holy'],'不修改旧快照');
});

test('流星锤封锁雪崩：资源照扣但不覆盖；封锁防不积累防', () => {
  const r=battle([p('a',{guards:3,bannedMove:'gun'}),p('b'),p('c',{guards:1})],{a:act('avalanche'),b:act('meteor'),c:act('guard')},{b:'a'});
  assert.equal(get(r,'a').guards,0);assert.equal(r.avalanche,null);
  assert.equal(get(r,'a').bannedMove,'gun');
  assert.equal(get(r,'c').guards,2);
  const mutedGuard=battle([p('a'),p('b',{guards:1})],{a:act('meteor'),b:act('guard')},{a:'b'});
  assert.equal(get(mutedGuard,'b').guards,1);
  assert.equal(mutedGuard.changes.b.guards,0);
});

test('雪崩记录其他玩家宣告招式，即使该招式被封锁', () => {
  const r=battle([p('a',{guards:3}),p('b'),p('c')],{a:act('avalanche'),b:act('charge'),c:act('meteor')},{c:'b'});
  assert.deepEqual(r.avalanche.bans,{a:'guard',b:'charge',c:'meteor'});
  assert.equal(get(r,'b').energy,10);
});

test('多个雪崩同时覆盖，施放顺序不会改变结果', () => {
  const players=[p('a',{guards:3}),p('b',{guards:3}),p('c')];
  const actions={a:act('avalanche'),b:act('avalanche'),c:act('charge')};
  const first=battle(players,actions),second=battle([...players].reverse(),actions);
  assert.deepEqual(first.avalanche.bans,{a:'guard',b:'guard',c:'charge'});
  assert.deepEqual(first.avalanche.bans,second.avalanche.bans);
  assert.equal(get(first,'a').guards,0);assert.equal(get(first,'b').guards,0);
});

test('雪崩施放者同时阵亡仍施加限制；防被锤击阵亡仍积累防', () => {
  const r=battle([p('a',{guards:3}),p('b'),p('c')],{a:act('avalanche'),b:act('gun','a'),c:act('charge')});
  assert.equal(get(r,'a').hp,0);
  assert.deepEqual(r.avalanche.bans,{a:'guard',b:'gun',c:'charge'});
  const guarded=battle([p('a',{energy:0,guards:2}),p('b')],{a:act('guard'),b:act('hammer','a')});
  assert.equal(get(guarded,'a').hp,0);assert.equal(get(guarded,'a').guards,3);
});

test('超时自动行动始终遵守雪崩限制，仔被禁时改用防', () => {
  for(const bannedMove of [null,...Object.keys(MOVES)]){
    const players=[p('a',{energy:0,guards:0,bannedMove}),p('b')];
    const action=automaticAction(players,'a');
    assert.equal(action.move,bannedMove==='charge'?'guard':'charge');
    assert.notEqual(action.move,bannedMove);
    assert.equal(action.automatic,true);
    assert.equal(validateAction(players,'a',action).move,action.move);
  }
});


test('锤带盾消耗一个圣盾，需要有效目标；不积累锤或防', () => {
  const players=[p('a',{shields:1,hammers:2,guards:2}),p('b',{energy:1})];
  assert.throws(()=>validateAction([p('a',{shields:0}),p('b')],'a',act('shieldHammer','b')),/圣盾不足/);
  for(const target of [undefined,'a','missing']){
    assert.throws(()=>validateAction(players,'a',act('shieldHammer',target)),/目标/);
  }
  assert.throws(()=>validateAction([players[0],p('b',{hp:0})],'a',act('shieldHammer','b')),/目标/);
  const action=validateAction(players,'a',act('shieldHammer','b'));
  assert.deepEqual(action,{move:'shieldHammer',target:'b'});
  const r=battle(players,{a:action,b:act('guard')});
  assert.equal(get(r,'a').shields,0);
  assert.equal(get(r,'a').hammers,2);assert.equal(get(r,'a').guards,2);
  assert.equal(r.changes.a.hammers,0);assert.equal(r.changes.a.guards,0);
  assert.equal(get(r,'b').energy,0);assert.equal(get(r,'b').hp,1);
  assert.ok(r.logs.some(l=>l.type==='drain'&&l.text.includes('锤带盾')));
});

test('锤带盾同时抵挡枪、火球、地震和海浪；不能抵挡黑天使', () => {
  const players=['a','b','c','d','e'].map(id=>p(id,{hp:6}));
  const r=battle(players,{a:act('shieldHammer','b'),b:act('gun','a'),c:act('fireball','a'),d:act('quake'),e:act('wave')});
  assert.equal(get(r,'a').hp,6);
  assert.equal(r.logs.filter(l=>l.type==='block'&&l.target==='a').length,4);
  const dark=battle([p('a',{hp:3}),p('b')],{a:act('shieldHammer','b'),b:act('darkAngel','a')});
  assert.equal(get(dark,'a').hp,2);
});

test('多把锤与锤带盾攻击同一防或锤带盾，每次分别扣仔，耗尽后分别扣血', () => {
  for(const move of ['guard','shieldHammer']){
    for(const energy of [0,1,2,3,5]){
      const r=battle([p('a',{hp:5,energy,guards:0}),p('b'),p('c'),p('d')],{
        a:act(move,'b'),b:act('hammer','a'),c:act('shieldHammer','a'),d:act('hammer','a'),
      });
      assert.equal(get(r,'a').energy,Math.max(0,energy-3),move+' energy '+energy);
      assert.equal(get(r,'a').hp,5-Math.max(0,3-energy),move+' hp '+energy);
      assert.equal(r.changes.a.energy,energy===0?0:-Math.min(energy,3));
      assert.equal(r.changes.a.damage,Math.max(0,3-energy));
      assert.equal(r.logs.filter(l=>l.type==='drain').length,Math.min(energy,3));
      assert.equal(get(r,'a').guards,move==='guard'?1:0);
    }
  }
});

test('两名锤带盾可以互相锤击，其他招式不受其锤击效果影响', () => {
  const duel=battle([p('a',{hp:3,energy:0}),p('b',{hp:3,energy:0})],{a:act('shieldHammer','b'),b:act('shieldHammer','a')});
  assert.equal(get(duel,'a').hp,2);assert.equal(get(duel,'b').hp,2);
  for(const move of ['charge','hammer','holy','gold','angel']){
    const r=battle([p('a'),p('b')],{a:act('shieldHammer','b'),b:act(move,'a','gun')});
    assert.equal(r.changes.b.damage,0,move);
    assert.equal(r.changes.b.energy,move==='charge'?1:0,move);
  }
});

test('流星锤封锁锤带盾时消耗照扣，锤击与两类防御均失效', () => {
  const r=battle([p('a',{hp:5,guards:0}),p('b'),p('c'),p('d')],{
    a:act('shieldHammer','b'),b:act('guard'),c:act('meteor'),d:act('quake'),
  },{c:'a'});
  assert.equal(get(r,'a').shields,2);
  assert.equal(get(r,'a').hp,3);
  assert.equal(get(r,'b').energy,10,'封锁后不再锤击对方');
  assert.equal(get(r,'a').hammers,3);assert.equal(get(r,'a').guards,0);
  const gun=battle([p('a',{hp:5}),p('b'),p('c')],{
    a:act('shieldHammer','b'),b:act('gun','a'),c:act('meteor'),
  },{c:'a'});
  assert.equal(get(gun,'a').hp,4);
  const normal=battle([p('a'),p('b')],{a:act('shieldHammer','b'),b:act('meteor')});
  assert.equal(get(normal,'a').hp,1,'锤带盾不视为圣盾或金盾，不触发流星锤破盾');
});

test('锤带盾是独立招式：雪崩禁锤或防时仍可出，禁锤带盾时不可出', () => {
  for(const bannedMove of ['hammer','guard']){
    assert.equal(validateAction([p('a',{bannedMove}),p('b')],'a',act('shieldHammer','b')).move,'shieldHammer');
  }
  assert.throws(()=>validateAction([p('a',{bannedMove:'shieldHammer'}),p('b')],'a',act('shieldHammer','b')),/雪崩/);
  const r=battle([p('a',{guards:3}),p('b')],{a:act('avalanche'),b:act('shieldHammer','a')});
  assert.equal(r.avalanche.bans.b,'shieldHammer');
});

test('锤带盾目标锁定后离房，仍扣圣盾且保留自身防御', () => {
  const r=battle([p('a'),p('b',{hp:0,left:true}),p('c')],{a:act('shieldHammer','b'),c:act('quake')});
  assert.equal(get(r,'a').shields,2);assert.equal(get(r,'a').hp,1);
});


test('所有同点数互攻彼此抵消：枪、火球、地震、海浪、黑天使', () => {
  for(const move of ['gun','fireball','quake','wave','darkAngel']){
    const players=[p('a',{hp:3}),p('b',{hp:3})];
    const actions={a:validateAction(players,'a',act(move,'b')),b:validateAction(players,'b',act(move,'a'))};
    const r=battle(players,actions);
    assert.equal(r.hasDamage,false,move);
    assert.ok(r.players.every(p=>p.hp===(move==='darkAngel'?4:3)),move);
    assert.ok(r.players.every(p=>r.changes[p.id].damage===0),move);
    assert.equal(r.finished,false,move);
    assert.equal(r.logs.filter(l=>l.type==='clash'&&l.text.includes('抵消')).length,2,move);
    for(const [resource,cost] of Object.entries(MOVES[move].cost)){
      for(const player of players)assert.equal(get(r,player.id)[resource],player[resource]-cost,move);
    }
  }
});

test('地震与海浪同为 3 点数，互相抵消但仍分别伤害第三方', () => {
  for(const order of [['a','b','c'],['c','b','a']]){
    const r=battle(order.map(id=>p(id,{hp:5})),{a:act('quake'),b:act('wave'),c:act('charge')});
    assert.equal(get(r,'a').hp,5);assert.equal(get(r,'b').hp,5);assert.equal(get(r,'c').hp,2);
    assert.equal(r.changes.c.damage,3);
  }
});

test('三人火球与枪同点数只抵消彼此，火球对其他目标仍生效', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('gun','b'),b:act('fireball','a'),c:act('charge')});
  assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').hp,1);assert.equal(get(r,'c').hp,0);
});

test('被流星锤封锁的同点数攻击不能抵消对手攻击，资源仍照扣', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('gun','b'),b:act('gun','a'),c:act('meteor')},{c:'b'});
  assert.equal(get(r,'a').hp,1);assert.equal(get(r,'b').hp,0);
  assert.equal(get(r,'a').energy,9);assert.equal(get(r,'b').energy,9);
  assert.ok(!r.logs.some(l=>l.type==='clash'));
});


test('流星锤封锁圣盾或金盾后不破盾；封锁自己也不攻击，跳过则仍破盾', () => {
  for(const move of ['holy','gold']){
    const players=[p('a'),p('b')],actions={a:act('meteor'),b:act(move,null,'gun')};
    for(const target of ['a','b']){
      const r=battle(players,actions,{a:target});
      assert.equal(get(r,'b').hp,1,move+' muted '+target);
      assert.equal(r.hasDamage,false);
      assert.equal(get(r,'a').hammers,0);
      assert.equal(get(r,'b').energy,9);
      assert.equal(get(r,'b').shields,move==='holy'&&target==='a'?4:3);
    }
    assert.equal(get(battle(players,actions),'b').hp,0,move+' active');
  }
});

test('被任意流星锤封锁的盾不会触发其他流星锤的破盾伤害', () => {
  const r=battle([p('a'),p('b'),p('c')],{a:act('meteor'),b:act('meteor'),c:act('holy')},{a:'c',b:null});
  assert.equal(get(r,'c').hp,1);assert.equal(get(r,'c').shields,3);
  assert.equal(r.changes.c.damage,0);assert.equal(r.hasDamage,false);
});

test('天使和黑天使的当回合总伤害封顶 1，单次 2 伤害与多来源也合并封顶', () => {
  for(const move of ['angel','darkAngel']){
    for(const order of [['a','b','c','d','e'],['e','d','c','b','a']]){
      const players=order.map(id=>p(id,{hp:6}));
      const r=battle(players,{a:act(move,'e'),b:act('quake'),c:act('gun','a'),d:act('wave'),e:act('charge')});
      assert.equal(get(r,'a').hp,6,move);
      assert.equal(r.changes.a.damage,1);assert.equal(r.changes.a.healing,1);
      assert.equal(r.logs.filter(l=>l.type==='damage'&&l.target==='a').reduce((n,l)=>n+l.amount,0),1);
      assert.ok(r.logs.some(l=>l.type==='block'&&l.target==='a'));
    }
  }
});

test('黑天使反弹伤害和其他攻击共同计入 1 点上限；无伤时治疗照常', () => {
  const r=battle([p('a',{hp:4}),p('b'),p('c')],{a:act('darkAngel','b'),b:act('gold',null,'darkAngel'),c:act('quake')});
  assert.equal(r.changes.a.damage,1);assert.equal(get(r,'a').hp,4);
  for(const move of ['angel','darkAngel']){
    const healed=battle([p('a',{hp:4}),p('b')],{a:act(move,'b'),b:act('charge')});
    assert.equal(healed.changes.a.damage,0);assert.equal(get(healed,'a').hp,5);
  }
});

test('天使或黑天使被封锁后不治疗、也没有伤害上限保护', () => {
  for(const move of ['angel','darkAngel']){
    const r=battle([p('a',{hp:6}),p('b'),p('c'),p('d')],{a:act(move,'c'),b:act('meteor'),c:act('quake'),d:act('gun','a')},{b:'a'});
    assert.equal(r.changes.a.healing,0);assert.equal(r.changes.a.damage,3);
    assert.equal(get(r,'a').hp,3);assert.equal(get(r,'a').energy,move==='angel'?7:5);
  }
});
