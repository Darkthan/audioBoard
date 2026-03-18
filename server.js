const express = require('express');
const session = require('express-session');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const nodemailer = require('nodemailer');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const ROLES = { ADMIN: 'admin', UPLOADER: 'uploader' };

// ── Database ──────────────────────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'audioboard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'uploader',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, owner_id)
  );

  CREATE TABLE IF NOT EXISTS audio_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    share_token TEXT UNIQUE NOT NULL,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    position INTEGER NOT NULL DEFAULT 0,
    size INTEGER,
    compressed INTEGER DEFAULT 0,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS magic_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id BLOB NOT NULL UNIQUE,
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    nickname TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME
  );

  CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

  CREATE TABLE IF NOT EXISTS shared_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS shared_link_playlists (
    shared_link_id INTEGER NOT NULL REFERENCES shared_links(id) ON DELETE CASCADE,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    PRIMARY KEY (shared_link_id, playlist_id)
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_share_token
    ON playlists(share_token) WHERE share_token IS NOT NULL;
`);

// ── Migrations ────────────────────────────────────────────────────────────────
(function migrate() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);

  // folders → playlists
  if (tables.includes('folders')) {
    db.pragma('foreign_keys = OFF');
    const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
    if (admin) {
      const ins = db.prepare('INSERT OR IGNORE INTO playlists (id, name, owner_id, share_token, created_at) VALUES (?,?,?,?,?)');
      for (const f of db.prepare('SELECT * FROM folders').all())
        ins.run(f.id, f.name, admin.id, f.share_token || null, f.created_at);
    }
    const afCols = db.prepare('PRAGMA table_info(audio_files)').all().map(c => c.name);
    const srcCol = afCols.includes('playlist_id') ? 'COALESCE(playlist_id, folder_id)' : afCols.includes('folder_id') ? 'folder_id' : 'NULL';
    db.exec(`
      CREATE TABLE audio_files_mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT, original_name TEXT NOT NULL, filename TEXT NOT NULL,
        share_token TEXT UNIQUE NOT NULL, playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
        uploaded_by INTEGER NOT NULL REFERENCES users(id), position INTEGER NOT NULL DEFAULT 0,
        size INTEGER, compressed INTEGER DEFAULT 0, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO audio_files_mig (id,original_name,filename,share_token,playlist_id,uploaded_by,size,compressed,expires_at,created_at)
        SELECT id,original_name,filename,share_token,${srcCol},uploaded_by,size,COALESCE(compressed,0),expires_at,created_at FROM audio_files;
      DROP TABLE audio_files; ALTER TABLE audio_files_mig RENAME TO audio_files; DROP TABLE folders;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Add position column if missing
  const afCols = db.prepare('PRAGMA table_info(audio_files)').all().map(c => c.name);
  if (!afCols.includes('position')) {
    db.exec('ALTER TABLE audio_files ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE audio_files SET position = (
        SELECT COUNT(*) FROM audio_files af2
        WHERE af2.playlist_id = audio_files.playlist_id AND af2.id < audio_files.id
      )
    `);
  }
  // Add email column to users if missing
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }

  // Add codec column if missing
  if (!afCols.includes('codec')) {
    db.exec("ALTER TABLE audio_files ADD COLUMN codec TEXT NOT NULL DEFAULT 'none'");
    // Backfill: compressed=1 → mp3
    db.exec("UPDATE audio_files SET codec='mp3' WHERE compressed=1");
  }

  // Add audio metadata columns
  if (!afCols.includes('duration'))   db.exec('ALTER TABLE audio_files ADD COLUMN duration REAL');
  if (!afCols.includes('artist'))     db.exec('ALTER TABLE audio_files ADD COLUMN artist TEXT');
  if (!afCols.includes('album'))      db.exec('ALTER TABLE audio_files ADD COLUMN album TEXT');
  if (!afCols.includes('title_tag'))  db.exec('ALTER TABLE audio_files ADD COLUMN title_tag TEXT');
  if (!afCols.includes('has_cover'))  db.exec('ALTER TABLE audio_files ADD COLUMN has_cover INTEGER DEFAULT 0');
  if (!afCols.includes('waveform'))   db.exec('ALTER TABLE audio_files ADD COLUMN waveform TEXT');
  if (!afCols.includes('play_count')) db.exec('ALTER TABLE audio_files ADD COLUMN play_count INTEGER DEFAULT 0');

  // Add playlist settings columns
  const plCols = db.prepare('PRAGMA table_info(playlists)').all().map(c => c.name);
  if (!plCols.includes('allow_download'))   db.exec('ALTER TABLE playlists ADD COLUMN allow_download INTEGER DEFAULT 0');
  if (!plCols.includes('playlist_password')) db.exec('ALTER TABLE playlists ADD COLUMN playlist_password TEXT');
  if (!plCols.includes('empty_since'))      db.exec('ALTER TABLE playlists ADD COLUMN empty_since DATETIME');

  // Add user quota column
  if (!userCols.includes('quota_mb')) db.exec('ALTER TABLE users ADD COLUMN quota_mb INTEGER');

  // Play events table
  db.exec(`CREATE TABLE IF NOT EXISTS play_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec('CREATE INDEX IF NOT EXISTS idx_shared_link_playlists_playlist ON shared_link_playlists(playlist_id)');

  // Magic tokens — request_id + consumed pour le mode cross-device
  const mtCols = db.prepare('PRAGMA table_info(magic_tokens)').all().map(c => c.name);
  if (!mtCols.includes('request_id')) db.exec('ALTER TABLE magic_tokens ADD COLUMN request_id TEXT');
  if (!mtCols.includes('consumed'))   db.exec('ALTER TABLE magic_tokens ADD COLUMN consumed INTEGER DEFAULT 0');

  // Covers directory
  fs.mkdirSync(path.join(UPLOADS_DIR, 'covers'), { recursive: true });
})();

