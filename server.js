const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db/database');
const engine = require('./game/gameEngine');
const ai = require('./game/aiPlayer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map(); // socket.id -> { userCode, userName, isAdmin }
const singleGames = new Map(); // userCode -> game (only the human owns the entry; AI들은 game.players 안에만 존재)

const AVATAR_MAP = {
  dice: '🎲', lion: '🦁', pig: '🐷', dog: '🐶', tiger: '🐯', rabbit: '🐰', panda: '🐼', bear: '🐻',
  fox: '🦊', frog: '🐸', koala: '🐨', cow: '🐮',
};
const AI_POOL = [
  { userCode: 'AI_1', userName: '돼지', avatar: 'pig' },
  { userCode: 'AI_2', userName: '호랑이', avatar: 'tiger' },
  { userCode: 'AI_3', userName: '강아지', avatar: 'dog' },
];

const COMMON_TIMEOUT_MS = 10000;
const EXTRA_TIMEOUT_MS = 10000;
const ROLL_ANIM_MS = 1100;
const AI_COMMON_DELAYS = [1500, 2000, 3000];

function getSocketId(userCode) {
  for (const [sid, s] of sessions) if (s.userCode === userCode) return sid;
  return null;
}
function emitToPlayer(userCode, event, data) {
  const sid = getSocketId(userCode);
  if (sid) io.to(sid).emit(event, data);
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── 공개 상태 (숨길 정보가 없는 게임이라 다들 동일한 뷰) ─────────────────────
function getPublicState(game) {
  const cur = engine.getCurrentPlayer(game);
  return {
    id: game.id,
    status: game.status,
    phase: game.phase,
    paused: !!game.paused,
    lockedColors: game.lockedColors,
    dice: game.dice,
    currentPlayerCode: cur?.userCode,
    commonDecided: game.commonDecided,
    turnActed: game.turnActed,
    players: game.players.map(p => ({
      userCode: p.userCode, userName: p.userName, isAI: p.isAI, avatar: p.avatar,
      board: { r: p.board.r.checked, y: p.board.y.checked, g: p.board.g.checked, b: p.board.b.checked },
      penalties: p.penalties,
    })),
  };
}

function broadcastGame(game) {
  const human = game.players.find(p => !p.isAI);
  if (!human) return;
  const state = getPublicState(game);
  state.myValidCommonColors = game.phase === 'common' ? engine.getValidCommonColors(game, human.userCode) : [];
  state.myValidExtraOptions = (game.phase === 'extra' && engine.getCurrentPlayer(game).userCode === human.userCode)
    ? engine.getValidExtraOptions(game) : [];
  emitToPlayer(human.userCode, 'gameState', state);
}

function clearGameTimers(game) {
  if (game.commonTimer) { clearTimeout(game.commonTimer); game.commonTimer = null; }
  if (game.extraTimer) { clearTimeout(game.extraTimer); game.extraTimer = null; }
  if (game.aiTimers) { game.aiTimers.forEach(t => clearTimeout(t)); }
  game.aiTimers = [];
}

// ── 턴 진행 오케스트레이션 ────────────────────────────────────────────────
function startTurn(game) {
  if (game.status !== 'playing' || game.paused) return;
  game.phase = 'turn-start';
  game.dice = null;
  broadcastGame(game);
  const cur = engine.getCurrentPlayer(game);
  if (cur.isAI) {
    const t = setTimeout(() => actuallyRoll(game), ROLL_ANIM_MS);
    game.aiTimers = [t];
  }
  // 사람 턴이면 'rollDice' 소켓 이벤트를 기다림 (타임아웃 없음 — 본인 턴 시작은 재촉 안 함)
}

function actuallyRoll(game) {
  if (game.status !== 'playing' || game.paused) return;
  engine.rollDice(game);
  broadcastGame(game);
  scheduleAICommonDecisions(game);
  game.commonTimer = setTimeout(() => forceCommonTimeout(game), COMMON_TIMEOUT_MS);
}

function scheduleAICommonDecisions(game) {
  game.aiTimers = [];
  game.players.forEach((p, seatIdx) => {
    if (!p.isAI) return;
    const delay = pick(AI_COMMON_DELAYS);
    const t = setTimeout(() => {
      if (game.status !== 'playing' || game.paused || game.phase !== 'common') return;
      if (game.commonDecided.includes(p.userCode)) return;
      const valid = engine.getValidCommonColors(game, p.userCode);
      const color = ai.decideCommonAction(game, p, valid, ai.boldnessFor(seatIdx));
      if (color) engine.commonCheck(game, p.userCode, color);
      else engine.commonPass(game, p.userCode);
      broadcastGame(game);
      maybeAdvanceFromCommon(game);
    }, delay);
    game.aiTimers.push(t);
  });
}

function forceCommonTimeout(game) {
  if (game.status !== 'playing' || game.paused || game.phase !== 'common') return;
  for (const p of game.players) {
    if (!game.commonDecided.includes(p.userCode)) engine.commonPass(game, p.userCode);
  }
  proceedToExtra(game);
}

function maybeAdvanceFromCommon(game) {
  if (game.phase === 'common' && engine.allCommonDecided(game)) proceedToExtra(game);
}

function proceedToExtra(game) {
  if (game.phase !== 'common' || game.status !== 'playing' || game.paused) return;
  if (game.commonTimer) { clearTimeout(game.commonTimer); game.commonTimer = null; }
  engine.startExtraAction(game);
  broadcastGame(game);

  const cur = engine.getCurrentPlayer(game);
  if (cur.isAI) {
    const opts = engine.getValidExtraOptions(game);
    const pickOpt = ai.decideExtraAction(game, cur, opts, game.turnActed.common, ai.boldnessFor(game.turnIndex));
    if (pickOpt) engine.extraCheck(game, pickOpt.whiteSlot, pickOpt.color);
    finishTurnAndAdvance(game);
  } else {
    game.extraTimer = setTimeout(() => finishTurnAndAdvance(game), EXTRA_TIMEOUT_MS);
  }
}

function finishTurnAndAdvance(game) {
  if (game.phase !== 'extra' || game.status !== 'playing' || game.paused) return;
  if (game.extraTimer) { clearTimeout(game.extraTimer); game.extraTimer = null; }
  broadcastGame(game);
  const result = engine.endTurn(game);
  broadcastGame(game);
  if (result.ended) {
    setTimeout(() => handleGameEnd(game), 400);
  } else {
    setTimeout(() => startTurn(game), 500);
  }
}

async function handleGameEnd(game) {
  clearGameTimers(game);
  const results = engine.calculateResults(game);
  await db.saveGameResult(game.id, game.mode, results);

  const human = game.players.find(p => !p.isAI);
  const updatedUser = human ? await db.getUser(human.userCode) : null;
  emitToPlayer(human?.userCode, 'gameEnd', {
    results,
    singlePoints: updatedUser?.singlePoints,
  });
  if (human) singleGames.delete(human.userCode);
}

// ── Socket.io ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('login', async ({ userCode } = {}) => {
    const code = (userCode || '').trim();
    if (!code) { socket.emit('loginError', '코드를 입력해주세요.'); return; }
    let user = await db.getUser(code);
    if (!user) { socket.emit('loginError', '등록되지 않은 코드입니다.'); return; }

    for (const [oldSid, s] of sessions) {
      if (s.userCode === user.userCode && oldSid !== socket.id) {
        io.to(oldSid).emit('duplicateLogin');
        io.sockets.sockets.get(oldSid)?.disconnect(true);
        sessions.delete(oldSid);
        break;
      }
    }

    sessions.set(socket.id, { userCode: user.userCode, userName: user.userName, isAdmin: user.isAdmin === 1 });
    socket.emit('loginSuccess', {
      userCode: user.userCode, userName: user.userName, isAdmin: user.isAdmin === 1,
      avatar: user.avatar, singlePoints: user.singlePoints, multiPoints: user.multiPoints,
      showOnline: user.showOnline !== 0,
    });

    const existing = singleGames.get(user.userCode);
    if (existing && existing.status === 'playing') {
      broadcastGame(existing);
    }
  });

  socket.on('startSingle', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const user = await db.getUser(sess.userCode);
    if (!user) return;
    if (user.singlePoints <= 0) { socket.emit('startSingleError', '싱글 포인트가 없습니다. 설정에서 충전해주세요.'); return; }

    const prev = singleGames.get(user.userCode);
    if (prev) clearGameTimers(prev);

    const aiPlayers = [...AI_POOL].sort(() => Math.random() - 0.5).map(a => ({ ...a, isAI: true }));
    const human = { userCode: user.userCode, userName: user.userName, isAI: false, avatar: user.avatar || 'dice' };
    const players = [human, ...aiPlayers].sort(() => Math.random() - 0.5);

    const game = engine.createGame('single', players);
    game.paused = false;
    singleGames.set(user.userCode, game);
    startTurn(game);
  });

  socket.on('rollDice', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game || game.status !== 'playing' || game.paused || game.phase !== 'turn-start') return;
    const cur = engine.getCurrentPlayer(game);
    if (cur.userCode !== sess.userCode || cur.isAI) return;
    actuallyRoll(game);
  });

  socket.on('commonCheck', ({ color } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game || game.status !== 'playing' || game.paused) return;
    const res = engine.commonCheck(game, sess.userCode, color);
    if (!res.ok) { socket.emit('actionError', res.msg); return; }
    broadcastGame(game);
    maybeAdvanceFromCommon(game);
  });

  socket.on('commonPass', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game || game.status !== 'playing' || game.paused) return;
    const res = engine.commonPass(game, sess.userCode);
    if (!res.ok) return;
    broadcastGame(game);
    maybeAdvanceFromCommon(game);
  });

  socket.on('extraCheck', ({ whiteSlot, color } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game || game.status !== 'playing' || game.paused) return;
    const cur = engine.getCurrentPlayer(game);
    if (cur.userCode !== sess.userCode) return;
    const res = engine.extraCheck(game, whiteSlot, color);
    if (!res.ok) { socket.emit('actionError', res.msg); return; }
    finishTurnAndAdvance(game);
  });

  socket.on('extraPass', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game || game.status !== 'playing' || game.paused) return;
    const cur = engine.getCurrentPlayer(game);
    if (cur.userCode !== sess.userCode || game.phase !== 'extra') return;
    finishTurnAndAdvance(game);
  });

  socket.on('pauseGame', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game || game.status !== 'playing') return;
    game.paused = true;
    clearGameTimers(game);
    broadcastGame(game);
  });

  socket.on('resumeGame', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game || game.status !== 'playing' || !game.paused) return;
    game.paused = false;
    broadcastGame(game);
    // 재개 시 진행 중이던 단계를 정확히 이어가기보단, 안전하게 그 단계를 새로 시작
    if (game.phase === 'turn-start') startTurn(game);
    else if (game.phase === 'common') { game.commonTimer = setTimeout(() => forceCommonTimeout(game), COMMON_TIMEOUT_MS); scheduleAICommonDecisions(game); }
    else if (game.phase === 'extra') {
      const cur = engine.getCurrentPlayer(game);
      if (!cur.isAI) game.extraTimer = setTimeout(() => finishTurnAndAdvance(game), EXTRA_TIMEOUT_MS);
    }
  });

  // 훌라와 동일: 싱글모드는 본인 게임이라 누구나(관리자 아니어도) 중단 가능
  socket.on('adminStopGame', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = singleGames.get(sess.userCode);
    if (!game) return;
    clearGameTimers(game);
    singleGames.delete(sess.userCode);
    emitToPlayer(sess.userCode, 'gameStopped', {});
  });

  socket.on('chargeSingle', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const result = await db.chargeSingle(sess.userCode);
    const user = await db.getUser(sess.userCode);
    socket.emit('chargeResult', { ...result, singlePoints: user?.singlePoints });
  });

  socket.on('setAvatar', async ({ avatar } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess || !AVATAR_MAP[avatar]) return;
    await db.updateUser(sess.userCode, { avatar });
    socket.emit('avatarSaved', { avatar });
  });

  socket.on('setShowOnline', async ({ show } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    await db.updateUser(sess.userCode, { showOnline: show ? 1 : 0 });
    socket.emit('showOnlineSaved', { show: !!show });
  });

  socket.on('getRanking', async () => {
    const [single, multi] = await Promise.all([db.getSingleRanking(), db.getMultiRanking()]);
    socket.emit('ranking', { single, multi });
  });

  // ── 관리자 (훌라와 동일한 패턴) ────────────────────────────────────────
  socket.on('adminLogin', async ({ password } = {}) => {
    const stored = await db.getSetting('adminPassword');
    socket.emit('adminLoginResult', { ok: password === stored });
  });

  socket.on('adminGetUsers', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    socket.emit('adminUsers', await db.getAllUsers());
  });

  socket.on('adminSaveUser', async ({ userCode, userName, isAdmin } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    const existing = await db.getUser(userCode);
    if (existing) {
      await db.updateUser(userCode, { userName, isAdmin: isAdmin ? 1 : 0 });
    } else {
      const count = await db.getUserCount();
      if (count >= 30) { socket.emit('adminSaveUserError', '최대 30명까지 등록 가능합니다.'); return; }
      await db.createUser(userCode, userName, isAdmin ? 1 : 0);
    }
    socket.emit('adminUsers', await db.getAllUsers());
  });

  socket.on('adminDeleteUser', async ({ userCode } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    await db.deleteUser(userCode);
    socket.emit('adminUsers', await db.getAllUsers());
  });

  socket.on('disconnect', () => {
    const sess = sessions.get(socket.id);
    if (sess) {
      const game = singleGames.get(sess.userCode);
      if (game && game.status === 'playing' && !game.paused) {
        game.paused = true;
        clearGameTimers(game);
      }
    }
    sessions.delete(socket.id);
  });
});

// ── Start ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3100;
db.init().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`NumLock 서버 실행 중: http://localhost:${PORT}`);
  });
});
