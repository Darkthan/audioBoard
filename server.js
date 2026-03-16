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

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const ROLES = { ADMIN: 'admin', UPLOADER: 'uploader' };

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data', 'audioboard.db'));
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
})();

// ── Cached statements ─────────────────────────────────────────────────────────
const stmt = {
  getSetting:    db.prepare('SELECT value FROM settings WHERE key = ?'),
  upsertSetting: db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  getAllSettings: db.prepare('SELECT * FROM settings'),

  getUserByUsername: db.prepare('SELECT id,username,password,role,email FROM users WHERE username=?'),
  getUserById:       db.prepare('SELECT id,username,role FROM users WHERE id=?'),
  getAdminExists:    db.prepare("SELECT id FROM users WHERE role='admin'"),
  getAllUsers:       db.prepare('SELECT id,username,role,email,created_at FROM users ORDER BY created_at'),
  insertUser:        db.prepare('INSERT INTO users (username,password,role,email) VALUES (?,?,?,?)'),
  updateUserEmail:   db.prepare('UPDATE users SET email=? WHERE id=?'),
  deleteUser:        db.prepare('DELETE FROM users WHERE id=?'),

  insertMagicToken:        db.prepare('INSERT INTO magic_tokens (user_id,token,expires_at) VALUES (?,?,?)'),
  getMagicToken:           db.prepare('SELECT id,user_id,expires_at FROM magic_tokens WHERE token=?'),
  deleteMagicToken:        db.prepare('DELETE FROM magic_tokens WHERE id=?'),
  deleteExpiredMagicTokens:db.prepare("DELETE FROM magic_tokens WHERE expires_at < datetime('now')"),

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
    INSERT INTO audio_files (original_name,filename,share_token,playlist_id,uploaded_by,position,size,compressed,codec,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `),
  updateFilePosition:    db.prepare('UPDATE audio_files SET position=? WHERE id=? AND playlist_id=?'),
  deleteFile:            db.prepare('DELETE FROM audio_files WHERE id=?'),
  deleteFilesByPlaylist: db.prepare('DELETE FROM audio_files WHERE playlist_id=?'),
  countFiles:  db.prepare('SELECT COUNT(*) as c FROM audio_files'),
  sumFileSize: db.prepare('SELECT COALESCE(SUM(size),0) as s FROM audio_files'),
  getExpired:  db.prepare("SELECT id,filename FROM audio_files WHERE expires_at IS NOT NULL AND expires_at<datetime('now')"),
};

// ── Default settings & admin ──────────────────────────────────────────────────
const CODECS = ['none', 'mp3', 'aac', 'opus', 'opus_live'];
const defaults = {
  compression_codec:'mp3', compression_bitrate:'128', retention_days:'30',
  webrtc_enabled:'1',
  passwordless_enabled:'0',
  smtp_host:'', smtp_port:'587', smtp_secure:'0', smtp_user:'', smtp_pass:'', smtp_from:'',
};
const upsertIgnore = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k,v] of Object.entries(defaults)) upsertIgnore.run(k, v);

if (!stmt.getAdminExists.get()) {
  stmt.insertUser.run('admin', bcrypt.hashSync('admin',10), ROLES.ADMIN, null);
  console.log('Compte admin créé : admin / admin');
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

function deletePlaylist(id) {
  for (const f of stmt.getFilesByPlaylistId.all(id)) tryUnlink(safeUploadPath(f.filename));
  stmt.deleteFilesByPlaylist.run(id);
  stmt.deletePlaylist.run(id);
}

const reorderPlaylist = db.transaction((playlistId, orderedIds) => {
  orderedIds.forEach((id, i) => stmt.updateFilePosition.run(i, id, playlistId));
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

function requireAuth(req, res, next)  { if (req.session.user) return next(); res.redirect('/login'); }
function requireAdmin(req, res, next) {
  if (req.session.user?.role === ROLES.ADMIN) return next();
  res.status(403).render('error', { message:'Accès refusé', user: req.session.user });
}
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.webrtcEnabled = getSetting('webrtc_enabled') !== '0';
  res.locals.passwordlessEnabled = getSetting('passwordless_enabled') === '1';
  next();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, info: req.query.info || null });
});

app.post('/login', (req, res) => {
  const user = stmt.getUserByUsername.get(req.body.username);
  if (!user || !bcrypt.compareSync(req.body.password, user.password))
    return res.render('login', { error: 'Identifiants incorrects', info: null });
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/');
});

app.post('/login/magic', async (req, res) => {
  const renderLogin = (error, info) => res.render('login', { error, info });
  const user = stmt.getUserByUsername.get((req.body.username || '').trim());

  // Réponse neutre même si l'utilisateur n'existe pas (sécurité)
  if (!user || !user.email) {
    return renderLogin(null, 'Si ce compte existe et possède une adresse email, un lien vous a été envoyé.');
  }

  const transporter = createTransporter();
  if (!transporter) return renderLogin('Le serveur email n\'est pas configuré. Contactez l\'administrateur.', null);

  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  stmt.insertMagicToken.run(user.id, token, expiresAt);

  const link = `${req.protocol}://${req.get('host')}/login/magic/${token}`;
  try {
    await transporter.sendMail({
      from:    getSetting('smtp_from') || getSetting('smtp_user'),
      to:      user.email,
      subject: 'Votre lien de connexion AudioBoard',
      html:    `<p>Bonjour <strong>${user.username}</strong>,</p>
                <p><a href="${link}" style="font-size:1.1em">Cliquez ici pour vous connecter</a></p>
                <p style="color:#888;font-size:.9em">Ce lien expire dans 15 minutes. S'il ne s'affiche pas, copiez : ${link}</p>`,
    });
  } catch (err) {
    console.error('Magic link email error:', err.message);
    return renderLogin('Échec de l\'envoi de l\'email. Vérifiez la configuration SMTP.', null);
  }

  renderLogin(null, 'Lien de connexion envoyé ! Vérifiez votre boîte mail.');
});