// ── Cached statements ─────────────────────────────────────────────────────────
const stmt = {
  getSetting:    db.prepare('SELECT value FROM settings WHERE key = ?'),
  upsertSetting: db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  getAllSettings: db.prepare('SELECT * FROM settings'),

  getUserByUsername: db.prepare('SELECT id,username,password,role,email FROM users WHERE username=?'),
  getUserByEmail:    db.prepare('SELECT id,username,password,role,email FROM users WHERE email=?'),
  getUserById:       db.prepare('SELECT id,username,role FROM users WHERE id=?'),
  getAdminExists:    db.prepare("SELECT id FROM users WHERE role='admin'"),
  getAllUsers:       db.prepare('SELECT id,username,role,email,created_at FROM users ORDER BY created_at'),
  insertUser:        db.prepare('INSERT INTO users (username,password,role,email) VALUES (?,?,?,?)'),
  updateUserEmail:    db.prepare('UPDATE users SET email=? WHERE id=?'),
  updateUserPassword: db.prepare('UPDATE users SET password=? WHERE id=?'),
  deleteUser:         db.prepare('DELETE FROM users WHERE id=?'),

  getWebAuthnCredsByUser:  db.prepare('SELECT id,credential_id,public_key,sign_count,transports,nickname,created_at,last_used_at FROM webauthn_credentials WHERE user_id=? ORDER BY created_at DESC'),
  getWebAuthnCredByCredId: db.prepare('SELECT id,user_id,credential_id,public_key,sign_count,transports FROM webauthn_credentials WHERE credential_id=?'),
  insertWebAuthnCred:      db.prepare('INSERT INTO webauthn_credentials (user_id,credential_id,public_key,sign_count,transports,nickname) VALUES (?,?,?,?,?,?)'),
  updateWebAuthnCounter:   db.prepare("UPDATE webauthn_credentials SET sign_count=?,last_used_at=datetime('now') WHERE id=?"),
  updateWebAuthnNickname:  db.prepare('UPDATE webauthn_credentials SET nickname=? WHERE id=? AND user_id=?'),
  deleteWebAuthnCred:      db.prepare('DELETE FROM webauthn_credentials WHERE id=? AND user_id=?'),

  insertMagicToken:           db.prepare('INSERT INTO magic_tokens (user_id,token,expires_at,request_id) VALUES (?,?,?,?)'),
  getMagicToken:              db.prepare('SELECT id,user_id,expires_at FROM magic_tokens WHERE token=?'),
  getMagicTokenByRequestId:   db.prepare('SELECT id,user_id,expires_at,consumed FROM magic_tokens WHERE request_id=?'),
  consumeMagicToken:          db.prepare('UPDATE magic_tokens SET consumed=1 WHERE id=?'),
  deleteMagicToken:           db.prepare('DELETE FROM magic_tokens WHERE id=?'),
  deleteExpiredMagicTokens:   db.prepare("DELETE FROM magic_tokens WHERE expires_at < datetime('now')"),

  getPlaylistById:         db.prepare('SELECT id,name,owner_id,share_token FROM playlists WHERE id=?'),
  getPlaylistsByOwner:     db.prepare(`
    SELECT p.id, p.name, p.share_token, COUNT(af.id) as file_count
    FROM playlists p LEFT JOIN audio_files af ON af.playlist_id = p.id
    WHERE p.owner_id=? GROUP BY p.id ORDER BY p.name
  `),
  getAllPlaylists:          db.prepare(`
    SELECT p.id, p.name, p.share_token, p.created_at, u.username as owner_name, COUNT(af.id) as file_count
    FROM playlists p JOIN users u ON p.owner_id=u.id LEFT JOIN audio_files af ON af.playlist_id=p.id
    GROUP BY p.id ORDER BY u.username, p.name
  `),
  getPlaylistByShareToken: db.prepare('SELECT id,name,owner_id FROM playlists WHERE share_token=?'),
  insertPlaylist:          db.prepare('INSERT INTO playlists (name,owner_id) VALUES (?,?)'),
  renamePlaylist:          db.prepare('UPDATE playlists SET name=? WHERE id=?'),
  deletePlaylist:          db.prepare('DELETE FROM playlists WHERE id=?'),
  setPlaylistShareToken:   db.prepare('UPDATE playlists SET share_token=? WHERE id=?'),
  getAllSharedLinks:       db.prepare(`
    SELECT sl.id, sl.name, sl.token, sl.created_at, COUNT(slp.playlist_id) as playlist_count
    FROM shared_links sl
    LEFT JOIN shared_link_playlists slp ON slp.shared_link_id = sl.id
    GROUP BY sl.id
    ORDER BY sl.created_at DESC
  `),
  insertSharedLink:        db.prepare('INSERT INTO shared_links (name, token) VALUES (?, ?)'),
  insertSharedLinkPlaylist: db.prepare('INSERT INTO shared_link_playlists (shared_link_id, playlist_id) VALUES (?, ?)'),
  getSharedLinkById:       db.prepare('SELECT id, name, token FROM shared_links WHERE id = ?'),
  getSharedLinkByToken:    db.prepare('SELECT id, name, token FROM shared_links WHERE token = ?'),
  getSharedLinkPlaylists:  db.prepare(`
    SELECT p.id, p.name, p.share_token, p.allow_download, COUNT(af.id) as file_count
    FROM shared_link_playlists slp
    JOIN playlists p ON p.id = slp.playlist_id
    LEFT JOIN audio_files af ON af.playlist_id = p.id
    WHERE slp.shared_link_id = ?
    GROUP BY p.id
    ORDER BY p.name
  `),
  deleteSharedLink:        db.prepare('DELETE FROM shared_links WHERE id = ?'),
  deleteSharedLinkPlaylists: db.prepare('DELETE FROM shared_link_playlists WHERE shared_link_id = ?'),

  getFileById:                db.prepare('SELECT id,filename,uploaded_by,playlist_id FROM audio_files WHERE id=?'),
  getFileByToken:             db.prepare('SELECT filename,expires_at,codec FROM audio_files WHERE share_token=?'),
  getFileByTokenWithPlaylist: db.prepare(`
    SELECT af.*,p.name as playlist_name FROM audio_files af
    LEFT JOIN playlists p ON af.playlist_id=p.id WHERE af.share_token=?
  `),
  getFilesForPlaylist: db.prepare(`
    SELECT af.*,p.name as playlist_name FROM audio_files af
    LEFT JOIN playlists p ON af.playlist_id=p.id
    WHERE af.playlist_id=? ORDER BY af.position ASC, af.created_at ASC
  `),
  getFilesPublicPlaylist: db.prepare(`
    SELECT af.id,af.original_name,af.share_token,af.size,af.compressed,af.expires_at,af.position
    FROM audio_files af WHERE af.playlist_id=? ORDER BY af.position ASC, af.created_at ASC
  `),
  getFilesByPlaylistId:   db.prepare('SELECT filename FROM audio_files WHERE playlist_id=?'),
  maxPositionInPlaylist:  db.prepare('SELECT COALESCE(MAX(position),-1) as m FROM audio_files WHERE playlist_id=?'),
  insertFile: db.prepare(`
    INSERT INTO audio_files
      (original_name,filename,share_token,playlist_id,uploaded_by,position,size,compressed,codec,expires_at,
       duration,artist,album,title_tag,has_cover,waveform,play_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
  `),
  updateFilePosition:    db.prepare('UPDATE audio_files SET position=? WHERE id=? AND playlist_id=?'),
  updateFileTitle:       db.prepare('UPDATE audio_files SET title_tag=? WHERE id=?'),
  deleteFile:            db.prepare('DELETE FROM audio_files WHERE id=?'),
  deleteFilesByPlaylist: db.prepare('DELETE FROM audio_files WHERE playlist_id=?'),
  countFiles:  db.prepare('SELECT COUNT(*) as c FROM audio_files'),
  sumFileSize: db.prepare('SELECT COALESCE(SUM(size),0) as s FROM audio_files'),
  getExpired:  db.prepare("SELECT id,filename,playlist_id FROM audio_files WHERE expires_at IS NOT NULL AND expires_at<datetime('now')"),
  countFilesInPlaylist:     db.prepare('SELECT COUNT(*) as c FROM audio_files WHERE playlist_id=?'),
  setPlaylistEmptySince:    db.prepare("UPDATE playlists SET empty_since = datetime('now') WHERE id = ? AND empty_since IS NULL"),
  clearPlaylistEmptySince:  db.prepare('UPDATE playlists SET empty_since = NULL WHERE id = ?'),
  getExpiredEmptyPlaylists: db.prepare("SELECT id FROM playlists WHERE empty_since IS NOT NULL AND julianday('now') - julianday(empty_since) >= ?"),

  // Metadata & stats
  getFilesPublicPlaylistFull: db.prepare(`
    SELECT af.id,af.original_name,af.share_token,af.size,af.compressed,af.codec,
           af.expires_at,af.position,af.duration,af.artist,af.album,af.title_tag,af.has_cover,af.play_count
    FROM audio_files af WHERE af.playlist_id=? ORDER BY af.position ASC, af.created_at ASC
  `),
  getWaveform:        db.prepare('SELECT waveform FROM audio_files WHERE share_token=?'),
  incrementPlayCount: db.prepare('UPDATE audio_files SET play_count = play_count + 1 WHERE share_token=?'),
  insertPlayEvent:    db.prepare('SELECT id FROM audio_files WHERE share_token=?'),
  getFileIdByToken:   db.prepare('SELECT id FROM audio_files WHERE share_token=?'),
  insertPlayEvt:      db.prepare('INSERT INTO play_events (file_id) VALUES (?)'),
  getTopTracks:       db.prepare(`
    SELECT af.original_name,af.share_token,af.play_count,af.artist,p.name as playlist_name
    FROM audio_files af LEFT JOIN playlists p ON af.playlist_id=p.id
    ORDER BY af.play_count DESC LIMIT 10
  `),
  getPlaysToday:  db.prepare("SELECT COUNT(*) as c FROM play_events WHERE played_at >= datetime('now','start of day')"),
  getPlaysPerDay: db.prepare(`
    SELECT date(played_at) as day, COUNT(*) as c FROM play_events
    WHERE played_at >= datetime('now','-6 days') GROUP BY day ORDER BY day
  `),
  // Playlist settings
  getPlaylistFull:          db.prepare('SELECT id,name,owner_id,share_token,allow_download,playlist_password FROM playlists WHERE id=?'),
  getPlaylistByShareTokenFull: db.prepare('SELECT id,name,owner_id,allow_download,playlist_password FROM playlists WHERE share_token=?'),
  updatePlaylistSettings:   db.prepare('UPDATE playlists SET allow_download=?, playlist_password=? WHERE id=?'),
  // Quota
  getUserFull:          db.prepare('SELECT id,username,role,email,quota_mb FROM users WHERE id=?'),
  getAllUsersFull:       db.prepare('SELECT id,username,role,email,quota_mb,created_at FROM users ORDER BY created_at'),
  getUserStorageUsed:   db.prepare('SELECT COALESCE(SUM(size),0) as total FROM audio_files WHERE uploaded_by=?'),
  updateUserQuota:      db.prepare('UPDATE users SET quota_mb=? WHERE id=?'),
};

