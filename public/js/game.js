const socket = io({ transports: ['websocket'] });

function getCookie(name) {
  const v = document.cookie.match(`(?:^|; )${name}=([^;]*)`);
  return v ? decodeURIComponent(v[1]) : null;
}
const userCode = getCookie('userCode');
if (!userCode) location.href = '/';

const AVATAR_MAP = {
  dice: '🎲', lion: '🦁', pig: '🐷', dog: '🐶', tiger: '🐯', rabbit: '🐰', panda: '🐼', bear: '🐻',
  fox: '🦊', frog: '🐸', koala: '🐨', cow: '🐮',
};
const COLOR_NAMES = { r: '빨강', y: '노랑', g: '초록', b: '파랑' };
const ROW_ORDER = {
  r: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], y: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  g: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2], b: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
};

let gameState = null;
let lastPhaseKey = null; // 롤 오버레이 중복 트리거 방지용
let selectedWhite = null, selectedColor = null;
let countdownInterval = null;

let wakeLock = null;
async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {} }
function releaseWakeLock() { wakeLock?.release(); wakeLock = null; }

let initialConnectDone = false;
socket.on('connect', () => socket.emit('login', { userCode }));
socket.on('loginSuccess', () => {
  requestWakeLock();
  document.getElementById('admin-controls').style.display = ''; // 싱글모드는 본인 게임이라 항상 노출(훌라와 동일)
  if (!gameState && !initialConnectDone) {
    initialConnectDone = true;
    socket.emit('startSingle');
  }
});
socket.on('loginError', () => { location.href = '/'; });
socket.on('duplicateLogin', () => { alert('다른 기기에서 접속했습니다.'); location.href = '/'; });
socket.on('startSingleError', (msg) => { alert(msg); location.href = '/'; });

socket.on('actionError', () => {}); // 서버가 최종 검증, 실패해도 다음 state로 자연 복구됨

