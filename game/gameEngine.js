// NumLock 게임 엔진 — 순수 상태 변환 함수들 (소켓/타이밍은 server.js 담당)
//
// 중요: 줄 잠금(lockedColors)은 "게임 전체 공용" 상태다. 각 플레이어는 자기만의 점수판
// (board.checked)을 갖지만, 어떤 색이든 누군가 그 줄의 마지막 숫자를 체크하는 순간
// 그 색은 전원에게 즉시 잠기고 주사위 풀에서도 빠진다 (RULES.md 7번: "해당 줄은 누구도
// 더 이상 체크할 수 없습니다").

const SCORE_TABLE = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78];
const COLORS = ['r', 'y', 'g', 'b'];
const ROW_DEFS = {
  r: { order: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], lockValue: 12 },
  y: { order: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], lockValue: 12 },
  g: { order: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2], lockValue: 2 },
  b: { order: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2], lockValue: 2 },
};

function rand6() { return 1 + Math.floor(Math.random() * 6); }

function createBoard() {
  const board = {};
  for (const c of COLORS) board[c] = { checked: [] };
  return board;
}

function createGame(mode, players) {
  return {
    id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mode,
    status: 'playing',
    players: players.map(p => ({
      userCode: p.userCode, userName: p.userName, isAI: !!p.isAI, avatar: p.avatar,
      board: createBoard(), penalties: 0,
    })),
    turnIndex: 0,
    lockedColors: [],
    dice: null,
    phase: 'turn-start', // 'turn-start' | 'common' | 'extra' | 'ended'
    commonDecided: [],
    turnActed: { common: false, extra: false },
    createdAt: Date.now(),
  };
}

function getCurrentPlayer(game) {
  return game.players[game.turnIndex];
}

function cellIndex(color, value) {
  return ROW_DEFS[color].order.indexOf(value);
}

function maxCheckedIndex(board, color) {
  const checked = board[color].checked;
  if (checked.length === 0) return -1;
  return Math.max(...checked.map(v => cellIndex(color, v)));
}

// 체크 유효성: 안 잠긴 줄 + 그 줄에 존재하는 숫자 + 이미 체크 안 됨 +
// "이미 지나간 숫자가 아님"(진행방향 검증) + 마지막 숫자면 5개 이상 선체크 필요
function isValidCheck(game, player, color, value) {
  if (game.lockedColors.includes(color)) return false;
  const row = ROW_DEFS[color];
  const idx = cellIndex(color, value);
  if (idx === -1) return false;
  const board = player.board[color];
  if (board.checked.includes(value)) return false;
  if (idx <= maxCheckedIndex(player.board, color)) return false;
  if (value === row.lockValue && board.checked.length < 5) return false;
  return true;
}

function applyCheck(game, player, color, value) {
  player.board[color].checked.push(value);
  if (value === ROW_DEFS[color].lockValue && !game.lockedColors.includes(color)) {
    game.lockedColors.push(color);
  }
}

function rollDice(game) {
  const dice = { w1: rand6(), w2: rand6() };
  for (const c of COLORS) dice[c] = game.lockedColors.includes(c) ? null : rand6();
  game.dice = dice;
  game.phase = 'common';
  game.commonDecided = [];
  game.turnActed = { common: false, extra: false };
  return dice;
}

function getValidCommonColors(game, userCode) {
  if (game.phase !== 'common') return [];
  const player = game.players.find(p => p.userCode === userCode);
  if (!player) return [];
  const sum = game.dice.w1 + game.dice.w2;
  return COLORS.filter(c => isValidCheck(game, player, c, sum));
}

function commonCheck(game, userCode, color) {
  if (game.phase !== 'common') return { ok: false, msg: '지금은 공용 행동 단계가 아님' };
  if (game.commonDecided.includes(userCode)) return { ok: false, msg: '이미 이번 공용 행동을 마쳤음' };
  const player = game.players.find(p => p.userCode === userCode);
  if (!player) return { ok: false, msg: '플레이어 없음' };
  const sum = game.dice.w1 + game.dice.w2;
  if (!isValidCheck(game, player, color, sum)) return { ok: false, msg: '체크할 수 없는 칸' };

  applyCheck(game, player, color, sum);
  game.commonDecided.push(userCode);
  if (userCode === getCurrentPlayer(game).userCode) game.turnActed.common = true;
  return { ok: true, color, value: sum, locked: game.lockedColors.includes(color) };
}

