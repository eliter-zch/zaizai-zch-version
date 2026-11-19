export const MOVES = Object.freeze({
  charge: { name: '仔', icon: '✦', cost: {}, description: '积蓄力量，获得 1 个仔。', color: 'mint' },
  guard: { name: '防', icon: '◇', cost: {}, description: '抵挡本回合的枪与火球，并获得 1 个防。', color: 'blue' },
  hammer: { name: '锤', icon: '⚒', cost: {}, target: true, description: '获得 1 个锤；敲击使用防或锤带盾的目标：有仔扣 1 仔，无仔扣 1 生命。抵挡地震与海浪。', color: 'amber' },
  shieldHammer: { name: '锤带盾', icon: '⚒', cost: { shields: 1 }, target: true, description: '抵挡枪、火球、地震和海浪；锤击使用防或锤带盾的目标：有仔扣 1 仔，无仔扣 1 生命。自己也会被锤击，不增加锤或防次数。', color: 'amber' },
  gun: { name: '枪', icon: '↗', cost: { energy: 1 }, target: true, attack: 1, description: '对一名目标造成 1 点伤害，攻击点数 1。', color: 'red' },
  fireball: { name: '火球', icon: '☄', cost: { energy: 2 }, target: true, attack: 1, description: '对目标及其左右存活邻居各造成 1 点伤害，不伤及自己。提交招式时两人存活则攻击点数为 2，否则为 1；本回合不再变化。', color: 'orange' },
  angel: { name: '天使', icon: '♡', cost: { energy: 3 }, description: '恢复 1 点生命，没有生命上限；本回合受到的总伤害至多 1 点。', color: 'pink' },
  quake: { name: '地震', icon: '⌁', cost: { energy: 4 }, attack: 3, description: '对所有其他存活玩家造成 2 点伤害，攻击点数 3。', color: 'amber' },
  darkAngel: { name: '黑天使', icon: '♜', cost: { energy: 5 }, target: true, attack: 4, description: '对一名目标造成 1 点伤害，自己恢复 1 生命，本回合受到的总伤害至多 1 点。攻击点数 4，穿透圣盾。', color: 'violet' },
  holy: { name: '圣盾', icon: '⬡', cost: { energy: 1 }, description: '抵挡除黑天使、流星锤破盾外的攻击，并获得 1 个圣盾。', color: 'blue' },
  gold: { name: '金盾', icon: '◈', cost: { energy: 1 }, reflect: true, description: '预判一种攻击，反弹本回合命中自己的该类攻击。不能反弹流星锤。', color: 'amber' },
  wave: { name: '海浪', icon: '≋', cost: { shields: 3 }, attack: 3, description: '对所有其他存活玩家造成 1 点伤害，反弹火球。攻击点数 3。', color: 'cyan' },
  meteor: { name: '流星锤', icon: '✹', cost: { hammers: 3 }, description: '抵挡地震、海浪；对仍生效的圣盾或金盾造成 1 伤害；封锁盾后不造成破盾伤害。亮招后可封锁任意一人的招式，资源照常消耗。', color: 'violet' },
  avalanche: { name: '雪崩', icon: '❄', cost: { guards: 3 }, description: '从下回合起，自己禁用防，其他玩家各自禁用本回合所选招式，直到新的雪崩覆盖限制。', color: 'cyan' },
});

export const REFLECTABLE = ['gun', 'fireball', 'quake', 'darkAngel', 'wave'];
export const RESOURCE_NAMES = { energy: '仔', hammers: '锤', shields: '圣盾', guards: '防' };

export function validateAction(players, playerId, action) {
  const player = players.find(p => p.id === playerId);
  if (!player || player.hp <= 0) throw new Error('你已阵亡，正在观战。');
  if (!action || !Object.hasOwn(MOVES, action.move)) throw new Error('请选择有效招式。');
  if (player.bannedMove === action.move) throw new Error('雪崩限制：不能使用「' + MOVES[action.move].name + '」。');
  const move = MOVES[action.move];
  for (const [resource, cost] of Object.entries(move.cost)) {
    if ((player[resource] ?? 0) < cost) throw new Error(`${RESOURCE_NAMES[resource]}不足。`);
  }
  if (move.target && !players.some(p => p.id === action.target && p.hp > 0 && p.id !== playerId)) {
    throw new Error('请选择另一名存活玩家作为目标。');
  }
  if (move.reflect && !REFLECTABLE.includes(action.reflect)) throw new Error('请选择金盾要反弹的攻击。');
  return {
    move: action.move,
    ...(move.target ? { target: action.target } : {}),
    ...(move.reflect ? { reflect: action.reflect } : {}),
    ...(action.move === 'fireball' ? { power: players.filter(p => p.hp > 0).length === 2 ? 2 : 1 } : {}),
  };
}

