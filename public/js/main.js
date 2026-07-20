const socket = io({ transports: ['websocket'] });
let me = null;

const AVATAR_MAP = {
  dice: '🎲', lion: '🦁', pig: '🐷', dog: '🐶', tiger: '🐯', rabbit: '🐰', panda: '🐼', bear: '🐻',
  fox: '🦊', frog: '🐸', koala: '🐨', cow: '🐮',
};

function setCookie(name, value, days = 365) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/`;
}
function getCookie(name) {
  const v = document.cookie.match(`(?:^|; )${name}=([^;]*)`);
  return v ? decodeURIComponent(v[1]) : null;
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ── 로그인 ─────────────────────────────────────────────────────────────
document.getElementById('btn-login').onclick = () => {
  const code = document.getElementById('input-usercode').value.trim();
  if (!code) return;
  socket.emit('login', { userCode: code });
};
document.getElementById('input-usercode').onkeydown = e => { if (e.key === 'Enter') document.getElementById('btn-login').click(); };

socket.on('loginSuccess', (user) => {
  me = user;
  setCookie('userCode', user.userCode);
  updateMainScreen();
  showScreen('screen-main');
});
socket.on('loginError', (msg) => {
  showScreen('screen-login');
  document.getElementById('login-error').textContent = msg;
});
socket.on('duplicateLogin', () => {
  socket.disconnect();
  alert('다른 기기에서 같은 계정으로 접속했습니다.');
  location.reload();
});

const savedCode = getCookie('userCode');
if (savedCode) socket.emit('login', { userCode: savedCode });

socket.on('connect', () => {
  if (savedCode && me) socket.emit('login', { userCode: savedCode });
});

function updateMainScreen() {
  document.getElementById('main-username').textContent = me.userName;
  document.getElementById('main-points').textContent = `${(me.singlePoints ?? 0).toLocaleString()}P`;
  document.getElementById('main-avatar').textContent = AVATAR_MAP[me.avatar] || '🎲';
}

// ── 싱글모드 시작 ──────────────────────────────────────────────────────
document.getElementById('btn-single').onclick = () => {
  document.getElementById('main-error').textContent = '';
  if ((me.singlePoints ?? 0) <= 0) {
    document.getElementById('main-error').textContent = '싱글 포인트가 없습니다. 설정에서 충전해주세요.';
    return;
  }
  location.href = 'game.html';
};

// ── 화면 이동 ──────────────────────────────────────────────────────────
document.querySelectorAll('[data-back]').forEach(el => {
  el.onclick = () => showScreen(el.dataset.back);
});
document.getElementById('btn-open-settings').onclick = () => openSettings();
document.getElementById('btn-open-settings2').onclick = () => openSettings();
document.getElementById('btn-open-help').onclick = () => showScreen('screen-help');
document.getElementById('btn-open-ranking').onclick = () => { showScreen('screen-ranking'); socket.emit('getRanking'); };

// ── 설정 ───────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-avatar-big').textContent = AVATAR_MAP[me.avatar] || '🎲';
  document.getElementById('settings-username').textContent = me.userName;
  document.getElementById('settings-single-points').textContent = `${(me.singlePoints ?? 0).toLocaleString()}P`;
  document.getElementById('settings-multi-points').textContent = `${(me.multiPoints ?? 0).toLocaleString()}P`;
  document.getElementById('toggle-show-online').classList.toggle('on', me.showOnline !== false);
  document.getElementById('admin-area').style.display = me.isAdmin ? '' : '';
  renderAvatarGrid();
  document.getElementById('settings-msg').textContent = '';
  showScreen('screen-settings');
}
function renderAvatarGrid() {
  const el = document.getElementById('avatar-grid');
  el.innerHTML = Object.entries(AVATAR_MAP).map(([key, emoji]) =>
    `<div class="av-item${key === me.avatar ? ' selected' : ''}" data-avatar="${key}">${emoji}</div>`
  ).join('');
  el.querySelectorAll('.av-item').forEach(item => {
    item.onclick = () => socket.emit('setAvatar', { avatar: item.dataset.avatar });
  });
}
socket.on('avatarSaved', ({ avatar }) => {
  me.avatar = avatar;
  renderAvatarGrid();
  document.getElementById('settings-avatar-big').textContent = AVATAR_MAP[avatar] || '🎲';
  document.getElementById('main-avatar').textContent = AVATAR_MAP[avatar] || '🎲';
});

document.getElementById('toggle-show-online').onclick = (e) => {
  const on = !e.currentTarget.classList.contains('on');
  socket.emit('setShowOnline', { show: on });
};
socket.on('showOnlineSaved', ({ show }) => {
  me.showOnline = show;
  document.getElementById('toggle-show-online').classList.toggle('on', show);
});

document.getElementById('btn-charge-single').onclick = () => socket.emit('chargeSingle');
socket.on('chargeResult', (r) => {
  if (r.ok) {
    me.singlePoints = r.singlePoints;
    document.getElementById('settings-single-points').textContent = `${r.singlePoints.toLocaleString()}P`;
    updateMainScreen();
    toast(`+${r.amount}P 충전됐어요!`);
  } else {
    document.getElementById('settings-msg').textContent = r.msg;
  }
});

document.getElementById('btn-logout').onclick = () => {
  setCookie('userCode', '', -1);
  location.reload();
};

// ── 도움말: 정적 화면, 별도 JS 없음 ───────────────────────────────────────

// ── 랭킹 ───────────────────────────────────────────────────────────────
let rankingData = null;
let activeRankMode = 'single';
document.getElementById('tab-rank-single').onclick = () => { activeRankMode = 'single'; renderRanking(); };
document.getElementById('tab-rank-multi').onclick = () => { activeRankMode = 'multi'; renderRanking(); };

socket.on('ranking', (data) => { rankingData = data; renderRanking(); });

function winRate(wins, games) {
  if (!games) return '-';
  return (Math.floor((wins / games) * 1000) / 10).toFixed(1) + '%';
}
function renderRanking() {
  document.getElementById('tab-rank-single').classList.toggle('active', activeRankMode === 'single');
  document.getElementById('tab-rank-multi').classList.toggle('active', activeRankMode === 'multi');
  const el = document.getElementById('rank-list');
  if (!rankingData) { el.innerHTML = ''; return; }
  const rows = rankingData[activeRankMode] || [];
  if (!rows.length) { el.innerHTML = '<div class="rank-empty">아직 기록이 없어요</div>'; return; }
  const ptKey = activeRankMode === 'multi' ? 'multiPoints' : 'singlePoints';
  const winsKey = activeRankMode === 'multi' ? 'multiWins' : 'singleWins';
  const gamesKey = activeRankMode === 'multi' ? 'multiGames' : 'singleGames';
  el.innerHTML = rows.map((r, i) => {
    const isTop1 = i === 0;
    const isMe = me && r.userCode === me.userCode;
    const wins = r[winsKey] ?? 0, games = r[gamesKey] ?? 0, losses = games - wins;
    return `<div class="rank-row${isTop1 ? ' top1' : ''}${isMe ? ' me' : ''}">
      <span class="rank-num">${isTop1 ? '👑' : (i + 1)}</span>
      <span class="rank-av">${AVATAR_MAP[r.avatar] || '🎲'}</span>
      <div class="rank-body">
        <span class="rank-nm">${r.userName}${isMe ? ' (나)' : ''}</span>
        <span class="rank-wl">${wins}승 ${losses}패</span>
      </div>
      <div class="rank-value">
        <span class="rank-pt">${(r[ptKey] ?? 0).toLocaleString()}P</span>
        <span class="rank-rate">${winRate(wins, games)}</span>
      </div>
    </div>`;
  }).join('');
}

// ── 관리자 ─────────────────────────────────────────────────────────────
document.getElementById('btn-admin-mode').onclick = () => {
  document.getElementById('input-admin-password').value = '';
  document.getElementById('admin-login-error').textContent = '';
  document.getElementById('modal-admin-login').classList.add('show');
};
document.getElementById('btn-admin-login-cancel').onclick = () => document.getElementById('modal-admin-login').classList.remove('show');
document.getElementById('btn-admin-login-submit').onclick = () => {
  socket.emit('adminLogin', { password: document.getElementById('input-admin-password').value });
};
socket.on('adminLoginResult', ({ ok }) => {
  if (ok) {
    document.getElementById('modal-admin-login').classList.remove('show');
    socket.emit('adminGetUsers');
    document.getElementById('modal-admin-users').classList.add('show');
  } else {
    document.getElementById('admin-login-error').textContent = '비밀번호가 틀렸습니다.';
  }
});
document.getElementById('btn-admin-users-close').onclick = () => document.getElementById('modal-admin-users').classList.remove('show');
document.getElementById('btn-admin-add-user').onclick = () => {
  const userCode = document.getElementById('input-new-usercode').value.trim();
  const userName = document.getElementById('input-new-username').value.trim();
  if (!userCode || !userName) return;
  socket.emit('adminSaveUser', { userCode, userName, isAdmin: false });
  document.getElementById('input-new-usercode').value = '';
  document.getElementById('input-new-username').value = '';
};
socket.on('adminUsers', (users) => {
  document.getElementById('admin-user-list').innerHTML = users.map(u => `
    <div class="admin-user-row">
      <span class="code">${u.userCode}</span><span>${u.userName}</span>
      <span class="del" data-code="${u.userCode}">삭제</span>
    </div>
  `).join('');
  document.querySelectorAll('.admin-user-row .del').forEach(el => {
    el.onclick = () => { if (confirm(`${el.dataset.code} 삭제할까요?`)) socket.emit('adminDeleteUser', { userCode: el.dataset.code }); };
  });
});
socket.on('adminSaveUserError', (msg) => toast(msg));
