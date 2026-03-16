const express = require('express');
const session = require('express-session');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

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

  // Add position column if missing (existing installs without folders migration)
  const afCols = db.prepare('PRAGMA table_info(audio_files)').all().map(c => c.name);
  if (!afCols.includes('position')) {
    db.exec('ALTER TABLE audio_files ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    // Initialise positions from creation order within each playlist
    db.exec(`
      UPDATE audio_files SET position = (
        SELECT COUNT(*) FROM audio_files af2
        WHERE af2.playlist_id = audio_files.playlist_id AND af2.id < audio_files.id
      )
    `);
  }
})();

// ── Cached statements ─────────────────────────────────────────────────────────
const stmt = {
  getSetting:    db.prepare('SELECT value FROM settings WHERE key = ?'),
  upsertSetting: db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  getAllSettings: db.prepare('SELECT * FROM settings'),

  getUserByUsername: db.prepare('SELECT id,username,password,role FROM users WHERE username=?'),
  getAdminExists:    db.prepare("SELECT id FROM users WHERE role='admin'"),
  getAllUsers:       db.prepare('SELECT id,username,role,created_at FROM users ORDER BY created_at'),
  insertUser:        db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)'),
  deleteUser:        db.prepare('DELETE FROM users WHERE id=?'),

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
  getFileByToken:             db.prepare('SELECT filename,expires_at FROM audio_files WHERE share_token=?'),
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
    INSERT INTO audio_files (original_name,filename,share_token,playlist_id,uploaded_by,position,size,compressed,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `),
  updateFilePosition:    db.prepare('UPDATE audio_files SET position=? WHERE id=? AND playlist_id=?'),
  deleteFile:            db.prepare('DELETE FROM audio_files WHERE id=?'),
  deleteFilesByPlaylist: db.prepare('DELETE FROM audio_files WHERE playlist_id=?'),
  countFiles:  db.prepare('SELECT COUNT(*) as c FROM audio_files'),
  sumFileSize: db.prepare('SELECT COALESCE(SUM(size),0) as s FROM audio_files'),
  getExpired:  db.prepare("SELECT id,filename FROM audio_files WHERE expires_at IS NOT NULL AND expires_at<datetime('now')"),
};

// ── Default settings & admin ──────────────────────────────────────────────────
const defaults = { compression_enabled:'1', compression_bitrate:'128', retention_days:'30' };
const upsertIgnore = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k,v] of Object.entries(defaults)) upsertIgnore.run(k, v);

if (!stmt.getAdminExists.get()) {
  stmt.insertUser.run('admin', bcrypt.hashSync('admin',10), ROLES.ADMIN);
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
app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});
app.post('/login', (req, res) => {
  const user = stmt.getUserByUsername.get(req.body.username);
  if (!user || !bcrypt.compareSync(req.body.password, user.password))
    return res.render('login', { error: 'Identifiants incorrects' });
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
async function persistFile(file, playlistId, userId, options) {
  const shareToken = uuidv4();
  const expiresAt  = new Date(Date.now() + options.retentionDays * 86400000).toISOString();
  const position   = stmt.maxPositionInPlaylist.get(playlistId).m + 1;
  let finalFilename = file.filename, compressed = 0;

  if (options.compressionEnabled) {
    const outFilename = `compressed_${uuidv4()}.mp3`;
    const outPath     = safeUploadPath(outFilename);
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(file.path).audioBitrate(options.bitrate).audioChannels(2).format('mp3')
          .on('end', resolve).on('error', reject).save(outPath);
      });
      tryUnlink(file.path);
      finalFilename = outFilename;
      compressed = 1;
    } catch (err) { console.error('Compression:', err.message); }
  }

  const stats = fs.statSync(safeUploadPath(finalFilename));
  stmt.insertFile.run(file.originalname, finalFilename, shareToken, playlistId, userId, position, stats.size, compressed, expiresAt);
}

app.post('/upload', requireAuth, upload.array('audio', 50), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error:'Aucun fichier' });
    const { playlist_id } = req.body;
    const playlist = stmt.getPlaylistById.get(playlist_id);
    if (!playlist || !canManage(req.session.user, playlist))
      return res.status(403).json({ error:'Non autorisé' });

    const options = {
      retentionDays:      parseInt(getSetting('retention_days'), 10),
      compressionEnabled: getSetting('compression_enabled') === '1',
      bitrate:            getSetting('compression_bitrate') || '128',
    };
    for (const file of req.files) await persistFile(file, playlist_id, req.session.user.id, options);
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
  let stat;
  try { stat = fs.statSync(filePath); } catch { return res.status(404).send('File missing'); }
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10), end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range':`bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges':'bytes', 'Content-Length': end-start+1, 'Content-Type':'audio/mpeg' });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type':'audio/mpeg' });
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
  const { username, password, role } = req.body;
  if (!username || !password) return res.redirect('/admin?error=Champs requis');
  try {
    stmt.insertUser.run(username, bcrypt.hashSync(password,10), Object.values(ROLES).includes(role) ? role : ROLES.UPLOADER);
  } catch { return res.redirect('/admin?error=Nom déjà pris'); }
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
  const { compression_enabled, compression_bitrate, retention_days } = req.body;
  stmt.upsertSetting.run('compression_enabled', compression_enabled ? '1' : '0');
  stmt.upsertSetting.run('compression_bitrate', compression_bitrate || '128');
  stmt.upsertSetting.run('retention_days', retention_days || '30');
  res.redirect('/admin');
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanupExpired() {
  const expired = stmt.getExpired.all();
  for (const f of expired) { tryUnlink(safeUploadPath(f.filename)); stmt.deleteFile.run(f.id); }
  if (expired.length) console.log(`Nettoyage : ${expired.length} fichier(s) expiré(s)`);
}
setInterval(cleanupExpired, 60 * 60 * 1000);
cleanupExpired();

app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send('User-agent: *\nDisallow: /listen/\nDisallow: /stream/\nDisallow: /playlist/\n'));

app.listen(PORT, () => console.log(`AudioBoard lancé sur http://localhost:${PORT}`));