// ── Default settings & admin ──────────────────────────────────────────────────
const CODECS = ['none', 'mp3', 'aac', 'opus', 'opus_live'];
const defaults = {
  compression_codec:'mp3', compression_bitrate:'128', retention_days:'30', empty_playlist_retention_days:'0',
  webrtc_enabled:'1',
  passwordless_enabled:'0',
  smtp_host:'', smtp_port:'587', smtp_secure:'0', smtp_user:'', smtp_pass:'', smtp_from:'',
  default_quota_mb: '0',
  webauthn_enabled: '0',
  webauthn_rp_id:   '',
  webauthn_rp_name: 'AudioBoard',
};
const upsertIgnore = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k,v] of Object.entries(defaults)) upsertIgnore.run(k, v);

// ── Variables d'environnement → paramètres DB (autoritatifs au démarrage) ──────
const ENV_SETTINGS_MAP = {
  compression_codec:    'COMPRESSION_CODEC',
  compression_bitrate:  'COMPRESSION_BITRATE',
  retention_days:       'RETENTION_DAYS',
  webrtc_enabled:       'WEBRTC_ENABLED',
  passwordless_enabled: 'PASSWORDLESS_ENABLED',
  smtp_host:            'SMTP_HOST',
  smtp_port:            'SMTP_PORT',
  smtp_secure:          'SMTP_SECURE',
  smtp_user:            'SMTP_USER',
  smtp_pass:            'SMTP_PASS',
  smtp_from:            'SMTP_FROM',
  default_quota_mb:     'DEFAULT_QUOTA_MB',
  webauthn_enabled:     'WEBAUTHN_ENABLED',
  webauthn_rp_id:       'WEBAUTHN_RP_ID',
  webauthn_rp_name:               'WEBAUTHN_RP_NAME',
  empty_playlist_retention_days:  'EMPTY_PLAYLIST_RETENTION_DAYS',
};
for (const [key, envVar] of Object.entries(ENV_SETTINGS_MAP)) {
  if (process.env[envVar] !== undefined) stmt.upsertSetting.run(key, process.env[envVar]);
}

// ── Initial admin setup ───────────────────────────────────────────────────────
let setupDone = !!stmt.getAdminExists.get();
if (!setupDone && process.env.ADMIN_PASSWORD) {
  const adminUser = (process.env.ADMIN_USER || 'admin').trim();
  const adminPass = process.env.ADMIN_PASSWORD.trim();
  stmt.insertUser.run(adminUser, bcrypt.hashSync(adminPass, 10), ROLES.ADMIN, null);
  console.log(`Compte admin créé depuis l'environnement : ${adminUser}`);
  setupDone = true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSetting(k) { const r = stmt.getSetting.get(k); return r ? r.value : null; }
function tryUnlink(p) { try { fs.unlinkSync(p); } catch {} }
function safeUploadPath(filename) {
  const r = path.resolve(UPLOADS_DIR, path.basename(filename));
  if (!r.startsWith(path.resolve(UPLOADS_DIR))) throw new Error('Invalid filename');
  return r;
}
function isExpired(f) { return f.expires_at && new Date(f.expires_at) < new Date(); }
function canManage(user, playlist) { return user.role === ROLES.ADMIN || playlist.owner_id === user.id; }

function createTransporter() {
  const host = getSetting('smtp_host');
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(getSetting('smtp_port') || '587'),
    secure: getSetting('smtp_secure') === '1',
    auth: { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') },
  });
}

const escXml = s => String(s || '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function fmtDuration(secs) {
  if (!secs) return '0:00';
  return Math.floor(secs / 60) + ':' + String(Math.floor(secs % 60)).padStart(2, '0');
}

async function extractMetadata(filePath) {
  try {
    const { parseFile } = await import('music-metadata');
    const meta = await parseFile(filePath, { duration: true });
    return {
      duration: meta.format.duration || null,
      artist:   meta.common.artist   || null,
      album:    meta.common.album    || null,
      title:    meta.common.title    || null,
      cover:    (meta.common.picture && meta.common.picture[0]) || null,
    };
  } catch { return {}; }
}

async function extractWaveform(filePath, durationSecs) {
  const BARS = 200;
  const targetRate = Math.max(4, Math.ceil(BARS / Math.max(durationSecs || 180, 1)));
  return new Promise((res) => {
    const bufs = [];
    const proc = ffmpeg(filePath).noVideo().audioChannels(1).audioFrequency(targetRate).format('f32le');
    proc.on('error', () => res(null));
    const stream = proc.pipe();
    stream.on('data', b => bufs.push(b));
    stream.on('end', () => {
      try {
        const buf = Buffer.concat(bufs);
        const n = Math.floor(buf.byteLength / 4);
        if (n < 2) return res(null);
        const bs = Math.max(1, Math.floor(n / BARS));
        const raw = Array.from({ length: BARS }, (_, i) => {
          let max = 0;
          for (let j = 0; j < bs; j++) {
            const off = (i * bs + j) * 4;
            if (off + 4 <= buf.byteLength) max = Math.max(max, Math.abs(buf.readFloatLE(off)));
          }
          return max;
        });
        const peak = Math.max(...raw, 0.001);
        res(raw.map(v => parseFloat((v / peak).toFixed(3))));
      } catch { res(null); }
    });
  });
}

function deletePlaylist(id) {
  for (const f of stmt.getFilesByPlaylistId.all(id)) tryUnlink(safeUploadPath(f.filename));
  stmt.deleteFilesByPlaylist.run(id);
  stmt.deletePlaylist.run(id);
}

function updatePlaylistEmptySince(playlistId) {
  if (!playlistId) return;
  const { c } = stmt.countFilesInPlaylist.get(playlistId);
  if (c === 0) stmt.setPlaylistEmptySince.run(playlistId);
  else stmt.clearPlaylistEmptySince.run(playlistId);
}

const reorderPlaylist = db.transaction((playlistId, orderedIds) => {
  orderedIds.forEach((id, i) => stmt.updateFilePosition.run(i, id, playlistId));
});

const createSharedLinkWithPlaylists = db.transaction((name, playlistIds) => {
  const token = uuidv4();
  const result = stmt.insertSharedLink.run(name, token);
  for (const playlistId of playlistIds) {
    stmt.insertSharedLinkPlaylist.run(result.lastInsertRowid, playlistId);
  }
  return { id: result.lastInsertRowid, token };
});

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = ['.mp3','.wav','.ogg','.flac','.aac','.m4a','.wma','.webm'].includes(ext);
    cb(ok ? null : new Error('Format non supporté'), ok);
  },
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ── Express ───────────────────────────────────────────────────────────────────
// Faire confiance au proxy inverse (Nginx, Caddy…) pour X-Forwarded-Proto et X-Forwarded-Host
// Nécessaire pour que req.protocol = 'https' et req.hostname = domaine public
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'audioboard-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

// ── Setup guard ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (setupDone) return next();
  const allowed = req.path === '/setup' || req.path.startsWith('/css/') || req.path.startsWith('/js/');
  if (allowed) return next();
  res.redirect('/setup');
});

app.get('/setup', (req, res) => {
  if (setupDone) return res.redirect('/');
  res.render('setup', { error: null });
});