function commonPass(game, userCode) {
  if (game.phase !== 'common') return { ok: false, msg: '지금은 공용 행동 단계가 아님' };
  if (game.commonDecided.includes(userCode)) return { ok: false, msg: '이미 처리됨' };
  game.commonDecided.push(userCode);
  return { ok: true };
}

function allCommonDecided(game) {
  return game.players.every(p => game.commonDecided.includes(p.userCode));
}

function startExtraAction(game) {
  game.phase = 'extra';
}

function getValidExtraOptions(game) {
  if (game.phase !== 'extra') return [];
  const player = getCurrentPlayer(game);
  const options = [];
  for (const w of ['w1', 'w2']) {
    for (const c of COLORS) {
      if (game.dice[c] == null) continue;
      const value = game.dice[w] + game.dice[c];
      if (isValidCheck(game, player, c, value)) options.push({ whiteSlot: w, color: c, value });
    }
  }
  return options;
}

function extraCheck(game, whiteSlot, color) {
  if (game.phase !== 'extra') return { ok: false, msg: '지금은 추가 행동 단계가 아님' };
  const player = getCurrentPlayer(game);
  if (game.dice[color] == null) return { ok: false, msg: '사용할 수 없는 색' };
  const value = game.dice[whiteSlot] + game.dice[color];
  if (!isValidCheck(game, player, color, value)) return { ok: false, msg: '체크할 수 없는 칸' };

  applyCheck(game, player, color, value);
  game.turnActed.extra = true;
  return { ok: true, color, value, locked: game.lockedColors.includes(color) };
}

// 턴 종료: 벌점 판정 → 종료조건 확인 → 다음 턴으로. { ended: bool }
function endTurn(game) {
  const player = getCurrentPlayer(game);
  if (!game.turnActed.common && !game.turnActed.extra) {
    player.penalties++;
  }

  if (game.lockedColors.length >= 2 || player.penalties >= 4) {
    game.status = 'ended';
    game.phase = 'ended';
    return { ended: true };
  }

  game.turnIndex = (game.turnIndex + 1) % game.players.length;
  game.phase = 'turn-start';
  game.dice = null;
  return { ended: false };
}

function rowScore(count) {
  return SCORE_TABLE[Math.min(count, SCORE_TABLE.length - 1)];
}

// 정산: 줄별 점수 + 벌점차감 → 순위(동점 처리) → 1등 보너스(공동1등이면 없음)
function calculateResults(game) {
  const scored = game.players.map(p => {
    const colorScores = {};
    let total = 0;
    for (const c of COLORS) {
      const s = rowScore(p.board[c].checked.length);
      colorScores[c] = s;
      total += s;
    }
    const penaltyDeduction = p.penalties * 5;
    return {
      userCode: p.userCode, userName: p.userName, isAI: p.isAI, avatar: p.avatar,
      colorScores, penalties: p.penalties, penaltyDeduction,
      rawScore: total - penaltyDeduction,
    };
  });

  const sorted = [...scored].sort((a, b) => b.rawScore - a.rawScore);
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].rank = (i > 0 && sorted[i].rawScore === sorted[i - 1].rawScore) ? sorted[i - 1].rank : rank;
    rank++;
  }

  const firstPlace = sorted.filter(r => r.rank === 1);
  const secondPlaceScore = sorted.find(r => r.rank === 2)?.rawScore;
  const bonus = (firstPlace.length === 1 && secondPlaceScore !== undefined)
    ? Math.max(0, firstPlace[0].rawScore - secondPlaceScore)
    : 0;

  for (const r of sorted) {
    r.bonus = r.rank === 1 ? bonus : 0;
    r.pointChange = r.rawScore + r.bonus;
  }

  return sorted;
}

module.exports = {
  COLORS, ROW_DEFS, SCORE_TABLE,
  createGame, getCurrentPlayer, rollDice,
  isValidCheck, getValidCommonColors, commonCheck, commonPass, allCommonDecided,
  startExtraAction, getValidExtraOptions, extraCheck,
  endTurn, calculateResults, rand6,
};
