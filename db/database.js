const createDb = require('@databases/sqlite').default;
const { sql } = require('@databases/sqlite');
const path = require('path');

let db;

async function init() {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'numlock.db');
  db = createDb(dbPath);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS users (
      userCode TEXT PRIMARY KEY,
      userName TEXT NOT NULL,
      avatar TEXT DEFAULT 'dice',
      isAdmin INTEGER DEFAULT 0,
      showOnline INTEGER DEFAULT 1,
      singlePoints INTEGER DEFAULT 100,
      lastSingleCharge INTEGER DEFAULT 0,
      singleWins INTEGER DEFAULT 0,
      singleGames INTEGER DEFAULT 0,
      multiPoints INTEGER DEFAULT 0,
      lastMultiCharge INTEGER DEFAULT 0,
      multiWins INTEGER DEFAULT 0,
      multiGames INTEGER DEFAULT 0,
      createdAt INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS game_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameId TEXT NOT NULL,
      mode TEXT NOT NULL,
      userCode TEXT NOT NULL,
      rank INTEGER NOT NULL,
      rawScore INTEGER NOT NULL,
      pointChange INTEGER NOT NULL,
      penalties INTEGER DEFAULT 0,
      playedAt INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await db.query(sql`INSERT OR IGNORE INTO settings (key, value) VALUES ('adminPassword', 'nl291234')`);
  await db.query(sql`INSERT OR IGNORE INTO users (userCode, userName, isAdmin) VALUES ('admin', '관리자', 1)`);
}

async function getUser(userCode) {
  const rows = await db.query(sql`SELECT * FROM users WHERE userCode = ${userCode}`);
  return rows[0] || null;
}

async function createUser(userCode, userName, isAdmin = 0) {
  await db.query(sql`INSERT INTO users (userCode, userName, isAdmin) VALUES (${userCode}, ${userName}, ${isAdmin})`);
}

async function updateUser(userCode, fields) {
  for (const [key, value] of Object.entries(fields)) {
    await db.query(sql`UPDATE users SET ${sql.ident(key)} = ${value} WHERE userCode = ${userCode}`);
  }
}

async function getAllUsers() {
  return db.query(sql`SELECT * FROM users ORDER BY createdAt ASC`);
}

async function deleteUser(userCode) {
  await db.query(sql`DELETE FROM users WHERE userCode = ${userCode}`);
}

async function getUserCount() {
  const rows = await db.query(sql`SELECT COUNT(*) as cnt FROM users`);
  return rows[0]?.cnt || 0;
}

async function getSetting(key) {
  const rows = await db.query(sql`SELECT value FROM settings WHERE key = ${key}`);
  return rows[0]?.value || null;
}

async function setSetting(key, value) {
  await db.query(sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${key}, ${value})`);
}

// results: [{ userCode, isAI, rank, rawScore, pointChange, penalties }]
async function saveGameResult(gameId, mode, results) {
  for (const r of results) {
    if (r.isAI) continue;
    await db.query(sql`
      INSERT INTO game_results (gameId, mode, userCode, rank, rawScore, pointChange, penalties)
      VALUES (${gameId}, ${mode}, ${r.userCode}, ${r.rank}, ${r.rawScore}, ${r.pointChange}, ${r.penalties})
    `);
    if (mode === 'multi') {
      await db.query(sql`
        UPDATE users SET
          multiPoints = MAX(0, multiPoints + ${r.pointChange}),
          multiWins = multiWins + ${r.rank === 1 ? 1 : 0},
          multiGames = multiGames + 1
        WHERE userCode = ${r.userCode}
      `);
    } else {
      await db.query(sql`
        UPDATE users SET
          singlePoints = MAX(0, singlePoints + ${r.pointChange}),
          singleWins = singleWins + ${r.rank === 1 ? 1 : 0},
          singleGames = singleGames + 1
        WHERE userCode = ${r.userCode}
      `);
    }
  }
}

async function getSingleRanking() {
  return db.query(sql`
    SELECT userCode, userName, avatar, singlePoints, singleWins, singleGames
    FROM users
    ORDER BY singlePoints DESC,
             CAST(singleWins AS REAL) / CASE WHEN singleGames = 0 THEN 1 ELSE singleGames END DESC
    LIMIT 20
  `);
}

async function getMultiRanking() {
  return db.query(sql`
    SELECT userCode, userName, avatar, multiPoints, multiWins, multiGames
    FROM users
    ORDER BY multiPoints DESC,
             CAST(multiWins AS REAL) / CASE WHEN multiGames = 0 THEN 1 ELSE multiGames END DESC
    LIMIT 20
  `);
}

// 싱글 포인트가 0일 때만, 24시간에 한 번 100점 충전 (훌라 싱글모드와 동일한 방식)
async function chargeSingle(userCode) {
  const now = Date.now();
  const user = await getUser(userCode);
  if (!user) return { ok: false, msg: '유저 없음' };
  if (user.singlePoints > 0) return { ok: false, msg: '싱글 포인트가 0점일 때만 충전 가능합니다' };

  if (now - user.lastSingleCharge < 24 * 60 * 60 * 1000) {
    const remain = Math.ceil((24 * 60 * 60 * 1000 - (now - user.lastSingleCharge)) / 3600000);
    return { ok: false, msg: `${remain}시간 후 충전 가능` };
  }

  const amount = 100;
  await db.query(sql`UPDATE users SET singlePoints = singlePoints + ${amount}, lastSingleCharge = ${now} WHERE userCode = ${userCode}`);
  return { ok: true, amount };
}

module.exports = {
  init, getUser, createUser, updateUser, getAllUsers, deleteUser, getUserCount,
  getSetting, setSetting, saveGameResult,
  getSingleRanking, getMultiRanking, chargeSingle
};
