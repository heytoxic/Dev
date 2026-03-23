/**
 * LUDO KING PRO - Server
 * Full multiplayer Ludo with: rooms (2-8 players), turn timers, auto-move,
 * reconnection, stats, coins, chat/emojis, match history, Google OAuth placeholder
 */

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'index.html')));

// ─────────────────────────────────────────────────────
//  In-memory stores (replace with MongoDB in production)
// ─────────────────────────────────────────────────────
const rooms   = new Map();   // code → Room
const clients = new Map();   // ws → ClientInfo
const users   = new Map();   // userId → UserProfile

// ─────────────────────────────────────────────────────
//  Board Constants
// ─────────────────────────────────────────────────────
const PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0]
];
const HOME_STRETCH = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  blue:   [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  green:  [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  yellow: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
};
const SPAWN = {
  red:    [[2,2],[2,3],[3,2],[3,3]],
  blue:   [[2,11],[2,12],[3,11],[3,12]],
  green:  [[11,11],[11,12],[12,11],[12,12]],
  yellow: [[11,2],[11,3],[12,2],[12,3]],
};
const SAFE_IDXS = new Set([0,8,13,21,26,34,39,47]);
const START_IDX = { red:0, blue:13, green:26, yellow:39 };
const COLORS_4  = ['red','blue','green','yellow'];
// For 2P: red+green; for 3P: red+blue+green; for 4P+: all
function colorsForCount(n){
  if(n<=2) return ['red','green'];
  if(n===3) return ['red','blue','green'];
  return COLORS_4.slice(0, Math.min(n,4));
}

// Turn time per player (seconds)
const TURN_TIME = 20;

// ─────────────────────────────────────────────────────
//  Ludo King-style smart dice logic
// ─────────────────────────────────────────────────────
function rollDiceLogic(pieces, color) {
  // Standard random 1-6
  let val = Math.floor(Math.random() * 6) + 1;

  // Avoid completely blocking roll: if ALL pieces are in base and roll≠6,
  // give a 25% chance to override to 6 (like Ludo King bias)
  const allInBase = pieces.every(p => p.inBase && !p.finished);
  if(allInBase && val !== 6 && Math.random() < 0.25) {
    val = 6;
  }

  // If one or more pieces can move, ensure we don't always get unusable
  const hasMovable = pieces.some(p => {
    if(p.finished || p.inBase) return false;
    if(p.homeStretch >= 0) return p.homeStretch + val <= 5;
    return true;
  });

  // Anti-cut bias: if a piece was recently cut, slightly favor 6
  return val;
}

// ─────────────────────────────────────────────────────
//  Room helpers
// ─────────────────────────────────────────────────────
function genCode(){
  let c;
  do { c = String(Math.floor(100000 + Math.random()*900000)); }
  while(rooms.has(c));
  return c;
}

function createPieces(){
  return [0,1,2,3].map(id=>({
    id, inBase:true, pathIdx:-1, homeStretch:-1, finished:false
  }));
}

function initGameState(players){
  const colors = players.map(p=>p.color);
  const pieces = {};
  colors.forEach(c => pieces[c] = createPieces());
  return {
    activePlayers: colors,
    currentTurn:   0,
    diceValue:     0,
    diceRolled:    false,
    rollsLeft:     1,
    extraTurns:    0,
    pieces,
    finishOrder:   [],
    turnStartTime: Date.now(),
    turnTimer:     TURN_TIME,
    phase:         'rolling',  // 'rolling' | 'moving'
  };
}

// ─────────────────────────────────────────────────────
//  Piece movement
// ─────────────────────────────────────────────────────
function canMovePiece(piece, color, dv){
  if(piece.finished) return false;
  if(piece.inBase)   return dv === 6;
  if(piece.homeStretch >= 0) return piece.homeStretch + dv <= 5;
  return true;
}

function movePiece(gs, color, pieceId){
  const piece  = gs.pieces[color][pieceId];
  const dv     = gs.diceValue;
  let killed   = false;
  let gotBonus = false;

  if(!canMovePiece(piece, color, dv)) return { ok:false };

  if(piece.inBase && dv === 6){
    piece.inBase   = false;
    piece.pathIdx  = START_IDX[color];
  } else if(piece.homeStretch >= 0){
    piece.homeStretch += dv;
    if(piece.homeStretch >= 5){
      piece.homeStretch = 5;
      piece.finished    = true;
      gotBonus = true;
    }
  } else {
    let idx = piece.pathIdx + dv;
    if(idx >= PATH.length) idx -= PATH.length;

    // Check if entering home stretch
    const hsStart = (START_IDX[color] + 50) % PATH.length;
    // Home stretch entry: after completing ~50 steps from start
    const stepsFromStart = (idx - START_IDX[color] + PATH.length) % PATH.length;
    if(stepsFromStart >= 50){
      const extra = stepsFromStart - 50;
      piece.homeStretch = extra;
      piece.pathIdx     = -1;
      if(piece.homeStretch >= 5){
        piece.homeStretch = 5;
        piece.finished    = true;
        gotBonus = true;
      }
    } else {
      piece.pathIdx = idx;

      // Kill enemy pieces on this cell (if not safe)
      const isSafe = SAFE_IDXS.has(idx);
      if(!isSafe){
        gs.activePlayers.forEach(oc => {
          if(oc === color) return;
          gs.pieces[oc].forEach(op => {
            if(op.finished || op.inBase || op.homeStretch >= 0) return;
            if(op.pathIdx === idx){
              // Check if enemy has a blockade (2 pieces same cell = safe)
              const allies = gs.pieces[oc].filter(x => !x.finished && !x.inBase && x.homeStretch < 0 && x.pathIdx === idx);
              if(allies.length < 2){
                op.inBase   = true;
                op.pathIdx  = -1;
                killed       = true;
                gotBonus     = true;
              }
            }
          });
        });
      }
    }
  }

  // Bonus turn for 6 or kill
  if(dv === 6 || killed){
    gotBonus = true;
  }

  gs.diceRolled = false;
  gs.diceValue  = 0;

  // Check win
  const finished = gs.pieces[color].every(p => p.finished);
  if(finished && !gs.finishOrder.includes(color)){
    gs.finishOrder.push(color);
  }

  if(!gotBonus){
    nextTurn(gs);
  } else {
    gs.phase = 'rolling';
  }

  return { ok:true, killed, gotBonus };
}

function nextTurn(gs){
  const alive = gs.activePlayers.filter(c => !gs.pieces[c].every(p=>p.finished));
  if(alive.length <= 1){
    gs.phase = 'ended';
    if(alive.length===1 && !gs.finishOrder.includes(alive[0])){
      gs.finishOrder.push(alive[0]);
    }
    return;
  }
  gs.currentTurn = (gs.currentTurn + 1) % gs.activePlayers.length;
  // Skip finished players
  let attempts = 0;
  while(gs.pieces[gs.activePlayers[gs.currentTurn]]?.every(p=>p.finished) && attempts < 10){
    gs.currentTurn = (gs.currentTurn+1) % gs.activePlayers.length;
    attempts++;
  }
  gs.diceValue   = 0;
  gs.diceRolled  = false;
  gs.phase       = 'rolling';
  gs.turnStartTime = Date.now();
  gs.turnTimer   = TURN_TIME;
}

// ─────────────────────────────────────────────────────
//  Auto-move: best piece selection (Ludo King style)
// ─────────────────────────────────────────────────────
function autoSelectPiece(gs, color){
  const dv = gs.diceValue;
  const movable = gs.pieces[color].filter(p => canMovePiece(p, color, dv));
  if(movable.length === 0) return null;
  if(movable.length === 1) return movable[0].id;

  // Priority: kill > exit base > advance home stretch > furthest piece
  let best = null, bestScore = -1;

  movable.forEach(p => {
    let score = 0;
    if(p.inBase) score += 50;
    else if(p.homeStretch >= 0) score += 200 + p.homeStretch;
    else {
      score += p.pathIdx;
      // Check if can kill
      const newIdx = (p.pathIdx + dv) % PATH.length;
      gs.activePlayers.forEach(oc => {
        if(oc===color) return;
        gs.pieces[oc].forEach(op => {
          if(!op.inBase && op.homeStretch<0 && !op.finished && op.pathIdx===newIdx){
            const allies = gs.pieces[oc].filter(x=>!x.finished&&!x.inBase&&x.homeStretch<0&&x.pathIdx===newIdx);
            if(allies.length<2) score += 1000;
          }
        });
      });
    }
    if(score > bestScore){ bestScore = score; best = p.id; }
  });

  return best;
}

// ─────────────────────────────────────────────────────
//  User profile helpers
// ─────────────────────────────────────────────────────
function getOrCreateUser(userId, name, avatar){
  if(!users.has(userId)){
    users.set(userId, {
      id:           userId,
      name:         name || 'Player',
      avatar:       avatar || null,
      coins:        1000,
      gems:         0,
      level:        1,
      xp:           0,
      gamesWon:     0,
      gamesLost:    0,
      winStreak:    0,
      bestStreak:   0,
      tokensKilled: 0,
      tokensCaptured:0,
      performanceRating: 1000,
      tournamentsWon: 0,
      matchHistory: [],
      createdAt:    Date.now(),
    });
  }
  const u = users.get(userId);
  if(name)   u.name   = name;
  if(avatar) u.avatar = avatar;
  return u;
}

function updateUserStats(userId, result, coinsEarned, details){
  const u = users.get(userId);
  if(!u) return;
  if(result === 'win'){
    u.gamesWon++;
    u.winStreak++;
    if(u.winStreak > u.bestStreak) u.bestStreak = u.winStreak;
    u.performanceRating += 25;
    u.xp += 180;
  } else {
    u.gamesLost++;
    u.winStreak = 0;
    u.performanceRating = Math.max(0, u.performanceRating - 15);
    u.xp += 50;
  }
  u.coins += coinsEarned;
  if(details?.killed)   u.tokensKilled   += details.killed;
  if(details?.captured) u.tokensCaptured += details.captured;

  // Level up every 1000 xp
  u.level = Math.floor(u.xp / 1000) + 1;

  u.matchHistory.unshift({
    date:       Date.now(),
    result,
    coins:      coinsEarned,
    details,
  });
  if(u.matchHistory.length > 50) u.matchHistory.pop();
}

// ─────────────────────────────────────────────────────
//  Broadcast helpers
// ─────────────────────────────────────────────────────
function send(ws, obj){ 
  if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); 
}