app.get('/login/magic/:token', (req, res) => {
  const record = stmt.getMagicToken.get(req.params.token);
  if (!record || new Date(record.expires_at) < new Date()) {
    stmt.deleteMagicToken.run(record?.id);
    return res.render('login', { error: 'Lien invalide ou expiré. Demandez-en un nouveau.', info: null });
  }
  stmt.deleteMagicToken.run(record.id);
  const user = stmt.getUserById.get(record.user_id);
  if (!user) return res.render('login', { error: 'Compte introuvable.', info: null });
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── Dashboard (liste des playlists) ──────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  const { user } = req.session;
  const playlists = user.role === ROLES.ADMIN
    ? stmt.getAllPlaylists.all()
    : stmt.getPlaylistsByOwner.all(user.id);
  res.render('dashboard', { playlists, error: req.query.error || null });
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

// Reorder tracks (JSON API)
app.post('/playlists/:id/reorder', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist)) return res.status(403).json({ error:'Non autorisé' });
  const { order } = req.body; // array of file ids
  if (!Array.isArray(order)) return res.status(400).json({ error:'order requis' });
  reorderPlaylist(playlist.id, order.map(Number));
  res.json({ ok: true });
});

// ── Playlist editor page ──────────────────────────────────────────────────────
app.get('/playlists/:id', requireAuth, (req, res) => {
  const playlist = stmt.getPlaylistById.get(req.params.id);
  if (!playlist || !canManage(req.session.user, playlist))
    return res.status(404).render('error', { message:'Playlist introuvable', user: req.session.user });
  const files = stmt.getFilesForPlaylist.all(playlist.id);
  res.render('playlist-editor', { playlist, files, error: req.query.error || null });
});

// ── Upload ────────────────────────────────────────────────────────────────────
const CODEC_MIME = { none: 'audio/mpeg', mp3: 'audio/mpeg', aac: 'audio/aac', opus: 'audio/webm', opus_live: 'audio/webm' };

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
      // Fichier original conservé, transcoding à la volée au moment du stream
      codec = 'opus_live';
    }
    // none : fichier original conservé, codec reste 'none'
  } catch (err) {
    console.error(`Compression [${options.codec}]:`, err.message);
  }

  const stats = fs.statSync(safeUploadPath(finalFilename));
  stmt.insertFile.run(
    file.originalname, finalFilename, shareToken, playlistId, userId,
    position, stats.size, codec !== 'none' ? 1 : 0, codec, expiresAt
  );
}