// Each avalanche replaces all restrictions at the next round boundary.
export function applyAvalanche(players, avalanche) {
  return players.map(p => ({ ...p, bannedMove: avalanche.bans[p.id] ?? null }));
}

export function automaticAction(players, playerId) {
  const player = players.find(p => p.id === playerId);
  return { ...validateAction(players, playerId, { move: player?.bannedMove === 'charge' ? 'guard' : 'charge' }), automatic: true };
}

// Charge all costs before interrupts. Muting cancels effects, never the cost.
export function payCosts(players, actions) {
  return players.map(p => {
    const next = { ...p };
    if (p.hp > 0 && actions[p.id]) {
      for (const [key, amount] of Object.entries(MOVES[actions[p.id].move].cost)) next[key] -= amount;
    }
    return next;
  });
}

export function resolveRound(paidPlayers, actions, interrupts = {}) {
  const players = paidPlayers.map(p => ({ ...p, guards: p.guards ?? 0 }));
  const alive = players.filter(p => p.hp > 0);
  const byId = new Map(players.map(p => [p.id, p]));
  const muted = new Set();
  const logs = [];
  const hits = [];
  const changes = Object.fromEntries(players.map(p => [p.id, { damage: 0, healing: 0, energy: 0, hammers: 0, shields: 0, guards: 0 }]));
  const name = id => byId.get(id)?.name || '玩家';
  const log = (type, text, extra = {}) => logs.push({ type, text, ...extra });

  for (const caster of alive) {
    const target = interrupts[caster.id];
    if (actions[caster.id]?.move === 'meteor' && target && alive.some(p => p.id === target)) {
      muted.add(target);
      log('mute', `${name(caster.id)} 的流星锤封锁了 ${name(target)} 的招式。`, { source: caster.id, target });
    }
  }
  const activeAction = id => muted.has(id) ? null : actions[id];
  const attackPower = action => action?.move === 'fireball'
    ? action.power ?? (alive.length === 2 ? 2 : 1)
    : MOVES[action?.move]?.attack ?? null;

  for (const p of alive) {
    const action = activeAction(p.id);
    if (!action) continue;
    const change = changes[p.id];
    if (action.move === 'charge') { p.energy++; change.energy++; log('gain', `${p.name} 获得 1 个仔。`); }
    if (action.move === 'guard') { p.guards++; change.guards++; }
    if (action.move === 'hammer') { p.hammers++; change.hammers++; }
    if (action.move === 'holy') { p.shields++; change.shields++; }
    if (action.move === 'angel' || action.move === 'darkAngel') { change.healing++; log('heal', `${p.name} 恢复 1 点生命。`, { target: p.id }); }
  }

  for (const p of alive) {
    const action = activeAction(p.id);
    if (!action) continue;
    // An opponent may forfeit after choices are locked but before settlement.
    if (MOVES[action.move].target && !alive.some(target => target.id === action.target)) continue;
    const addHit = (target, amount, special = false) => hits.push({ source: p.id, target, move: action.move, amount, power: attackPower(action), special });
    switch (action.move) {
      case 'hammer': case 'shieldHammer': {
        const target = byId.get(action.target);
        if (['guard', 'shieldHammer'].includes(activeAction(target?.id)?.move)) {
          if (target.energy > 0) { target.energy--; changes[target.id].energy--; log('drain', `${p.name} 的${MOVES[action.move].name}敲掉了 ${target.name} 的 1 个仔。`); }
          else addHit(target.id, 1, true);
        }
        break;
      }
      case 'gun': case 'darkAngel': addHit(action.target, 1); break;
      case 'fireball': {
        const i = alive.findIndex(t => t.id === action.target);
        const targets = new Set([alive[i].id, alive[(i + 1) % alive.length].id, alive[(i - 1 + alive.length) % alive.length].id]);
        targets.delete(p.id);
        for (const target of targets) addHit(target, 1);
        break;
      }
      case 'quake': case 'wave':
        for (const target of alive) if (target.id !== p.id) addHit(target.id, action.move === 'quake' ? 2 : 1);
        break;
      case 'meteor':
        // Only active shields can receive meteor shield-breaking damage.
        for (const target of alive) if (target.id !== p.id && ['holy', 'gold'].includes(activeAction(target.id)?.move)) addHit(target.id, 1, true);
        break;
    }
  }

  const reflects = hit => {
    const defense = activeAction(hit.target);
    return hit.move !== 'meteor' && ((defense?.move === 'gold' && defense.reflect === hit.move) || (defense?.move === 'wave' && hit.move === 'fireball'));
  };
  // Explicit reflection takes priority; otherwise wave's fireball reflection
  // could never trigger because wave itself always attacks the fireball caster.
  // Compare only genuinely mutual attack hits, once, before applying damage.
  const suppressed = new Set();
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (hit.power === null || reflects(hit)) continue;
    const counter = hits.find(other => other.source === hit.target && other.target === hit.source && other.power !== null && other.power >= hit.power);
    if (counter) {
      suppressed.add(i);
      const text = counter.power === hit.power
        ? name(hit.source) + ' 的' + MOVES[hit.move].name + '与 ' + name(hit.target) + ' 的' + MOVES[counter.move].name + '点数相同，彼此抵消。'
        : name(hit.source) + ' 的' + MOVES[hit.move].name + '被 ' + name(hit.target) + ' 更高点数的攻击压制。';
      log('clash', text, { source: hit.source, target: hit.target });
    }
  }
  const blocked = (hit, action) => {
    if (!action) return false;
    if (hit.move === 'meteor') return false;
    if (['guard', 'shieldHammer'].includes(action.move) && ['gun', 'fireball'].includes(hit.move)) return true;
    if (['hammer', 'shieldHammer', 'meteor'].includes(action.move) && ['quake', 'wave'].includes(hit.move)) return true;
    return action.move === 'holy' && hit.move !== 'darkAngel';
  };
  const deal = (hit, reflected = false) => {
    const defense = activeAction(hit.target);
    if (blocked(hit, defense)) {
      log('block', `${name(hit.target)} 挡住了 ${name(hit.source)} 的${MOVES[hit.move].name}。`, { source: hit.source, target: hit.target });
      return;
    }
    if (!reflected && reflects(hit)) {
      log('reflect', `${name(hit.target)} 将${MOVES[hit.move].name}反弹给了 ${name(hit.source)}！`, { source: hit.target, target: hit.source });
      deal({ ...hit, source: hit.target, target: hit.source }, true);
      return;
    }
    const protectedByAngel = ['angel', 'darkAngel'].includes(defense?.move);
    const amount = protectedByAngel ? Math.min(hit.amount, Math.max(0, 1 - changes[hit.target].damage)) : hit.amount;
    if (amount < hit.amount) log('block', name(hit.target) + ' 的' + MOVES[defense.move].name + '将本回合总伤害限制为 1 点。', { source: hit.source, target: hit.target });
    if (amount === 0) return;
    changes[hit.target].damage += amount;
    log('damage', name(hit.source) + ' 的' + MOVES[hit.move].name + '对 ' + name(hit.target) + ' 造成 ' + amount + ' 点伤害。', { source: hit.source, target: hit.target, amount, reflected });
  };
  hits.forEach((hit, i) => { if (!suppressed.has(i)) deal(hit); });
  for (const p of alive) {
    p.hp += changes[p.id].healing - changes[p.id].damage;
    if (p.hp <= 0) log('death', `${p.name} 已阵亡。`, { target: p.id });
  }
  const casters = alive.filter(p => activeAction(p.id)?.move === 'avalanche');
  let avalanche = null;
  if (casters.length) {
    const casterIds = casters.map(p => p.id);
    const bans = Object.fromEntries(alive.map(p => [p.id, casterIds.includes(p.id) ? 'guard' : actions[p.id]?.move ?? null]));
    avalanche = { casterIds, bans };
    log('avalanche', casters.map(p => p.name).join('、') + ' 发动雪崩，下回合起覆盖旧限制：' + alive.map(p => p.name + '禁用「' + (MOVES[bans[p.id]]?.name || '无') + '」').join('；') + '。');
  }
  const survivors = players.filter(p => p.hp > 0);
  const finished = survivors.length <= 1;
  return { players, logs, changes, avalanche, muted: [...muted], hasDamage: Object.values(changes).some(c => c.damage > 0), finished, winnerId: finished && survivors.length === 1 ? survivors[0].id : null };
}