function broadcast(room, obj, exceptWs=null){
  room.players.forEach(p => {
    if(p.ws !== exceptWs) send(p.ws, obj);
  });
  room.spectators?.forEach(s => {
    if(s.ws !== exceptWs) send(s.ws, obj);
  });
}

function broadcastGameState(room){
  broadcast(room, { type:'game_state', state: sanitizeState(room.gs), ping: getPings(room) });
}

function getPings(room){
  const pings = {};
  room.players.forEach(p => { pings[p.color] = p.ping || 0; });
  return pings;
}

function sanitizeState(gs){ return JSON.parse(JSON.stringify(gs)); }

function getPublicProfile(userId){
  const u = users.get(userId);
  if(!u) return null;
  const { id, name, avatar, coins, gems, level, xp, gamesWon, gamesLost, winStreak, bestStreak, tokensKilled, tokensCaptured, performanceRating, tournamentsWon, matchHistory } = u;
  return { id, name, avatar, coins, gems, level, xp, gamesWon, gamesLost, winStreak, bestStreak, tokensKilled, tokensCaptured, performanceRating, tournamentsWon, matchHistory };
}

// ─────────────────────────────────────────────────────
//  Turn timer
// ─────────────────────────────────────────────────────
function startTurnTimer(room){
  clearRoomTimer(room);
  let remaining = TURN_TIME;
  room._timerInterval = setInterval(() => {
    if(!room.gs || room.gs.phase === 'ended'){
      clearRoomTimer(room); return;
    }
    remaining--;
    room.gs.turnTimer = remaining;

    broadcast(room, { type: 'timer_tick', remaining });

    if(remaining <= 0){
      clearRoomTimer(room);
      handleTimeout(room);
    }
  }, 1000);
}

