import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { MOVES, REFLECTABLE, RESOURCE_NAMES, validateAction, payCosts, resolveRound, applyAvalanche, automaticAction } from './game.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const SELECTION_MS = Number(process.env.SELECTION_MS) || 15000;
const INTERRUPT_MS = Number(process.env.INTERRUPT_MS) || 12000;
const DISCONNECT_MS = Number(process.env.DISCONNECT_MS) || 60000;
const sessions = new Map();
const rooms = new Map();
const allowedFiles = new Set(['index.html', 'app.js', 'styles.css', 'arena-layout.css']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const now = () => Date.now();
const fail = message => { throw new Error(message); };
const activeMembers = room => room.players.filter(p => !p.left);
const inGame = room => ['selecting', 'interrupt', 'reveal'].includes(room.phase);
const playerView = p => ({ id: p.id, name: p.name, seat: p.seat, connected: p.connected, ready: p.ready, hp: p.hp, energy: p.energy, hammers: p.hammers, shields: p.shields, guards: p.guards, bannedMove: p.bannedMove, left: !!p.left });

function roomView(room, session) {
  const visible = ['interrupt', 'reveal', 'finished'].includes(room.phase);
  return {
    id: room.id, name: room.name, hostId: room.hostId, capacity: room.capacity, phase: room.phase, round: room.round,
    players: room.players.map(playerView), deadline: room.deadline,
    submitted: Object.keys(room.actions), ownAction: room.actions[session.id] || null,
    actions: visible ? room.actions : null,
    interrupts: room.phase === 'reveal' || room.phase === 'finished' ? room.interrupts : null,
    interruptSubmitted: Object.keys(room.interrupts),
    result: room.result, history: room.history, gameNumber: room.gameNumber, lastMatch: room.lastMatch,
    leaderboard: Object.values(room.scores).map(score => ({ ...score, present: activeMembers(room).some(p => p.id === score.id) })).sort((a, b) => b.wins - a.wins || b.games - a.games || a.order - b.order),
  };
}
function lobbyView() {
  return [...rooms.values()].map(room => ({
    id: room.id, name: room.name, hostName: room.players.find(p => p.id === room.hostId)?.name || '房主',
    capacity: room.capacity, count: activeMembers(room).length, phase: room.phase, round: room.round,
  }));
}
function send(session, event, data) {
  for (const stream of session.streams) {
    if (!stream.destroyed && !stream.writableEnded) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
function sendState(session) {
  const room = rooms.get(session.roomId);
  send(session, 'state', { self: { id: session.id, name: session.name }, room: room ? roomView(room, session) : null, rooms: lobbyView(), serverTime: now() });
}
function broadcast() { for (const s of sessions.values()) if (s.streams.size) sendState(s); }
// Quick tunnels buffer SSE; polling clients renew their presence with each state request.
function renewPollingPresence(session) {
  session.pollUntil = now() + DISCONNECT_MS;
  clearTimeout(session.pollTimer);
  clearTimeout(session.disconnectTimer);
  const room = rooms.get(session.roomId);
  const player = room?.players.find(p => p.id === session.id && !p.left);
  const reconnected = player && !player.connected;
  if (player) player.connected = true;
  session.pollTimer = setTimeout(() => {
    if (session.streams.size) return;
    const current = rooms.get(session.roomId)?.players.find(p => p.id === session.id);
    if (current) { current.connected = false; current.ready = false; }
    leaveRoom(session);
    broadcast();
  }, DISCONNECT_MS);
  session.pollTimer.unref?.();
  if (reconnected) {
    if (room && !inGame(room)) maybeStart(room);
    broadcast();
  }
}

function setTimer(room, duration, callback) {
  clearTimeout(room.timer);
  room.deadline = now() + duration;
  room.timer = setTimeout(() => { if (rooms.has(room.id)) callback(); }, duration);
  room.timer.unref?.();
}
function setPhase(room, phase) { room.phase = phase; room.updatedAt = now(); }
function rememberPlayer(room, player) {
  room.scores[player.id] ||= { id: player.id, name: player.name, wins: 0, games: 0, order: Object.keys(room.scores).length };
  room.scores[player.id].name = player.name;
}
function lockMatch(room, result) {
  if (room.lastMatch?.gameNumber === room.gameNumber) return room.lastMatch;
  const winner = room.players.find(p => p.id === result.winnerId);
  room.lastMatch = { gameNumber: room.gameNumber, round: room.round, winnerId: result.winnerId || null, winnerName: winner?.name || null, endedAt: now(), players: room.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, hp: p.hp })) };
  for (const player of room.players) {
    rememberPlayer(room, player);
    room.scores[player.id].games++;
    if (player.id === room.lastMatch.winnerId) room.scores[player.id].wins++;
  }
  return room.lastMatch;
}
function finishGame(room, result) {
  if (room.phase === 'finished') return;
  const locked = lockMatch(room, result);
  setPhase(room, 'finished');
  room.deadline = null;
  room.result = { ...result, finished: true, winnerId: locked.winnerId, winnerName: locked.winnerName };
  for (const p of room.players) p.ready = false;
  broadcast();
}
function settle(room) {
  clearTimeout(room.timer);
  const result = resolveRound(room.players, room.actions, room.interrupts);
  room.players = result.players;
  if (result.avalanche) room.pendingAvalanche = result.avalanche;
  room.result = { ...result, players: undefined, round: room.round, actions: { ...room.actions } };
  if (result.finished) {
    const locked = lockMatch(room, room.result);
    room.result.winnerName = locked.winnerName;
  }
  room.history.unshift({ gameNumber: room.gameNumber, round: room.round, logs: result.logs, actions: { ...room.actions }, winnerId: result.winnerId });
  room.history = room.history.slice(0, 60);
  setPhase(room, 'reveal');
  setTimer(room, result.hasDamage ? 5000 : 2000, () => {
    const survivors = room.players.filter(p => p.hp > 0);
    if (result.finished) finishGame(room, room.result);
    else if (survivors.length <= 1) finishGame(room, { ...room.result, finished: true, winnerId: survivors.length === 1 ? survivors[0].id : null });
    else beginRound(room);
  });
  broadcast();
}
function reveal(room) {
  clearTimeout(room.timer);
  room.players = payCosts(room.players, room.actions);
  room.interrupts = {};
  const meteors = room.players.filter(p => p.hp > 0 && room.actions[p.id]?.move === 'meteor');
  if (meteors.length) {
    setPhase(room, 'interrupt');
    setTimer(room, INTERRUPT_MS, () => settle(room));
    broadcast();
  } else settle(room);
}
function beginRound(room) {
  if (room.pendingAvalanche) {
    room.players = applyAvalanche(room.players, room.pendingAvalanche);
    room.pendingAvalanche = null;
  }
  room.round++;
  room.actions = {};
  room.interrupts = {};
  room.result = null;
  setPhase(room, 'selecting');
  setTimer(room, SELECTION_MS, () => {
    for (const p of room.players) if (p.hp > 0 && !room.actions[p.id]) room.actions[p.id] = automaticAction(room.players, p.id);
    reveal(room);
  });
  broadcast();
}
function maybeStart(room) {
  const members = activeMembers(room);
  if (members.length < 2 || !members.every(p => p.ready && p.connected)) return;
  clearTimeout(room.timer);
  room.players = members.sort((a, b) => a.seat - b.seat).map(p => ({ ...p, hp: 1, energy: 0, hammers: 0, shields: 0, guards: 0, bannedMove: null, ready: false, left: false }));
  room.pendingAvalanche = null;
  room.gameNumber++;
  room.round = 0;
  beginRound(room);
}
function makePlayer(session, seat) { return { id: session.id, name: session.name, seat, connected: session.streams.size > 0 || session.pollUntil > now(), ready: false, hp: 1, energy: 0, hammers: 0, shields: 0, guards: 0, bannedMove: null, left: false }; }
function leaveRoom(session) {
  const room = rooms.get(session.roomId);
  session.roomId = null;
  if (!room) return;
  const player = room.players.find(p => p.id === session.id);
  if (player) {
    player.ready = false;
    if (inGame(room)) { player.left = true; player.hp = 0; player.connected = false; }
    else room.players = room.players.filter(p => p.id !== session.id);
  }
  const remaining = activeMembers(room);
  if (!remaining.length) { clearTimeout(room.timer); rooms.delete(room.id); return; }
  if (room.hostId === session.id) room.hostId = (remaining.find(p => p.connected) || remaining[0]).id;
  if (room.phase === 'selecting') {
    const alive = room.players.filter(p => p.hp > 0);
    if (alive.length <= 1) {
      clearTimeout(room.timer);
      finishGame(room, { finished: true, winnerId: alive[0]?.id || null, logs: [{ type: 'leave', text: `${session.name} 离开了对局。` }], changes: {}, muted: [], hasDamage: false, round: room.round });
    } else if (alive.every(p => room.actions[p.id])) reveal(room);
  } else if (room.phase === 'interrupt') {
    const casters = room.players.filter(p => p.hp > 0 && room.actions[p.id]?.move === 'meteor');
    if (casters.every(p => Object.hasOwn(room.interrupts, p.id))) settle(room);
  }
  // The reveal timer re-checks survivors in case someone left during the display.
  if (!inGame(room)) maybeStart(room);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) fail('请求过大。'); }
  try { return JSON.parse(body || '{}'); } catch { fail('无效的请求数据。'); }
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function cleanName(value, fallback, max = 12) {
  return (typeof value === 'string' ? value : fallback).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size });
      if (req.method === 'GET' && url.pathname === '/api/rules') return json(res, 200, { moves: MOVES, reflectable: REFLECTABLE, resourceNames: RESOURCE_NAMES });
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await readBody(req);
        let session = typeof body.token === 'string' ? sessions.get(body.token) : null;
        if (!session) {
          const name = cleanName(body.name, '');
          if (!name) fail('先给自己起一个临时昵称吧。');
          const token = randomBytes(32).toString('hex');
          session = { id: randomUUID(), name, token, roomId: null, streams: new Set(), createdAt: now(), lastSeen: now(), rates: [] };
          sessions.set(token, session);
        }
        session.lastSeen = now();
        return json(res, 200, { token: session.token, self: { id: session.id, name: session.name }, moves: MOVES, reflectable: REFLECTABLE, resourceNames: RESOURCE_NAMES });
      }
      if (url.pathname.startsWith('/api/')) {
        const token = url.pathname === '/api/events' ? url.searchParams.get('token') : req.headers.authorization?.replace(/^Bearer /, '');
        const session = sessions.get(token);
        if (!session) return json(res, 401, { error: '临时身份已过期，请重新进入。' });
        session.lastSeen = now();
        if (url.pathname === '/api/events' && req.method === 'GET') {
          clearTimeout(session.disconnectTimer);
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('retry: 1500\n\n');
          session.streams.add(res);
          const room = rooms.get(session.roomId);
          const player = room?.players.find(p => p.id === session.id && !p.left);
          if (player) player.connected = true;
          if (room && !inGame(room)) maybeStart(room);
          broadcast();
          const heartbeat = setInterval(() => res.write(`: heartbeat ${now()}\n\n`), 15000);
          heartbeat.unref?.();
          req.on('close', () => {
            clearInterval(heartbeat);
            session.streams.delete(res);
            if (!session.streams.size && !(session.pollUntil > now())) {
              const current = rooms.get(session.roomId)?.players.find(p => p.id === session.id);
              if (current) { current.connected = false; current.ready = false; }
              session.disconnectTimer = setTimeout(() => { if (!session.streams.size) { leaveRoom(session); broadcast(); } }, DISCONNECT_MS);
              session.disconnectTimer.unref?.();
              broadcast();
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          if (url.searchParams.get('poll') === '1') renewPollingPresence(session);
          const room = rooms.get(session.roomId);
          return json(res, 200, { self: { id: session.id, name: session.name }, room: room ? roomView(room, session) : null, rooms: lobbyView(), serverTime: now() });
        }
        if (req.method !== 'POST') return json(res, 404, { error: '接口不存在。' });
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return json(res, 403, { error: '不允许跨站操作。' });
        session.rates = session.rates.filter(t => t > now() - 10000);
        if (session.rates.length >= 50) return json(res, 429, { error: '操作太快，请稍候。' });
        session.rates.push(now());
        const body = await readBody(req);
        let room = rooms.get(session.roomId);
        switch (url.pathname) {
          case '/api/rooms/create': {
            if (room) fail('请先退出当前房间。');
            const capacity = Number(body.capacity);
            if (!Number.isInteger(capacity) || capacity < 2 || capacity > 8) fail('房间人数应为 2–8 人。');
            if (rooms.size >= 200) fail('当前房间已满，请稍后重试。');
            let id; do { id = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(id));
            room = { id, name: cleanName(body.name, '', 20) || `${session.name}的房间`, hostId: session.id, capacity, phase: 'waiting', round: 0, gameNumber: 0, lastMatch: null, scores: {}, players: [makePlayer(session, 0)], actions: {}, interrupts: {}, result: null, history: [], deadline: null, createdAt: now(), updatedAt: now() };
            rememberPlayer(room, room.players[0]);
            rooms.set(id, room); session.roomId = id;
            break;
          }
          case '/api/rooms/join': {
            if (room) fail('你已经在一个房间中。');
            const target = rooms.get(String(body.roomId || '').trim().toUpperCase());
            if (!target) fail('房间不存在或已经关闭。');
            if (inGame(target)) fail('这间房正在对局，请等待结束。');
            if (activeMembers(target).length >= target.capacity) fail('房间已满。');
            target.players = activeMembers(target);
            // Duplicate names are visibly disambiguated within a room.
            let displayName = session.name; let suffix = 2;
            while (target.players.some(p => p.name === displayName)) displayName = `${session.name}·${suffix++}`;
            const seat = Array.from({ length: 8 }, (_, i) => i).find(i => !target.players.some(p => p.seat === i));
            const player = { ...makePlayer(session, seat), name: displayName };
            target.players.push(player);
            target.players.sort((a, b) => a.seat - b.seat);
            rememberPlayer(target, player);
            session.roomId = target.id;
            break;
          }
          case '/api/rooms/leave': leaveRoom(session); break;
          case '/api/rooms/capacity': {
            if (!room || room.hostId !== session.id) fail('只有房主可以调整人数。');
            if (inGame(room)) fail('对局进行中不能调整人数。');
            const capacity = Number(body.capacity);
            if (!Number.isInteger(capacity) || capacity < 2 || capacity > 8 || capacity < activeMembers(room).length) fail('人数限制需为 2–8 人，且不能小于当前人数。');
            room.capacity = capacity; break;
          }
          case '/api/rooms/ready': {
            if (!room || inGame(room)) fail('当前不能更改准备状态。');
            const p = room.players.find(p => p.id === session.id && !p.left);
            if (!p) fail('你不在这个房间中。');
            p.ready = !p.ready;
            maybeStart(room); break;
          }
          case '/api/game/action': {
            if (!room || room.phase !== 'selecting') fail('当前不是选招阶段。');
            if (body.round !== room.round) fail('回合已更新，请重新选择。');
            if (room.actions[session.id]) fail('本回合已经锁定招式。');
            room.actions[session.id] = validateAction(room.players, session.id, body);
            if (room.players.filter(p => p.hp > 0).every(p => room.actions[p.id])) reveal(room);
            break;
          }
          case '/api/game/interrupt': {
            if (!room || room.phase !== 'interrupt' || room.actions[session.id]?.move !== 'meteor') fail('当前不能使用流星锤封锁。');
            if (body.round !== room.round) fail('回合已经更新。');
            const caster = room.players.find(p => p.id === session.id && p.hp > 0);
            if (!caster) fail('你已阵亡，正在观战。');
            if (Object.hasOwn(room.interrupts, session.id)) fail('已经确认封锁目标。');
            if (body.target !== null && !room.players.some(p => p.id === body.target && p.hp > 0)) fail('请选择存活目标。');
            room.interrupts[session.id] = body.target;
            if (room.players.filter(p => p.hp > 0 && room.actions[p.id]?.move === 'meteor').every(p => Object.hasOwn(room.interrupts, p.id))) settle(room);
            break;
          }
          default: return json(res, 404, { error: '接口不存在。' });
        }
        broadcast();
        return json(res, 200, { ok: true });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!allowedFiles.has(file)) return json(res, 404, { error: '页面不存在。' });
      const content = await readFile(path.join(publicDir, file));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message || '操作失败，请重试。' });
      else res.end();
    }
  });
}

const cleanup = setInterval(() => {
  for (const [token, session] of sessions) if (!session.streams.size && !session.roomId && session.lastSeen < now() - 86400000) sessions.delete(token);
  for (const [id, room] of rooms) if (!activeMembers(room).some(p => p.connected) && room.updatedAt < now() - 600000) {
    clearTimeout(room.timer);
    for (const session of sessions.values()) if (session.roomId === id) session.roomId = null;
    rooms.delete(id);
  }
}, 60000);
cleanup.unref();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  仔仔 ZAIZAI ARENA\n  本机：http://localhost:${port}\n  局域网：使用本机 IP + :${port}，所有玩家访问同一地址。\n`);
  });
  server.on('error', error => { console.error('服务启动失败：', error.message); process.exitCode = 1; });
}
