#!/usr/bin/env node
'use strict';
/**
 * Seed script — crée une base de test fraîche pour la CI et les screenshots.
 * Écrase la DB existante.
 */
const Database  = require('better-sqlite3');
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const UPLOADS   = path.join(ROOT, 'uploads');
const DB_PATH   = path.join(DATA_DIR, 'audioboard.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS,  { recursive: true });

// Fresh DB
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'uploader', email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, owner_id)
  );
  CREATE TABLE audio_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, original_name TEXT NOT NULL,
    filename TEXT NOT NULL, share_token TEXT UNIQUE NOT NULL,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    position INTEGER NOT NULL DEFAULT 0, size INTEGER,
    compressed INTEGER DEFAULT 0, codec TEXT NOT NULL DEFAULT 'none',
    expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE magic_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL, expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX idx_playlist_share_token
    ON playlists(share_token) WHERE share_token IS NOT NULL;
`);

// ── Users ─────────────────────────────────────────────────────────────────────
const insUser = db.prepare('INSERT INTO users (username,password,role,email) VALUES (?,?,?,?)');
const adminId = insUser.run('admin', bcrypt.hashSync('admin', 10), 'admin', 'admin@demo.local').lastInsertRowid;
const demoId  = insUser.run('demo',  bcrypt.hashSync('demo',  10), 'uploader', 'demo@demo.local').lastInsertRowid;

// ── Settings ──────────────────────────────────────────────────────────────────
const upsert = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
[
  ['compression_codec', 'mp3'], ['compression_bitrate', '128'], ['retention_days', '30'],
  ['webrtc_enabled', '1'], ['passwordless_enabled', '0'],
  ['smtp_host', ''], ['smtp_port', '587'], ['smtp_secure', '0'],
  ['smtp_user', ''], ['smtp_pass', ''], ['smtp_from', ''],
].forEach(([k, v]) => upsert.run(k, v));

// ── Test audio file ───────────────────────────────────────────────────────────
const audioFilename = 'test-audio.mp3';
const audioPath     = path.join(UPLOADS, audioFilename);
try {
  execSync(
    `ffmpeg -f lavfi -i sine=frequency=440:duration=3 -ar 44100 -ab 128k "${audioPath}" -y`,
    { stdio: 'ignore' }
  );
} catch {
  // Minimal valid MP3 fallback (silence frame)
  const frame = Buffer.alloc(417, 0);
  frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = 0x90;
  fs.writeFileSync(audioPath, frame);
}
const audioSize = fs.statSync(audioPath).size;

// ── Playlists & tracks ────────────────────────────────────────────────────────
const insPl = db.prepare('INSERT INTO playlists (name,owner_id,share_token) VALUES (?,?,?)');
const insTr = db.prepare(`
  INSERT INTO audio_files
    (original_name,filename,share_token,playlist_id,uploaded_by,position,size,codec,expires_at)
  VALUES (?,?,?,?,?,?,?,?,?)
`);
const expires = new Date(Date.now() + 30 * 86400_000).toISOString();

function addTrack(name, plId, userId, pos) {
  const tok = uuidv4();
  insTr.run(name, audioFilename, tok, plId, userId, pos, audioSize, 'none', expires);
  return tok;
}

const shareToken1 = uuidv4();
const pl1 = insPl.run('Rock Classics', adminId, shareToken1).lastInsertRowid;
addTrack('Back in Black.mp3',       pl1, adminId, 0);
addTrack('Bohemian Rhapsody.mp3',   pl1, adminId, 1);
addTrack('Hotel California.mp3',    pl1, adminId, 2);
addTrack('Stairway to Heaven.mp3',  pl1, adminId, 3);

const pl2 = insPl.run('Jazz Sessions', adminId, null).lastInsertRowid;
addTrack('So What.mp3',   pl2, adminId, 0);
addTrack('Take Five.mp3', pl2, adminId, 1);

const pl3 = insPl.run('Demo Tracks', demoId, uuidv4()).lastInsertRowid;
addTrack('My Track 01.mp3', pl3, demoId, 0);
addTrack('My Track 02.mp3', pl3, demoId, 1);

db.close();

console.log('✓ Test database seeded');
console.log(`  Admin    : admin / admin  (${DATA_DIR})`);
console.log(`  User     : demo  / demo`);
console.log(`  Public   : /playlist/${shareToken1}`);
console.log(`  Playlist : /playlists/${pl1}`);