function clearRoomTimer(room){
  if(room._timerInterval){ clearInterval(room._timerInterval); room._timerInterval = null; }
}

function handleTimeout(room){
  const gs  = room.gs;
  const col = gs.activePlayers[gs.currentTurn];
  const player = room.players.find(p=>p.color===col);

  if(!gs.diceRolled){
    // Auto roll
    const dv = rollDiceLogic(gs.pieces[col], col);
    gs.diceValue  = dv;
    gs.diceRolled = true;
    gs.phase      = 'moving';
    broadcast(room, { type:'auto_roll', color:col, value:dv });
  }

  // Auto move best piece
  const pieceId = autoSelectPiece(gs, col);
  if(pieceId !== null){
    movePiece(gs, col, pieceId);
    broadcast(room, { type:'auto_move', color:col, pieceId });
  } else {
    nextTurn(gs);
    broadcast(room, { type:'auto_skip', color:col });
  }

  // Timeout strike system (3 timeouts = removed)
  if(player){
    player.timeouts = (player.timeouts || 0) + 1;
    if(player.timeouts >= 3){
      broadcast(room, { type:'player_removed', color:col, reason:'timeout' });
      removePlayerFromGame(room, player);
      return;
    }
  }

  broadcastGameState(room);
  checkGameEnd(room);
  if(room.gs.phase !== 'ended') startTurnTimer(room);
}