app.post('/setup', (req, res) => {
  if (setupDone) return res.redirect('/');
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();
  const confirm  = (req.body.confirm  || '').trim();
  if (!username || username.length < 2)
    return res.render('setup', { error: 'Le nom d\'utilisateur doit faire au moins 2 caractères.' });
  if (password.length < 8)
    return res.render('setup', { error: 'Le mot de passe doit faire au moins 8 caractères.' });
  if (password !== confirm)
    return res.render('setup', { error: 'Les mots de passe ne correspondent pas.' });
  stmt.insertUser.run(username, bcrypt.hashSync(password, 10), ROLES.ADMIN, null);
  setupDone = true;
  res.redirect('/login?info=Compte+administrateur+créé,+connectez-vous.');
});

function requireAuth(req, res, next)  { if (req.session.user) return next(); res.redirect('/login'); }
function requireAdmin(req, res, next) {
  if (req.session.user?.role === ROLES.ADMIN) return next();
  res.status(403).render('error', { message:'Accès refusé', user: req.session.user });
}
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.webrtcEnabled = getSetting('webrtc_enabled') !== '0';
  res.locals.passwordlessEnabled = getSetting('passwordless_enabled') === '1';
  res.locals.webauthnEnabled = getSetting('webauthn_enabled') === '1';
  next();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, info: req.query.info || null, prefillUsername: null });
});

app.post('/login', (req, res) => {
  const user = stmt.getUserByUsername.get(req.body.username);
  if (!user || !bcrypt.compareSync(req.body.password, user.password))
    return res.render('login', { error: 'Identifiants incorrects', info: null, prefillUsername: req.body.username || '' });
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/');
});