// ── 보드 렌더링 ────────────────────────────────────────────────────────
function renderBoardGrid(state) {
  const grid = document.getElementById('board-grid');
  const cur = state.currentPlayerCode;
  const myValidCommon = new Set(state.myValidCommonColors || []);
  const myExtraByCombo = {}; // "whiteSlot:color" -> value, for lookups
  (state.myValidExtraOptions || []).forEach(o => { myExtraByCombo[o.whiteSlot + ':' + o.color] = o.value; });

  grid.innerHTML = state.players.map(p => {
    const isMe = p.userCode === userCode;
    const isActive = p.userCode === cur;
    const cardClass = ['board-card', isMe && 'me', isActive && 'active'].filter(Boolean).join(' ');
    const avatarEmoji = AVATAR_MAP[p.avatar] || (p.isAI ? '🤖' : '👤');
    const rows = ['r', 'y', 'g', 'b'].map(c => {
      const order = ROW_ORDER[c];
      const checkedSet = new Set(p.board[c]);
      const isLocked = state.lockedColors.includes(c);
      const lockValue = order[order.length - 1];
      const cells = order.map(v => {
        const checked = checkedSet.has(v);
        let extraClass = '';
        if (isMe && !checked && !isLocked) {
          if (state.phase === 'common' && myValidCommon.has(c) && (state.dice?.w1 + state.dice?.w2) === v) extraClass = ' candidate';
          if (state.phase === 'extra' && isActive) {
            if (myExtraByCombo['w1:' + c] === v || myExtraByCombo['w2:' + c] === v) extraClass = ' extra-candidate';
          }
        }
        return `<div class="b-cell${checked ? ' checked' : ''}${extraClass}" data-color="${c}" data-value="${v}">${v}</div>`;
      }).join('');
      const lockCell = `<div class="b-cell lock${isLocked ? ' checked' : ''}" style="${isLocked ? `background:var(--${c});box-shadow:0 0 5px var(--${c})` : ''}">🔒</div>`;
      return `<div class="b-row" data-c="${c}"><div class="rlabel"></div><div class="b-cells">${cells}${lockCell}</div></div>`;
    }).join('');
    return `<div class="${cardClass}">
      <div class="board-head"><span class="av">${avatarEmoji}</span><span class="nm">${p.userName}${isMe ? ' (나)' : ''}</span><span class="pen">벌점${p.penalties}</span></div>
      <div class="board-rows">${rows}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.b-cell.candidate').forEach(cell => {
    cell.onclick = () => socket.emit('commonCheck', { color: cell.dataset.color });
  });
  grid.querySelectorAll('.b-cell.extra-candidate').forEach(cell => {
    cell.onclick = () => {
      const combo = (state.myValidExtraOptions || []).find(o => o.color === cell.dataset.color && String(o.value) === cell.dataset.value);
      if (combo) socket.emit('extraCheck', { whiteSlot: combo.whiteSlot, color: combo.color });
    };
  });
}

function renderDice(state) {
  const diceEl = document.getElementById('dice-row');
  ['w1', 'w2', 'r', 'y', 'g', 'b'].forEach(slot => {
    const die = diceEl.querySelector(`[data-slot="${slot}"]`);
    const val = state.dice?.[slot];
    die.textContent = val == null ? '?' : val;
    die.classList.toggle('dim', val == null);
    die.classList.remove('selected', 'clickable');
  });

  const isMyExtraTurn = state.phase === 'extra' && state.currentPlayerCode === userCode;
  if (isMyExtraTurn) {
    ['w1', 'w2'].forEach(slot => {
      const die = diceEl.querySelector(`[data-slot="${slot}"]`);
      if (!selectedWhite) die.classList.add('clickable');
      if (selectedWhite === slot) die.classList.add('selected');
    });
    ['r', 'y', 'g', 'b'].forEach(slot => {
      const die = diceEl.querySelector(`[data-slot="${slot}"]`);
      if (state.dice?.[slot] == null) return;
      if (!selectedColor) die.classList.add('clickable');
      if (selectedColor === slot) die.classList.add('selected');
    });
  }
}

document.getElementById('dice-row').addEventListener('click', (e) => {
  if (!gameState || gameState.phase !== 'extra' || gameState.currentPlayerCode !== userCode) return;
  const die = e.target.closest('.die');
  if (!die || !die.classList.contains('clickable')) return;
  const slot = die.dataset.slot;
  if (slot === 'w1' || slot === 'w2') { if (selectedWhite) return; selectedWhite = slot; }
  else { if (selectedColor) return; selectedColor = slot; }
  updateComboHint();
  renderDice(gameState);
  renderBoardGrid(gameState);
});

function updateComboHint() {
  const hint = document.getElementById('combo-hint');
  if (!selectedWhite && !selectedColor) { hint.style.display = 'none'; return; }
  hint.style.display = '';
  if (!selectedWhite || !selectedColor) {
    hint.textContent = selectedWhite ? '색깔 주사위도 골라주세요' : '흰 주사위도 골라주세요';
    return;
  }
  const combo = (gameState.myValidExtraOptions || []).find(o => o.whiteSlot === selectedWhite && o.color === selectedColor);
  if (combo) {
    hint.innerHTML = `${COLOR_NAMES[selectedColor]} <b style="color:#fff">${combo.value}</b> 확정 — 점수판에서 탭해 체크`;
  } else {
    const w = gameState.dice[selectedWhite], c = gameState.dice[selectedColor];
    hint.textContent = `${COLOR_NAMES[selectedColor]} ${w + c} — 이미 체크됐거나 불가능해서 패스돼요`;
    setTimeout(() => { if (gameState.phase === 'extra') socket.emit('extraPass'); }, 1400);
  }
}

// ── 상단 헤더 / 버튼 상태 ──────────────────────────────────────────────
function renderHeader(state) {
  const turnText = document.getElementById('turn-text');
  const cur = state.players.find(p => p.userCode === state.currentPlayerCode);
  const isMe = state.currentPlayerCode === userCode;
  const who = isMe ? '내' : `${cur?.userName}님`;

  const btnRoll = document.getElementById('btn-roll');
  const btnPassCommon = document.getElementById('btn-pass-common');
  const btnPassExtra = document.getElementById('btn-pass-extra');
  btnRoll.style.display = 'none'; btnPassCommon.style.display = 'none'; btnPassExtra.style.display = 'none';

  if (state.phase === 'turn-start') {
    turnText.innerHTML = isMe ? '<b>내 차례</b> — 주사위를 굴려주세요' : `<b>${cur?.userName}</b>님 차례`;
    if (isMe) btnRoll.style.display = '';
  } else if (state.phase === 'common') {
    turnText.innerHTML = `${who} 공용 행동 — 흰 합 <b>${state.dice.w1 + state.dice.w2}</b>`;
    if (!(state.commonDecided || []).includes(userCode)) btnPassCommon.style.display = '';
  } else if (state.phase === 'extra') {
    turnText.innerHTML = isMe ? '<b>추가 행동</b> — 주사위를 선택하세요' : `${cur?.userName}님 추가 행동 중`;
    if (isMe && !selectedWhite && !selectedColor) btnPassExtra.style.display = '';
  }

  startCountdown(state);
}

function startCountdown(state) {
  clearInterval(countdownInterval);
  const timerEl = document.getElementById('timer-mini');
  if (state.phase !== 'common' && state.phase !== 'extra') { timerEl.style.display = 'none'; return; }
  timerEl.style.display = '';
  let t = 10;
  timerEl.textContent = t;
  countdownInterval = setInterval(() => {
    t--;
    if (t < 0) { clearInterval(countdownInterval); return; }
    timerEl.textContent = t;
  }, 1000);
}

document.getElementById('btn-roll').onclick = () => socket.emit('rollDice');
document.getElementById('btn-pass-common').onclick = () => socket.emit('commonPass');
document.getElementById('btn-pass-extra').onclick = () => socket.emit('extraPass');

// ── 다른 사람 주사위 굴리는 순간 오버레이 ─────────────────────────────────
function maybeShowRollOverlay(state) {
  const overlay = document.getElementById('roll-overlay');
  const key = state.phase + ':' + state.currentPlayerCode + ':' + (state.dice ? 'rolled' : 'pending');
  if (state.phase === 'turn-start' && state.currentPlayerCode !== userCode) {
    const cur = state.players.find(p => p.userCode === state.currentPlayerCode);
    document.getElementById('roll-name').textContent = `${cur?.userName}님 차례`;
    document.getElementById('roll-avatar').textContent = AVATAR_MAP[cur?.avatar] || '🤖';
    overlay.classList.add('show');
  } else {
    overlay.classList.remove('show');
  }
  lastPhaseKey = key;
}

// ── 게임 상태 수신 ─────────────────────────────────────────────────────
socket.on('gameState', (state) => {
  const isNewTurnCycle = !gameState || gameState.currentPlayerCode !== state.currentPlayerCode || gameState.phase !== state.phase;
  if (state.phase !== 'extra' || state.currentPlayerCode !== userCode) { selectedWhite = null; selectedColor = null; }
  gameState = state;

  document.getElementById('pause-overlay').classList.toggle('show', !!state.paused);
  if (state.paused) { releaseWakeLock(); return; }
  requestWakeLock();

  maybeShowRollOverlay(state);
  renderDice(state);
  renderBoardGrid(state);
  renderHeader(state);
  if (isNewTurnCycle) updateComboHint();
  document.getElementById('combo-hint').style.display = (state.phase === 'extra' && state.currentPlayerCode === userCode && (selectedWhite || selectedColor)) ? '' : 'none';
});

socket.on('gameEnd', ({ results, singlePoints }) => {
  releaseWakeLock();
  document.getElementById('roll-overlay').classList.remove('show');
  const winners = results.filter(r => r.rank === 1);
  document.getElementById('results-winner-text').textContent =
    winners.length > 1 ? `${winners.map(w => w.userName).join(', ')}님 공동 우승!` : `${winners[0].userName}님 승리!`;

  document.getElementById('results-list').innerHTML = results.map(r => {
    const isMe = r.userCode === userCode;
    const cls = ['result-row', r.rank === 1 && 'win', isMe && 'me'].filter(Boolean).join(' ');
    const avatarEmoji = AVATAR_MAP[r.avatar] || (r.isAI ? '🤖' : '👤');
    const breakdown = `빨강${r.colorScores.r} 노랑${r.colorScores.y} 초록${r.colorScores.g} 파랑${r.colorScores.b} · 벌점${r.penalties}(-${r.penaltyDeduction})`;
    return `<div class="${cls}">
      <span class="result-rank">${r.rank}</span><span class="result-av">${avatarEmoji}</span>
      <div class="result-body"><div class="result-nm">${r.userName}${isMe ? ' (나)' : ''}</div><div class="result-breakdown">${breakdown}</div></div>
      <div class="result-scores">
        <span class="result-final">${r.rawScore}점</span>
        ${r.bonus > 0 ? `<span class="result-bonus">1등 보너스 +${r.bonus}</span>` : ''}
        <span class="result-pt">${r.pointChange >= 0 ? '+' : ''}${r.pointChange}P</span>
      </div>
    </div>`;
  }).join('');
  document.getElementById('results-overlay').classList.add('show');
});

document.getElementById('btn-play-again').onclick = () => {
  document.getElementById('results-overlay').classList.remove('show');
  const trans = document.getElementById('trans-overlay');
  trans.classList.add('show');
  setTimeout(() => {
    trans.classList.remove('show');
    socket.emit('startSingle');
  }, 900);
};
document.getElementById('btn-go-main').onclick = () => { socket.disconnect(); location.href = '/'; };

// ── 일시정지/관리자 ────────────────────────────────────────────────────
document.getElementById('btn-resume').onclick = () => socket.emit('resumeGame');
document.getElementById('btn-pause').onclick = () => socket.emit('pauseGame');
document.getElementById('btn-admin-stop').onclick = () => { if (confirm('게임을 중단할까요?')) socket.emit('adminStopGame'); };
socket.on('gameStopped', () => { alert('게임이 중단됐습니다.'); location.href = '/'; });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gameState?.status === 'playing' && !gameState.paused) requestWakeLock();
});