function removePlayerFromGame(room, player){
  // Return all pieces to base
  if(room.gs && room.gs.pieces[player.color]){
    room.gs.pieces[player.color].forEach(p => {
      p.inBase = true; p.pathIdx = -1; p.homeStretch = -1; p.finished = false;
    });
  }
}

// ─────────────────────────────────────────────────────
//  Game end
// ─────────────────────────────────────────────────────
function checkGameEnd(room){
  const gs = room.gs;
  if(!gs || gs.phase === 'ended') return;
  const alive = gs.activePlayers.filter(c => !gs.pieces[c].every(p=>p.finished));
  if(alive.length <= 1){
    gs.phase = 'ended';
    if(alive.length===1 && !gs.finishOrder.includes(alive[0])){
      gs.finishOrder.push(alive[0]);
    }
    clearRoomTimer(room);
    handleGameEnd(room);
  }
}

function handleGameEnd(room){
  const gs = room.gs;
  const coinRewards = [500, 200, 100, 50, 20, 10, 5, 2];

  room.players.forEach((p, idx) => {
    const pos     = gs.finishOrder.indexOf(p.color);
    const rank    = pos === -1 ? room.players.length : pos + 1;
    const coins   = coinRewards[rank-1] || 0;
    const result  = rank === 1 ? 'win' : 'lose';
    if(p.userId) updateUserStats(p.userId, result, coins, {});
    send(p.ws, { type:'game_end', rank, coins, finishOrder: gs.finishOrder, profile: p.userId ? getPublicProfile(p.userId) : null });
  });

  broadcast(room, { type:'game_over', finishOrder: gs.finishOrder });
  room.status = 'ended';

  // Clean room after 60s
  setTimeout(()=>{ rooms.delete(room.code); }, 60000);
}

