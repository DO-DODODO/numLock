// NumLock AI 로직 — 전부 확률 기반 (하드 threshold 없음), AI 3명은 boldness로 성향 차이

const engine = require('./gameEngine');

// 간격(gap) → 체크 확률(%) — 값 사이는 선형 보간, 범위 밖은 양끝값으로 고정
const GAP_CURVE = [[1, 90], [2, 75], [3, 55], [5, 25], [8, 5]];
function gapProbability(gap) {
  if (gap <= GAP_CURVE[0][0]) return GAP_CURVE[0][1];
  if (gap >= GAP_CURVE[GAP_CURVE.length - 1][0]) return GAP_CURVE[GAP_CURVE.length - 1][1];
  for (let i = 0; i < GAP_CURVE.length - 1; i++) {
    const [g1, p1] = GAP_CURVE[i], [g2, p2] = GAP_CURVE[i + 1];
    if (gap >= g1 && gap <= g2) return p1 + (p2 - p1) * (gap - g1) / (g2 - g1);
  }
  return 5;
}

// 그 줄에 이미 체크된 칸 수 → 잠금 의향 확률(%) 기본값 (선형 보간, 5칸=40%, 8칸+=85%)
const LOCK_COUNT_CURVE = [[5, 40], [8, 85]];
function lockCountProbability(checkedCount) {
  const [g1, p1] = LOCK_COUNT_CURVE[0], [g2, p2] = LOCK_COUNT_CURVE[1];
  if (checkedCount <= g1) return p1;
  if (checkedCount >= g2) return p2;
  return p1 + (p2 - p1) * (checkedCount - g1) / (g2 - g1);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 현재 시점 대략적인 순위(1~인원수) — 잠금 판단용 "앞서고 있는지" 참고 자료
function estimateLiveRank(game, userCode) {
  const scored = game.players.map(p => {
    let total = 0;
    for (const c of engine.COLORS) total += engine.SCORE_TABLE[Math.min(p.board[c].checked.length, 12)];
    return { userCode: p.userCode, score: total - p.penalties * 5 };
  }).sort((a, b) => b.score - a.score);
  const idx = scored.findIndex(s => s.userCode === userCode);
  return { rank: idx + 1, total: scored.length };
}

function rowGap(player, color, value) {
  const idx = engine.ROW_DEFS[color].order.indexOf(value);
  const checked = player.board[color].checked;
  const maxIdx = checked.length === 0 ? -1 : Math.max(...checked.map(v => engine.ROW_DEFS[color].order.indexOf(v)));
  return idx - maxIdx;
}

// candidate 하나를 체크할지 말지 확률 판정 (잠금값이면 별도 공식 사용)
function willCheck(game, player, color, value, boldness) {
  const isLockValue = value === engine.ROW_DEFS[color].lockValue;
  let prob;
  if (isLockValue) {
    const countProb = lockCountProbability(player.board[color].checked.length);
    const { rank, total } = estimateLiveRank(game, player.userCode);
    // 앞서있으면(순위 좋음) 확률↑(빨리 끝내려함), 뒤처지면↓(판을 끌어서 역전 노림)
    const normalizedLead = total <= 1 ? 0.5 : (total - rank) / (total - 1); // 0(꼴찌)~1(1등)
    const rankAdjust = (normalizedLead - 0.5) * 40; // -20 ~ +20
    prob = countProb + rankAdjust;
  } else {
    prob = gapProbability(rowGap(player, color, value));
  }
  prob = clamp(prob + boldness, 3, 97);
  return Math.random() * 100 < prob;
}

// ── 공용 행동 ──────────────────────────────────────────────────────────
// validColors: engine.getValidCommonColors() 결과. 반환: color(체크할 색) | null(패스)
function decideCommonAction(game, player, validColors, boldness = 0) {
  if (validColors.length === 0) return null;
  const sum = game.dice.w1 + game.dice.w2;
  // 간격이 작은(=더 자연스러운) 후보부터 시도 — 여러 색이 유효해도 하나만 고름
  const ranked = [...validColors].sort((a, b) => rowGap(player, a, sum) - rowGap(player, b, sum));
  for (const color of ranked) {
    if (willCheck(game, player, color, sum, boldness)) return color;
  }
  return null;
}

// ── 추가 행동 ──────────────────────────────────────────────────────────
// options: engine.getValidExtraOptions() 결과. usedCommonThisTurn: 이번 턴 공용행동에서 체크했는지
// 반환: { whiteSlot, color } | null(패스)
function decideExtraAction(game, player, options, usedCommonThisTurn, boldness = 0) {
  if (options.length === 0) return null;
  // 이번 턴 마지막 기회인데 공용 행동을 이미 패스했다면 절박도 보정(확률 크게↑)
  const urgencyBoost = usedCommonThisTurn ? 0 : 35;
  const ranked = [...options].sort((a, b) => rowGap(player, a.color, a.value) - rowGap(player, b.color, b.value));
  for (const opt of ranked) {
    if (willCheck(game, player, opt.color, opt.value, boldness + urgencyBoost)) {
      return { whiteSlot: opt.whiteSlot, color: opt.color };
    }
  }
  return null;
}

// AI 3명의 성향 차이(확률 곡선 기울기 대신 오프셋으로 단순 구현) — 매번 다르게 느껴지도록
const PERSONALITIES = [-8, 0, 8]; // 소극적 / 보통 / 적극적
function boldnessFor(seatIndex) { return PERSONALITIES[seatIndex % PERSONALITIES.length]; }

module.exports = { decideCommonAction, decideExtraAction, boldnessFor, gapProbability, lockCountProbability };