app.post('/login/magic', async (req, res) => {
  const input = (req.body.username || '').trim();
  const user  = stmt.getUserByUsername.get(input) || stmt.getUserByEmail.get(input);

  // Réponse neutre même si l'utilisateur n'existe pas (sécurité)
  if (!user || !user.email) return res.json({ ok: true });

  const transporter = createTransporter();
  if (!transporter) return res.json({ error: 'Le serveur email n\'est pas configuré. Contactez l\'administrateur.' });

  const requestId = uuidv4();
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  stmt.insertMagicToken.run(user.id, token, expiresAt, requestId);
  req.session.magicRequestId = requestId;

  const link = `${req.protocol}://${req.get('host')}/login/magic/${token}`;
  const safeUsername = escXml(user.username);
  const safeLink = escXml(link);
  try {
    await transporter.sendMail({
      from:    getSetting('smtp_from') || getSetting('smtp_user'),
      to:      user.email,
      subject: 'Votre lien de connexion AudioBoard',
      text:    `Bonjour ${user.username},\n\nUtilisez ce lien pour vous connecter a AudioBoard :\n${link}\n\nCe lien expire dans 15 minutes.`,
      html:    `<!DOCTYPE html>
<html lang="fr">
  <body style="margin:0; padding:0; background:#0f1418; font-family:Arial,Helvetica,sans-serif; color:#e5edf4;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f1418; padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px; background:#171d23; border:1px solid #2a323b; border-radius:20px; overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 20px; background:linear-gradient(135deg,#171d23 0%,#202932 100%);">
                <div style="display:inline-block; padding:6px 10px; border-radius:999px; background:rgba(232,93,4,0.12); color:#ffb36b; font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase;">AudioBoard</div>
                <h1 style="margin:18px 0 12px; font-size:28px; line-height:1.2; color:#ffffff;">Connexion sécurisée</h1>
                <p style="margin:0; font-size:15px; line-height:1.7; color:#b7c2cc;">
                  Bonjour <strong style="color:#ffffff;">${safeUsername}</strong>, utilisez ce lien pour accéder à votre espace sans mot de passe.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px; background:#12171c; border:1px solid #2a323b; border-radius:16px;">
                  <tr>
                    <td style="padding:24px; text-align:center;">
                      <a href="${safeLink}" style="display:inline-block; padding:14px 24px; background:#e85d04; color:#ffffff; text-decoration:none; border-radius:12px; font-size:16px; font-weight:700;">Ouvrir AudioBoard</a>
                      <p style="margin:16px 0 0; font-size:13px; line-height:1.6; color:#96a2ad;">
                        Ce lien expire dans <strong style="color:#ffffff;">15 minutes</strong>.
                      </p>
                    </td>
                  </tr>
                </table>
                <p style="margin:20px 0 8px; font-size:13px; line-height:1.6; color:#96a2ad;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :</p>
                <p style="margin:0; padding:14px 16px; background:#12171c; border:1px solid #2a323b; border-radius:12px; word-break:break-all; font-size:13px; line-height:1.6; color:#d8e0e7;">
                  <a href="${safeLink}" style="color:#ffb36b; text-decoration:none;">${safeLink}</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    });
  } catch (err) {
    console.error('Magic link email error:', err.message);
    return res.json({ error: 'Échec de l\'envoi de l\'email. Vérifiez la configuration SMTP.' });
  }

  res.json({ ok: true });
});

// Polling : Tab A vérifie si le token a été consommé depuis un autre appareil
app.get('/login/magic/poll', (req, res) => {
  const requestId = req.session.magicRequestId;
  if (!requestId) return res.json({ ok: false });

  const record = stmt.getMagicTokenByRequestId.get(requestId);
  if (!record) return res.json({ ok: false });

  if (new Date(record.expires_at) < new Date()) {
    delete req.session.magicRequestId;
    return res.json({ ok: false, expired: true });
  }

  if (record.consumed) {
    const user = stmt.getUserById.get(record.user_id);
    stmt.deleteMagicToken.run(record.id);
    delete req.session.magicRequestId;
    if (!user) return res.json({ ok: false });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    return res.json({ ok: true });
  }

  res.json({ ok: false });
});

app.get('/login/magic/:token', (req, res) => {
  const record = stmt.getMagicToken.get(req.params.token);
  if (!record || new Date(record.expires_at) < new Date()) {
    stmt.deleteMagicToken.run(record?.id);
    return res.render('login', { error: 'Lien invalide ou expiré. Demandez-en un nouveau.', info: null, prefillUsername: null });
  }
  // Marquer comme consommé — la session sera créée sur l'onglet d'origine via /login/magic/poll
  stmt.consumeMagicToken.run(record.id);
  res.render('magic-confirmed');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── Dashboard (liste des playlists) ──────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  const { user } = req.session;
  const playlists = user.role === ROLES.ADMIN
    ? stmt.getAllPlaylists.all()
    : stmt.getPlaylistsByOwner.all(user.id);
  const userFull  = stmt.getUserFull.get(user.id);
  const quotaMb   = userFull?.quota_mb ?? parseInt(getSetting('default_quota_mb') || '0');
  const storageUsed = quotaMb > 0 ? stmt.getUserStorageUsed.get(user.id).total : 0;
  res.render('dashboard', { playlists, error: req.query.error || null, quotaMb, storageUsed });
});

// ── Playlists CRUD ────────────────────────────────────────────────────────────
app.post('/playlists', requireAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/?error=Nom requis');
  try {
    const r = stmt.insertPlaylist.run(name, req.session.user.id);
    res.redirect('/playlists/' + r.lastInsertRowid);
  } catch {
    res.redirect('/?error=Une playlist avec ce nom existe déjà');
  }
});

app.post('/playlists/:id/rename', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist)) return res.redirect('/');
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/playlists/' + playlist.id + '?error=Nom requis');
  try {
    stmt.renamePlaylist.run(name, playlist.id);
  } catch {
    return res.redirect('/playlists/' + playlist.id + '?error=Ce nom est déjà utilisé');
  }
  res.redirect('/playlists/' + playlist.id);
});

app.post('/playlists/:id/delete', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist))
    return res.status(403).render('error', { message:'Non autorisé', user: req.session.user });
  deletePlaylist(playlist.id);
  res.redirect('/');
});

app.post('/playlists/:id/share', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist)) return res.redirect('/');
  stmt.setPlaylistShareToken.run(uuidv4(), playlist.id);
  res.redirect('/playlists/' + playlist.id);
});

app.post('/playlists/:id/revoke', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist)) return res.redirect('/');
  stmt.setPlaylistShareToken.run(null, playlist.id);
  res.redirect('/playlists/' + playlist.id);
});

app.post('/playlists/:id/settings', requireAuth, async (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist)) return res.redirect('/');
  const allowDownload = req.body.allow_download === '1' ? 1 : 0;
  let passwordHash = null;
  if (req.body.remove_password) {
    passwordHash = null; // suppression explicite
  } else if (req.body.playlist_password && req.body.playlist_password.trim()) {
    passwordHash = bcrypt.hashSync(req.body.playlist_password.trim(), 10);
  } else if (req.body.keep_password === '1') {
    // Conserver le mot de passe existant
    const pl = stmt.getPlaylistFull.get(playlist.id);
    passwordHash = pl?.playlist_password || null;
  }
  stmt.updatePlaylistSettings.run(allowDownload, passwordHash, playlist.id);
  res.redirect('/playlists/' + playlist.id);
});

// Reorder tracks (JSON API)
app.post('/playlists/:id/reorder', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist)) return res.status(403).json({ error:'Non autorisé' });
  const { order } = req.body; // array of file ids
  if (!Array.isArray(order)) return res.status(400).json({ error:'order requis' });
  reorderPlaylist(playlist.id, order.map(Number));
  res.json({ ok: true });
});

app.post('/files/:id/rename', requireAuth, (req, res) => {
  const file = stmt.getFileById.get(req.params.id);
  if (!file) return res.status(404).render('error', { message:'Piste introuvable', user: req.session.user });

  const playlist = file.playlist_id ? stmt.getPlaylistById.get(file.playlist_id) : null;
  if (!playlist || !canManage(req.session.user, playlist)) {
    return res.status(403).render('error', { message:'Non autorisé', user: req.session.user });
  }

  const title = (req.body.title || '').trim();
  stmt.updateFileTitle.run(title || null, file.id);
  res.redirect('/playlists/' + playlist.id);
});

// ── Playlist editor page ──────────────────────────────────────────────────────
app.get('/playlists/:id', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistFull.get(req.params.id) || stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist))
    return res.status(404).render('error', { message:'Playlist introuvable', user: req.session.user });
  const files = stmt.getFilesForPlaylist.all(playlist.id);
  const user = stmt.getUserFull.get(req.session.user.id);
  const quotaMb = user?.quota_mb ?? parseInt(getSetting('default_quota_mb') || '0');
  const storageUsed = quotaMb > 0 ? stmt.getUserStorageUsed.get(req.session.user.id).total : 0;
  res.render('playlist-editor', { playlist, files, error: req.query.error || null, quotaMb, storageUsed });
});

// ── Upload ────────────────────────────────────────────────────────────────────
const CODEC_MIME = { none: 'audio/mpeg', mp3: 'audio/mpeg', aac: 'audio/aac', opus: 'audio/webm', opus_live: 'audio/webm' };

function streamStaticFile(req, res, filePath, mime) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return res.status(404).send('File missing'); }

  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

function streamLiveMp3(req, res, filePath, bitrate) {
  res.set({
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-store',
  });

  const proc = ffmpeg(filePath)
    .audioCodec('libmp3lame')
    .audioChannels(2)
    .audioBitrate(bitrate)
    .format('mp3')
    .on('error', () => res.end())
    .pipe(res, { end: true });

  req.on('close', () => proc?.kill?.());
}

async function persistFile(file, playlistId, userId, options) {
  const shareToken = uuidv4();
  const expiresAt  = new Date(Date.now() + options.retentionDays * 86400000).toISOString();
  const position   = stmt.maxPositionInPlaylist.get(playlistId).m + 1;
  let finalFilename = file.filename;
  let codec = 'none';

  const encode = async (outExt, ffmpegChain) => {
    const outFilename = `${uuidv4()}${outExt}`;
    const outPath     = safeUploadPath(outFilename);
    await new Promise((resolve, reject) =>
      ffmpegChain.on('end', resolve).on('error', reject).save(outPath)
    );
    tryUnlink(file.path);
    return outFilename;
  };

  try {
    if (options.codec === 'mp3') {
      finalFilename = await encode('.mp3',
        ffmpeg(file.path).audioChannels(2).audioBitrate(options.bitrate).format('mp3'));
      codec = 'mp3';
    } else if (options.codec === 'opus') {
      finalFilename = await encode('.webm',
        ffmpeg(file.path).audioCodec('libopus').audioChannels(2).audioBitrate(options.bitrate).format('webm'));
      codec = 'opus';
    } else if (options.codec === 'aac') {
      finalFilename = await encode('.aac',
        ffmpeg(file.path).audioCodec('aac').audioChannels(2).audioBitrate(options.bitrate).format('adts'));
      codec = 'aac';
    } else if (options.codec === 'opus_live') {
      codec = 'opus_live';
    }
  } catch (err) {
    console.error(`Compression [${options.codec}]:`, err.message);
  }

  const finalPath = safeUploadPath(finalFilename);
  const stats     = fs.statSync(finalPath);

  // Métadonnées ID3 + durée
  const meta     = await extractMetadata(finalPath);
  const duration = meta.duration || null;

  // Pochette
  let hasCover = 0;
  if (meta.cover) {
    try {
      const coverPath = path.join(UPLOADS_DIR, 'covers', `${shareToken}.jpg`);
      fs.writeFileSync(coverPath, meta.cover.data);
      hasCover = 1;
    } catch {}
  }

  // Waveform (en arrière-plan pour ne pas bloquer)
  let waveformJson = null;
  try {
    const peaks = await extractWaveform(finalPath, duration);
    if (peaks) waveformJson = JSON.stringify(peaks);
  } catch {}

  stmt.insertFile.run(
    file.originalname, finalFilename, shareToken, playlistId, userId,
    position, stats.size, codec !== 'none' ? 1 : 0, codec, expiresAt,
    duration, meta.artist || null, meta.album || null, meta.title || null,
    hasCover, waveformJson
  );
  stmt.clearPlaylistEmptySince.run(playlistId);
}

app.post('/upload', requireAuth, upload.array('audio', 50), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error:'Aucun fichier' });
    const { playlist_id } = req.body;
    const playlist = stmt.getPlaylistById.get(playlist_id);
    if (!playlist || !canManage(req.session.user, playlist))
      return res.status(403).json({ error:'Non autorisé' });

    // Vérification quota
    const userFull = stmt.getUserFull.get(req.session.user.id);
    const quotaMb = userFull?.quota_mb ?? parseInt(getSetting('default_quota_mb') || '0');
    if (quotaMb > 0) {
      const used     = stmt.getUserStorageUsed.get(req.session.user.id).total || 0;
      const incoming = req.files.reduce((s, f) => s + f.size, 0);
      if (used + incoming > quotaMb * 1048576)
        return res.status(413).json({ error: `Quota dépassé (${quotaMb} Mo)` });
    }

    const options = {
      retentionDays: parseInt(getSetting('retention_days'), 10),
      codec:         getSetting('compression_codec') || 'none',
      bitrate:       getSetting('compression_bitrate') || '128',
    };
    await Promise.all(req.files.map(file => persistFile(file, playlist_id, req.session.user.id, options)));
    res.redirect('/playlists/' + playlist_id);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error:"Erreur lors de l'upload" });
  }
});

// ── Covers ────────────────────────────────────────────────────────────────────
app.get('/covers/:token', (req, res) => {
  const p = path.join(UPLOADS_DIR, 'covers', path.basename(req.params.token) + '.jpg');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).end();
});

// ── Download ──────────────────────────────────────────────────────────────────
app.get('/download/:token', (req, res) => {
  const file = stmt.getFileByTokenWithPlaylist.get(req.params.token);
  if (!file) return res.status(404).send('Not found');
  if (isExpired(file)) return res.status(410).send('Expired');
  // Vérifier que allow_download est activé sur la playlist (pour les accès non authentifiés)
  if (!req.session.user) {
    const pl = file.playlist_id ? stmt.getPlaylistFull.get(file.playlist_id) : null;
    if (!pl?.allow_download) return res.status(403).send('Téléchargement non autorisé');
  }
  const filePath = safeUploadPath(file.filename);
  try { fs.statSync(filePath); } catch { return res.status(404).send('File missing'); }
  res.download(filePath, file.original_name || path.basename(filePath));
});

// ── File delete ───────────────────────────────────────────────────────────────
app.post('/files/:id/delete', requireAuth, (req, res) => {
  const file = stmt.getFileById.get(req.params.id);
  if (!file) return res.status(404).json({ error:'Introuvable' });
  const playlist = file.playlist_id ? stmt.getPlaylistById.get(file.playlist_id) : null;
  if (!playlist || !canManage(req.session.user, playlist))
    return res.status(403).json({ error:'Non autorisé' });
  tryUnlink(safeUploadPath(file.filename));
  stmt.deleteFile.run(file.id);
  updatePlaylistEmptySince(file.playlist_id);
  res.redirect('/playlists/' + file.playlist_id);
});

// ── Public listen / stream ────────────────────────────────────────────────────
app.get('/listen/:token', (req, res) => {
  const file = stmt.getFileByTokenWithPlaylist.get(req.params.token);
  if (!file) return res.status(404).render('error', { message:'Audio introuvable ou expiré', user:null });
  if (isExpired(file)) return res.status(410).render('error', { message:'Ce lien a expiré', user:null });
  res.render('listen', { file });
});

app.get('/stream/:token', (req, res) => {
  const file = stmt.getFileByToken.get(req.params.token);
  if (!file) return res.status(404).send('Not found');
  if (isExpired(file)) return res.status(410).send('Expired');
  const filePath = safeUploadPath(file.filename);
  const wantsMp3Fallback = req.query.transcode === 'mp3';

  if (wantsMp3Fallback && (file.codec === 'opus' || file.codec === 'opus_live')) {
    streamLiveMp3(req, res, filePath, getSetting('compression_bitrate') || '128');
    return;
  }

  // Opus live : transcoding à la volée, pas de range, pas de Content-Length
  if (file.codec === 'opus_live') {
    res.set({
      'Content-Type': 'audio/webm',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-store',
    });
    const proc = ffmpeg(filePath)
      .audioCodec('libopus')
      .audioChannels(2)
      .audioBitrate(getSetting('compression_bitrate') || '128')
      .format('webm')
      .on('error', () => res.end())
      .pipe(res, { end: true });
    req.on('close', () => proc?.kill?.());
    return;
  }

  const mime = CODEC_MIME[file.codec] || 'audio/mpeg';
  streamStaticFile(req, res, filePath, mime);
});

// ── Public playlist page ──────────────────────────────────────────────────────
app.get('/playlist/:token', (req, res) => {
  const playlist = stmt.getPlaylistByShareTokenFull.get(req.params.token);
  if (!playlist) return res.status(404).render('error', { message:'Playlist introuvable', user:null });
  // Protection par mot de passe
  if (playlist.playlist_password && !req.session['pl_auth_' + req.params.token]) {
    return res.render('playlist-locked', { token: req.params.token, error: null });
  }
  const files = stmt.getFilesPublicPlaylistFull.all(playlist.id).filter(f => !isExpired(f));
  res.render('playlist', { playlist, files });
});

app.post('/playlist/:token/auth', (req, res) => {
  const playlist = stmt.getPlaylistByShareTokenFull.get(req.params.token);
  if (!playlist?.playlist_password) return res.redirect('/playlist/' + req.params.token);
  if (bcrypt.compareSync(req.body.password || '', playlist.playlist_password)) {
    req.session['pl_auth_' + req.params.token] = true;
    return res.redirect('/playlist/' + req.params.token);
  }
  res.render('playlist-locked', { token: req.params.token, error: 'Mot de passe incorrect' });
});

// ── Playlist RSS feed ─────────────────────────────────────────────────────────
app.get('/playlist/:token/rss', (req, res) => {
  const playlist = stmt.getPlaylistByShareTokenFull.get(req.params.token);
  if (!playlist) return res.status(404).send('Not found');
  if (playlist.playlist_password && !req.session['pl_auth_' + req.params.token])
    return res.status(403).send('Forbidden');
  const files = stmt.getFilesPublicPlaylistFull.all(playlist.id).filter(f => !isExpired(f));
  const base  = `${req.protocol}://${req.get('host')}`;
  res.type('application/rss+xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(playlist.name)}</title>
    <link>${escXml(base + '/playlist/' + req.params.token)}</link>
    <description>${escXml(playlist.name)}</description>
    <atom:link href="${escXml(base + '/playlist/' + req.params.token + '/rss')}" rel="self" type="application/rss+xml"/>
    ${files.map(f => `<item>
      <title>${escXml(f.title_tag || f.original_name.replace(/\.[^.]+$/, ''))}</title>
      ${f.artist ? `<itunes:author>${escXml(f.artist)}</itunes:author>` : ''}
      ${f.album  ? `<itunes:subtitle>${escXml(f.album)}</itunes:subtitle>` : ''}
      <enclosure url="${escXml(base + '/stream/' + f.share_token)}" type="${CODEC_MIME[f.codec] || 'audio/mpeg'}" length="${f.size || 0}"/>
      ${f.duration ? `<itunes:duration>${fmtDuration(f.duration)}</itunes:duration>` : ''}
      <guid isPermaLink="false">${f.share_token}</guid>
      <pubDate>${new Date(f.created_at || Date.now()).toUTCString()}</pubDate>
    </item>`).join('\n    ')}
  </channel>
</rss>`);
});

// ── Waveform API ──────────────────────────────────────────────────────────────
app.get('/api/waveform/:token', (req, res) => {
  const row = stmt.getWaveform.get(req.params.token);
  if (!row?.waveform) return res.json({ peaks: null });
  try {
    res.json({ peaks: JSON.parse(row.waveform) });
  } catch { res.json({ peaks: null }); }
});

// ── Play tracking ─────────────────────────────────────────────────────────────
app.post('/api/play/:token', (req, res) => {
  const row = stmt.getFileIdByToken.get(req.params.token);
  if (!row) return res.status(404).end();
  stmt.incrementPlayCount.run(req.params.token);
  stmt.insertPlayEvt.run(row.id);
  res.status(204).end();
});

// ── REST API v1 ───────────────────────────────────────────────────────────────
app.get('/api/v1/playlist/:token', (req, res) => {
  const playlist = stmt.getPlaylistByShareTokenFull.get(req.params.token);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  if (playlist.playlist_password && !req.session['pl_auth_' + req.params.token])
    return res.status(403).json({ error: 'Password required' });
  const tracks = stmt.getFilesPublicPlaylistFull.all(playlist.id)
    .filter(f => !isExpired(f))
    .map(f => ({
      token: f.share_token, name: f.title_tag || f.original_name.replace(/\.[^.]+$/,''),
      original_name: f.original_name, artist: f.artist, album: f.album,
      duration: f.duration, size: f.size, codec: f.codec,
      stream_url: `/stream/${f.share_token}`,
      cover_url: f.has_cover ? `/covers/${f.share_token}` : null,
      play_count: f.play_count,
    }));
  res.json({ id: playlist.id, name: playlist.name, track_count: tracks.length, tracks });
});

app.get('/api/v1/me', requireAuth, (req, res) => {
  const u = stmt.getUserFull.get(req.session.user.id);
  res.json({ id: u.id, username: u.username, role: u.role });
});

app.get('/api/v1/me/playlists', requireAuth, (req, res) => {
  const playlists = req.session.user.role === ROLES.ADMIN
    ? stmt.getAllPlaylists.all()
    : stmt.getPlaylistsByOwner.all(req.session.user.id);
  res.json(playlists);
});

app.get('/api/v1/me/playlists/:id/tracks', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist))
    return res.status(403).json({ error: 'Forbidden' });
  const tracks = stmt.getFilesForPlaylist.all(playlist.id);
  res.json(tracks);
});

// ── Embed ─────────────────────────────────────────────────────────────────────
app.get('/embed/:token', (req, res) => {
  const playlist = stmt.getPlaylistByShareTokenFull.get(req.params.token);
  if (!playlist) return res.status(404).render('error', { message:'Playlist introuvable', user:null });
  if (playlist.playlist_password && !req.session['pl_auth_' + req.params.token])
    return res.status(403).render('error', { message:'Accès restreint', user:null });
  const files = stmt.getFilesPublicPlaylistFull.all(playlist.id).filter(f => !isExpired(f));
  res.render('embed', { playlist, files });
});

app.get('/l/:token', (req, res) => {
  const sharedLink = stmt.getSharedLinkByToken.get(req.params.token);
  if (!sharedLink) return res.status(404).render('error', { message:'Lien introuvable', user:null });

  const playlists = stmt.getSharedLinkPlaylists.all(sharedLink.id).map(playlist => ({
    ...playlist,
    files: stmt.getFilesPublicPlaylistFull.all(playlist.id).filter(f => !isExpired(f)),
  })).filter(playlist => playlist.files.length > 0 || playlist.file_count > 0);

  if (!playlists.length) {
    return res.status(404).render('error', { message:'Aucune playlist disponible pour ce lien', user:null });
  }

  const selectedPlaylistId = req.query.playlist ? parseInt(req.query.playlist, 10) : playlists[0].id;
  res.render('shared-link', { sharedLink, playlists, selectedPlaylistId });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (req, res) => {
  const users = stmt.getAllUsersFull.all();
  const playlists = stmt.getAllPlaylists.all();
  const sharedLinks = stmt.getAllSharedLinks.all().map(link => {
    const playlistsForLink = stmt.getSharedLinkPlaylists.all(link.id);
    return {
      ...link,
      playlists: playlistsForLink,
      playlist_ids: playlistsForLink.map(p => p.id),
    };
  });
  const settings = {};
  stmt.getAllSettings.all().forEach(s => { settings[s.key] = s.value; });

  // Stats utilisation par user
  const usersWithStorage = users.map(u => ({
    ...u,
    storage_used: stmt.getUserStorageUsed.get(u.id).total,
  }));

  res.render('admin', {
    users: usersWithStorage, playlists, sharedLinks, settings,
    stats: {
      totalFiles: stmt.countFiles.get().c,
      totalSize:  stmt.sumFileSize.get().s,
      totalUsers: users.length,
      totalPlaylists: playlists.length,
      playsToday: stmt.getPlaysToday.get().c,
      topTracks:  stmt.getTopTracks.all(),
      playsPerDay: stmt.getPlaysPerDay.all(),
    },
    error: req.query.error || null,
  });
});

app.post('/admin/shared-links', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const raw = Array.isArray(req.body.playlist_ids) ? req.body.playlist_ids : [req.body.playlist_ids];
  const playlistIds = [...new Set(raw.map(id => parseInt(id, 10)).filter(Number.isInteger))];

  if (!name) return res.redirect('/admin?error=Nom du lien requis');
  if (!playlistIds.length) return res.redirect('/admin?error=Selectionnez au moins une playlist');

  const validPlaylistIds = new Set(stmt.getAllPlaylists.all().map(p => p.id));
  if (playlistIds.some(id => !validPlaylistIds.has(id))) {
    return res.redirect('/admin?error=Une playlist selectionnee est invalide');
  }

  createSharedLinkWithPlaylists(name, playlistIds);
  res.redirect('/admin');
});

app.post('/admin/shared-links/:id/delete', requireAdmin, (req, res) => {
  stmt.deleteSharedLink.run(parseInt(req.params.id, 10));
  res.redirect('/admin');
});

app.post('/admin/shared-links/:id/update', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const link = stmt.getSharedLinkById.get(id);
  if (!link) return res.redirect('/admin?error=Lien introuvable');

  const raw = Array.isArray(req.body.playlist_ids) ? req.body.playlist_ids : [req.body.playlist_ids];
  const playlistIds = [...new Set(raw.map(val => parseInt(val, 10)).filter(Number.isInteger))];

  if (!playlistIds.length) return res.redirect('/admin?error=Selectionnez au moins une playlist');

  const validPlaylistIds = new Set(stmt.getAllPlaylists.all().map(p => p.id));
  if (playlistIds.some(id => !validPlaylistIds.has(id))) {
    return res.redirect('/admin?error=Une playlist selectionnee est invalide');
  }

  stmt.deleteSharedLinkPlaylists.run(link.id);
  playlistIds.forEach(pid => stmt.insertSharedLinkPlaylist.run(link.id, pid));
  res.redirect('/admin');
});

app.post('/admin/users', requireAdmin, (req, res) => {
  const { username, password, role, email } = req.body;
  if (!username || !password) return res.redirect('/admin?error=Champs requis');
  try {
    const validRole = Object.values(ROLES).includes(role) ? role : ROLES.UPLOADER;
    stmt.insertUser.run(username, bcrypt.hashSync(password,10), validRole, email || null);
  } catch { return res.redirect('/admin?error=Nom déjà pris'); }
  res.redirect('/admin');
});

app.post('/admin/users/:id/update', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const email = (req.body.email || '').trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.redirect('/admin?error=Email invalide');
  }
  const quota = parseInt(req.body.quota_mb, 10);
  const newPassword = (req.body.new_password || '').trim();
  if (newPassword && newPassword.length < 8) {
    return res.redirect('/admin?error=Le mot de passe doit faire au moins 8 caractères');
  }
  db.transaction(() => {
    stmt.updateUserEmail.run(email, userId);
    stmt.updateUserQuota.run(isNaN(quota) || quota <= 0 ? null : quota, userId);
    if (newPassword) stmt.updateUserPassword.run(bcrypt.hashSync(newPassword, 10), userId);
  })();
  res.redirect('/admin');
});

// ── Profile ───────────────────────────────────────────────────────────────────
app.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { error: null, success: null, webauthnCreds: stmt.getWebAuthnCredsByUser.all(req.session.user.id) });
});

app.post('/profile/password', requireAuth, (req, res) => {
  const render = (error, success) => res.render('profile', { error, success, webauthnCreds: stmt.getWebAuthnCredsByUser.all(req.session.user.id) });
  const current = (req.body.current_password || '').trim();
  const newPwd  = (req.body.new_password   || '').trim();
  const confirm = (req.body.confirm        || '').trim();
  const user = stmt.getUserByUsername.get(req.session.user.username);
  if (!bcrypt.compareSync(current, user.password))
    return render('Mot de passe actuel incorrect.', null);
  if (newPwd.length < 8)
    return render('Le nouveau mot de passe doit faire au moins 8 caractères.', null);
  if (newPwd !== confirm)
    return render('Les mots de passe ne correspondent pas.', null);
  stmt.updateUserPassword.run(bcrypt.hashSync(newPwd, 10), user.id);
  render(null, 'Mot de passe mis à jour.');
});

// ── WebAuthn ──────────────────────────────────────────────────────────────────
const getOrigin = req => `${req.protocol}://${req.get('host')}`;
const getRpName = ()  => getSetting('webauthn_rp_name') || 'AudioBoard';

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-fA-F:]+\]?$/;
function getRpID(req) {
  const configured = getSetting('webauthn_rp_id');
  if (configured) return configured;
  const h = req.hostname;
  // Adresse de loopback → utiliser 'localhost' (équivalent WebAuthn)
  if (h === '127.0.0.1' || h === '::1') return 'localhost';
  return h;
}
function assertValidRpID(rpID, res) {
  if (IP_RE.test(rpID)) {
    res.status(400).json({
      error: `WebAuthn ne fonctionne pas avec une adresse IP (${rpID}). ` +
             `Accédez via http://localhost:${PORT}/ ou configurez le RP ID dans les paramètres d'administration.`,
    });
    return false;
  }
  return true;
}

app.post('/profile/webauthn/register/start', requireAuth, async (req, res) => {
  try {
    const rpID = getRpID(req);
    if (!assertValidRpID(rpID, res)) return;
    const { id, username } = req.session.user;
    const existing = stmt.getWebAuthnCredsByUser.all(id);
    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID,
      userName: username,
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports || '[]'),
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    req.session.webauthnRegChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error('WebAuthn register start:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/profile/webauthn/register/finish', requireAuth, async (req, res) => {
  try {
    const { id } = req.session.user;
    const expectedChallenge = req.session.webauthnRegChallenge;
    if (!expectedChallenge) return res.status(400).json({ error: 'Aucune cérémonie en cours' });
    const { registrationResponse, nickname } = req.body;
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpID(req),
    });
    if (!verified || !registrationInfo) return res.status(400).json({ error: 'Vérification échouée' });
    const { credential } = registrationInfo;
    stmt.insertWebAuthnCred.run(
      id,
      Buffer.from(credential.id, 'base64url'),
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports || []),
      (nickname || '').trim() || `Clé ${new Date().toLocaleDateString('fr-FR')}`,
    );
    delete req.session.webauthnRegChallenge;
    res.json({ ok: true });
  } catch (err) {
    console.error('WebAuthn register finish:', err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/profile/webauthn/credentials', requireAuth, (req, res) => {
  const creds = stmt.getWebAuthnCredsByUser.all(req.session.user.id).map(c => ({
    id: c.id, nickname: c.nickname, created_at: c.created_at, last_used_at: c.last_used_at,
  }));
  res.json(creds);
});

app.post('/profile/webauthn/credentials/:id/rename', requireAuth, (req, res) => {
  const nickname = (req.body.nickname || '').trim();
  if (!nickname) return res.status(400).json({ error: 'Nom requis' });
  stmt.updateWebAuthnNickname.run(nickname, parseInt(req.params.id, 10), req.session.user.id);
  res.json({ ok: true });
});

app.post('/profile/webauthn/credentials/:id/delete', requireAuth, (req, res) => {
  stmt.deleteWebAuthnCred.run(parseInt(req.params.id, 10), req.session.user.id);
  res.json({ ok: true });
});

app.post('/login/webauthn/start', async (req, res) => {
  try {
    const rpID = getRpID(req);
    if (!assertValidRpID(rpID, res)) return;
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: [],
      userVerification: 'required',
    });
    req.session.webauthnAuthChallenge = { challenge: options.challenge };
    res.json(options);
  } catch (err) {
    console.error('WebAuthn auth start:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/login/webauthn/finish', async (req, res) => {
  const fail = () => res.status(401).json({ error: 'Authentification échouée' });
  try {
    const sessionData = req.session.webauthnAuthChallenge;
    if (!sessionData) return fail();
    const { challenge: expectedChallenge } = sessionData;
    const assertionResponse = req.body;
    const credIdBuf = Buffer.from(assertionResponse.rawId, 'base64url');
    const cred = stmt.getWebAuthnCredByCredId.get(credIdBuf);
    if (!cred) return fail();
    const user = stmt.getUserById.get(cred.user_id);
    if (!user) return fail();
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpID(req),
      credential: {
        id: Buffer.from(cred.credential_id).toString('base64url'),
        publicKey: new Uint8Array(cred.public_key),
        counter: cred.sign_count,
        transports: JSON.parse(cred.transports || '[]'),
      },
    });
    if (!verified) return fail();
    stmt.updateWebAuthnCounter.run(authenticationInfo.newCounter, cred.id);
    delete req.session.webauthnAuthChallenge;
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ ok: true, redirect: '/' });
  } catch (err) {
    console.error('WebAuthn auth finish:', err);
    fail();
  }
});

app.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (userId === req.session.user.id) return res.redirect('/admin?error=Impossible de supprimer votre propre compte');
  stmt.deleteUser.run(userId);
  res.redirect('/admin');
});