// ─────────────────────────────────────────────────────
//  WebSocket message handler
// ─────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  clients.set(ws, { id: clientId, room: null, pingTs: Date.now() });

  send(ws, { type:'welcome', id: clientId });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch{ return; }
    const client = clients.get(ws);

    switch(msg.type){

      // ── Ping / latency ──
      case 'ping': {
        const now = Date.now();
        send(ws, { type:'pong', ts: msg.ts, serverTs: now });
        if(client.room){
          const room = rooms.get(client.room);
          if(room){
            const player = room.players.find(p=>p.ws===ws);
            if(player) player.ping = now - (msg.ts||now);
          }
        }
        break;
      }

      // ── Create Room ──
      case 'create_room': {
        const maxP  = Math.min(Math.max(parseInt(msg.players)||4, 2), 8);
        const code  = genCode();
        const userId= msg.userId || clientId;
        const user  = getOrCreateUser(userId, msg.name, msg.avatar);

        const colors = colorsForCount(maxP);
        const room = {
          code, maxPlayers: maxP, status:'waiting',
          players: [{
            ws, id: clientId, userId,
            name: user.name, avatar: user.avatar,
            color: colors[0], isHost: true,
            timeouts: 0, ping: 0
          }],
          spectators: [], gs: null, _timerInterval: null,
          chat: [],
        };
        rooms.set(code, room);
        client.room = code;

        send(ws, { type:'room_created', code, color: colors[0], max: maxP,
          players: room.players.map(p=>({id:p.id,name:p.name,color:p.color,avatar:p.avatar})) });
        break;
      }

      // ── Join Room ──
      case 'join_room': {
        const code = String(msg.code).trim();
        const room = rooms.get(code);
        if(!room){ send(ws, { type:'error', message:'Room not found. Check code and try again.' }); break; }
        if(room.status !== 'waiting' && !msg.spectate){
          // Allow rejoin
          const existing = room.players.find(p => p.userId === msg.userId || p.id === clientId);
          if(existing){
            existing.ws = ws;
            client.room = code;
            send(ws, { type:'room_rejoined', code, color: existing.color, max: room.maxPlayers,
              players: room.players.map(p=>({id:p.id,name:p.name,color:p.color,avatar:p.avatar})),
              state: room.gs ? sanitizeState(room.gs) : null
            });
            if(room.gs) broadcastGameState(room);
            break;
          }
          send(ws, { type:'error', message:'Game already in progress. Cannot join.' }); break;
        }
        if(!msg.spectate && room.players.length >= room.maxPlayers){
          send(ws, { type:'error', message:`Room is full (${room.maxPlayers}/${room.maxPlayers} players).` }); break;
        }

        const userId = msg.userId || clientId;
        const user   = getOrCreateUser(userId, msg.name, msg.avatar);

        if(msg.spectate){
          room.spectators.push({ ws, id:clientId, userId, name:user.name, avatar:user.avatar });
          client.room = code;
          send(ws, { type:'room_joined', code, color:null, spectate:true, max:room.maxPlayers,
            players: room.players.map(p=>({id:p.id,name:p.name,color:p.color,avatar:p.avatar})) });
          break;
        }

        const usedColors = room.players.map(p=>p.color);
        const allColors  = colorsForCount(room.maxPlayers);
        const nextColor  = allColors.find(c=>!usedColors.includes(c)) || allColors[room.players.length % allColors.length];

        room.players.push({
          ws, id:clientId, userId,
          name:user.name, avatar:user.avatar,
          color:nextColor, isHost:false, timeouts:0, ping:0
        });
        client.room = code;

        send(ws, { type:'room_joined', code, color:nextColor, max:room.maxPlayers,
          players: room.players.map(p=>({id:p.id,name:p.name,color:p.color,avatar:p.avatar})) });

        broadcast(room, { type:'player_joined', name:user.name, color:nextColor, max:room.maxPlayers,
          players: room.players.map(p=>({id:p.id,name:p.name,color:p.color,avatar:p.avatar})) }, ws);
        break;
      }

      // ── Start Game ──
      case 'start_game': {
        const room = rooms.get(client.room);
        if(!room){ send(ws, {type:'error',message:'Room not found'}); break; }
        const host = room.players.find(p=>p.ws===ws);
        if(!host?.isHost){ send(ws, {type:'error',message:'Only host can start'}); break; }
        if(room.players.length < 2){ send(ws, {type:'error',message:'Need at least 2 players'}); break; }

        room.status = 'playing';
        room.gs     = initGameState(room.players);

        const colorMap = {};
        room.players.forEach(p => colorMap[p.id] = p.color);

        broadcast(room, { type:'game_start', state: sanitizeState(room.gs), colorMap,
          players: room.players.map(p=>({id:p.id,name:p.name,color:p.color,avatar:p.avatar})) });

        startTurnTimer(room);
        break;
      }

      // ── Roll Dice ──
      case 'roll_dice': {
        const room = rooms.get(client.room);
        if(!room?.gs){ break; }
        const gs  = room.gs;
        const col = gs.activePlayers[gs.currentTurn];
        const player = room.players.find(p=>p.ws===ws);
        if(!player || player.color !== col){ break; }
        if(gs.diceRolled || gs.phase !== 'rolling'){ break; }

        const dv = rollDiceLogic(gs.pieces[col], col);
        gs.diceValue  = dv;
        gs.diceRolled = true;
        gs.phase      = 'moving';

        // Check if any piece can move
        const hasMove = gs.pieces[col].some(p => canMovePiece(p, col, dv));
        if(!hasMove){
          // Ludo King style: if rolled 6, stay; else skip
          if(dv === 6){
            gs.diceRolled = false;
            gs.phase = 'rolling';
          } else {
            broadcast(room, { type:'dice_rolled', color:col, value:dv });
            broadcastGameState(room);
            setTimeout(()=>{
              nextTurn(gs);
              broadcastGameState(room);
              checkGameEnd(room);
              if(gs.phase!=='ended') startTurnTimer(room);
            }, 800);
            break;
          }
        }

        broadcast(room, { type:'dice_rolled', color:col, value:dv });
        broadcastGameState(room);
        clearRoomTimer(room);
        // Give 15s to pick piece
        room._timerInterval = setTimeout(()=>{
          if(!gs.diceRolled) return;
          const pid = autoSelectPiece(gs, col);
          if(pid!==null){
            movePiece(gs, col, pid);
            broadcast(room, {type:'auto_move',color:col,pieceId:pid});
          } else {
            nextTurn(gs);
          }
          broadcastGameState(room);
          checkGameEnd(room);
          if(gs.phase!=='ended') startTurnTimer(room);
        }, 15000);
        break;
      }

      // ── Move Piece ──
      case 'move_piece': {
        const room = rooms.get(client.room);
        if(!room?.gs){ break; }
        const gs  = room.gs;
        const col = gs.activePlayers[gs.currentTurn];
        const player = room.players.find(p=>p.ws===ws);
        if(!player || player.color !== col){ break; }
        if(!gs.diceRolled){ break; }

        clearRoomTimer(room);

        const res = movePiece(gs, col, msg.pieceId);
        if(!res.ok){ send(ws,{type:'error',message:'Invalid move'}); break; }

        broadcast(room, { type:'piece_moved', color:col, pieceId:msg.pieceId, killed:res.killed });
        broadcastGameState(room);
        checkGameEnd(room);
        if(gs.phase!=='ended') startTurnTimer(room);
        break;
      }

      // ── Chat ──
      case 'chat': {
        const room = rooms.get(client.room);
        if(!room) break;
        const sender = room.players.find(p=>p.ws===ws) || room.spectators?.find(p=>p.ws===ws);
        if(!sender) break;
        const chatMsg = {
          from:   sender.name,
          color:  sender.color || 'gray',
          avatar: sender.avatar,
          text:   String(msg.text).slice(0,200),
          emoji:  msg.emoji || null,
          ts:     Date.now()
        };
        room.chat.push(chatMsg);
        if(room.chat.length > 100) room.chat.shift();
        broadcast(room, { type:'chat', msg: chatMsg });
        break;
      }

      // ── Update Profile ──
      case 'update_profile': {
        const userId = msg.userId || clientId;
        const user   = getOrCreateUser(userId, msg.name, msg.avatar);
        if(msg.name)   user.name   = msg.name;
        if(msg.avatar) user.avatar = msg.avatar;
        send(ws, { type:'profile_updated', profile: getPublicProfile(userId) });
        // Update name in room
        const room = rooms.get(client.room);
        if(room){
          const p = room.players.find(pl=>pl.ws===ws);
          if(p){ p.name = user.name; p.avatar = user.avatar; }
        }
        break;
      }

      // ── Get Profile ──
      case 'get_profile': {
        const userId = msg.userId || clientId;
        const user   = getOrCreateUser(userId, msg.name, msg.avatar);
        send(ws, { type:'profile', profile: getPublicProfile(userId) });
        break;
      }

      // ── Google Auth (placeholder - integrate real OAuth in prod) ──
      case 'google_auth': {
        // In production: verify msg.idToken with Google APIs
        // For now, create/update user from provided data
        const userId = msg.googleId || uuidv4();
        const user   = getOrCreateUser(userId, msg.name, msg.picture);
        send(ws, { type:'auth_success', userId, profile: getPublicProfile(userId) });
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if(client?.room){
      const room = rooms.get(client.room);
      if(room){
        const p = room.players.find(pl=>pl.ws===ws);
        if(p){
          p.ws        = null;
          p.connected = false;
          broadcast(room, { type:'player_disconnected', color:p.color, name:p.name });
        }
        room.spectators = room.spectators?.filter(s=>s.ws!==ws) || [];
      }
    }
    clients.delete(ws);
  });
});

// ─────────────────────────────────────────────────────
//  REST API (stats, leaderboard)
// ─────────────────────────────────────────────────────
app.get('/api/profile/:userId', (req,res)=>{
  const p = getPublicProfile(req.params.userId);
  if(!p) return res.status(404).json({error:'Not found'});
  res.json(p);
});

app.get('/api/leaderboard', (req,res)=>{
  const all = [...users.values()]
    .sort((a,b)=>b.performanceRating-a.performanceRating)
    .slice(0,50)
    .map(u=>({ name:u.name, avatar:u.avatar, rating:u.performanceRating, level:u.level, gamesWon:u.gamesWon }));
  res.json(all);
});

app.get('/api/room/:code', (req,res)=>{
  const room = rooms.get(req.params.code);
  if(!room) return res.status(404).json({error:'Room not found'});
  res.json({ code:room.code, status:room.status, players:room.players.length, maxPlayers:room.maxPlayers });
});

// Serve index.html for all other routes
app.get('*', (req,res)=>{ res.sendFile(path.join(__dirname,'index.html')); });

// ─────────────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>{ console.log(`🎲 Ludo King Pro server running on port ${PORT}`); });