app.post('/upload', requireAuth, upload.array('audio', 50), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error:'Aucun fichier' });
    const { playlist_id } = req.body;
    const playlist = stmt.getPlaylistById.get(playlist_id);
    if (!playlist || !canManage(req.session.user, playlist))
      return res.status(403).json({ error:'Non autorisé' });

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

// ── File delete ───────────────────────────────────────────────────────────────
app.post('/files/:id/delete', requireAuth, (req, res) => {
  const file = stmt.getFileById.get(req.params.id);
  if (!file) return res.status(404).json({ error:'Introuvable' });
  const playlist = file.playlist_id ? stmt.getPlaylistById.get(file.playlist_id) : null;
  if (!playlist || !canManage(req.session.user, playlist))
    return res.status(403).json({ error:'Non autorisé' });
  tryUnlink(safeUploadPath(file.filename));
  stmt.deleteFile.run(file.id);
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

  // Opus live : transcoding à la volée, pas de range, pas de Content-Length
  if (file.codec === 'opus_live') {
    res.set({ 'Content-Type': 'audio/webm', 'Transfer-Encoding': 'chunked' });
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

  let stat;
  try { stat = fs.statSync(filePath); } catch { return res.status(404).send('File missing'); }
  const mime = CODEC_MIME[file.codec] || 'audio/mpeg';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10), end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range':`bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges':'bytes', 'Content-Length': end-start+1, 'Content-Type': mime });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Public playlist page ──────────────────────────────────────────────────────
app.get('/playlist/:token', (req, res) => {
  const playlist = stmt.getPlaylistByShareToken.get(req.params.token);
  if (!playlist) return res.status(404).render('error', { message:'Playlist introuvable', user:null });
  const files = stmt.getFilesPublicPlaylist.all(playlist.id).filter(f => !isExpired(f));
  res.render('playlist', { playlist, files });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (req, res) => {
  const users = stmt.getAllUsers.all();
  const playlists = stmt.getAllPlaylists.all();
  const settings = {};
  stmt.getAllSettings.all().forEach(s => { settings[s.key] = s.value; });
  res.render('admin', {
    users, playlists, settings,
    stats: { totalFiles: stmt.countFiles.get().c, totalSize: stmt.sumFileSize.get().s, totalUsers: users.length, totalPlaylists: playlists.length },
    error: req.query.error || null,
  });
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

app.post('/admin/users/:id/email', requireAdmin, (req, res) => {
  stmt.updateUserEmail.run((req.body.email || '').trim() || null, parseInt(req.params.id, 10));
  res.redirect('/admin');
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
  const { compression_codec, compression_bitrate, retention_days, webrtc_enabled,
          passwordless_enabled, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from } = req.body;
  stmt.upsertSetting.run('compression_codec',   CODECS.includes(compression_codec) ? compression_codec : 'none');
  stmt.upsertSetting.run('compression_bitrate', compression_bitrate || '128');
  stmt.upsertSetting.run('retention_days',      retention_days || '30');
  stmt.upsertSetting.run('webrtc_enabled',      webrtc_enabled      === '1' ? '1' : '0');
  stmt.upsertSetting.run('passwordless_enabled',passwordless_enabled === '1' ? '1' : '0');
  stmt.upsertSetting.run('smtp_host',    (smtp_host   || '').trim());
  stmt.upsertSetting.run('smtp_port',    smtp_port || '587');
  stmt.upsertSetting.run('smtp_secure',  smtp_secure === '1' ? '1' : '0');
  stmt.upsertSetting.run('smtp_user',    (smtp_user  || '').trim());
  stmt.upsertSetting.run('smtp_pass',    smtp_pass  || '');
  stmt.upsertSetting.run('smtp_from',    (smtp_from  || '').trim());
  res.redirect('/admin');
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanupExpired() {
  const expired = stmt.getExpired.all();
  for (const f of expired) { tryUnlink(safeUploadPath(f.filename)); stmt.deleteFile.run(f.id); }
  if (expired.length) console.log(`Nettoyage : ${expired.length} fichier(s) expiré(s)`);
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