app.post('/admin/playlists/:id/delete', requireAdmin, (req, res) => {
  deletePlaylist(parseInt(req.params.id, 10));
  res.redirect('/admin');
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const { compression_codec, compression_bitrate, retention_days, empty_playlist_retention_days,
          webrtc_enabled, passwordless_enabled, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from,
          webauthn_enabled, webauthn_rp_id, webauthn_rp_name } = req.body;
  stmt.upsertSetting.run('compression_codec',   CODECS.includes(compression_codec) ? compression_codec : 'none');
  stmt.upsertSetting.run('compression_bitrate', compression_bitrate || '128');
  stmt.upsertSetting.run('retention_days',                 retention_days || '30');
  stmt.upsertSetting.run('empty_playlist_retention_days', String(Math.max(0, parseInt(empty_playlist_retention_days || '0', 10))));
  stmt.upsertSetting.run('webrtc_enabled',      webrtc_enabled      === '1' ? '1' : '0');
  stmt.upsertSetting.run('passwordless_enabled',passwordless_enabled === '1' ? '1' : '0');
  stmt.upsertSetting.run('smtp_host',    (smtp_host   || '').trim());
  stmt.upsertSetting.run('smtp_port',    smtp_port || '587');
  stmt.upsertSetting.run('smtp_secure',  smtp_secure === '1' ? '1' : '0');
  stmt.upsertSetting.run('smtp_user',    (smtp_user  || '').trim());
  if (smtp_pass) stmt.upsertSetting.run('smtp_pass', smtp_pass);
  stmt.upsertSetting.run('smtp_from',    (smtp_from  || '').trim());
  stmt.upsertSetting.run('webauthn_enabled', webauthn_enabled === '1' ? '1' : '0');
  stmt.upsertSetting.run('webauthn_rp_id',   (webauthn_rp_id   || '').trim());
  stmt.upsertSetting.run('webauthn_rp_name', (webauthn_rp_name || 'AudioBoard').trim());
  res.redirect('/admin');
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanupExpired() {
  // Fichiers expirés
  const expired = stmt.getExpired.all();
  const affectedPlaylists = new Set();
  for (const f of expired) {
    tryUnlink(safeUploadPath(f.filename));
    if (f.playlist_id) affectedPlaylists.add(f.playlist_id);
    stmt.deleteFile.run(f.id);
  }
  for (const pid of affectedPlaylists) updatePlaylistEmptySince(pid);
  if (expired.length) console.log(`Nettoyage : ${expired.length} fichier(s) expiré(s)`);

  // Playlists vides depuis trop longtemps
  const emptyDays = parseInt(getSetting('empty_playlist_retention_days') || '0', 10);
  if (emptyDays > 0) {
    const emptyPlaylists = stmt.getExpiredEmptyPlaylists.all(emptyDays);
    for (const p of emptyPlaylists) deletePlaylist(p.id);
    if (emptyPlaylists.length) console.log(`Nettoyage : ${emptyPlaylists.length} playlist(s) vide(s) supprimée(s)`);
  }

  stmt.deleteExpiredMagicTokens.run();
}
setInterval(cleanupExpired, 60 * 60 * 1000);
cleanupExpired();

app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send('User-agent: *\nDisallow: /listen/\nDisallow: /stream/\nDisallow: /playlist/\n'));

// HEAD /stream/:token — nécessaire pour que le loader P2P connaisse la taille du fichier
app.head('/stream/:token', (req, res) => {
  const file = stmt.getFileByToken.get(req.params.token);
  if (!file) return res.status(404).end();
  if (isExpired(file)) return res.status(410).end();
  if (req.query.transcode === 'mp3' && (file.codec === 'opus' || file.codec === 'opus_live')) {
    return res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).end();
  }
  // opus_live : pas de Content-Length (chunked), P2PAudio tombera en fallback HTTP direct
  if (file.codec === 'opus_live') {
    return res.set({ 'Content-Type': 'audio/webm' }).end();
  }
  try {
    const stat = fs.statSync(safeUploadPath(file.filename));
    const mime = CODEC_MIME[file.codec] || 'audio/mpeg';
    res.set({ 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' }).end();
  } catch { res.status(404).end(); }
});

// ── HTTP server + WebSocket signaling P2P ─────────────────────────────────
const httpServer = createServer(app);

const wss = new WebSocketServer({ server: httpServer, path: '/p2p' });
// rooms : token -> Map<peerId, ws>
const rooms = new Map();

function sendWs(ws, obj) { ws.readyState === 1 && ws.send(JSON.stringify(obj)); }

wss.on('connection', ws => {
  const peerId = uuidv4();
  let room = null;

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'join') {
        room = msg.token;
        if (!rooms.has(room)) rooms.set(room, new Map());
        const peers = rooms.get(room);
        sendWs(ws, { type: 'ready', peerId });
        sendWs(ws, { type: 'peers', peers: [...peers.keys()] });
        peers.forEach(pws => sendWs(pws, { type: 'peer-join', peerId }));
        peers.set(peerId, ws);

      } else if (msg.type === 'signal' && room) {
        const target = rooms.get(room)?.get(msg.to);
        if (target) sendWs(target, { type: 'signal', from: peerId, data: msg.data });
      }
    } catch {}
  });

  ws.on('close', () => {
    if (!room) return;
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(peerId);
    peers.forEach(pws => sendWs(pws, { type: 'peer-leave', peerId }));
    if (peers.size === 0) rooms.delete(room);
  });
});

httpServer.listen(PORT, () => console.log(`AudioBoard lancé sur http://localhost:${PORT}`));
