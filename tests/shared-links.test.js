const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');

test('shared menus navigate to listening and recording pages, with independent admin selection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioboard-shared-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3197', DATA_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      ADMIN_USER: 'test-admin', ADMIN_PASSWORD: 'test-password' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let db, browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
      server.stdout.on('data', chunk => {
        if (String(chunk).includes('AudioBoard lancé')) { clearTimeout(timer); resolve(); }
      });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
      server.stderr.on('data', chunk => process.stderr.write(chunk));
    });
    db = new Database(path.join(dir, 'audioboard.db'));
    db.pragma('foreign_keys = ON');
    const owner = db.prepare("SELECT id FROM users WHERE username = 'test-admin'").get().id;
    const playlist = db.prepare('INSERT INTO playlists (name, owner_id, playlist_password) VALUES (?, ?, ?)')
      .run('Écoute protégée', owner, bcrypt.hashSync('secret', 4)).lastInsertRowid;
    const record = db.prepare('INSERT INTO record_links (name, owner_id, playlist_id, token) VALUES (?, ?, ?, ?)')
      .run('Oral français', owner, playlist, 'record-test').lastInsertRowid;
    const installedEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    browser = await chromium.launch({ headless: true,
      ...(fs.existsSync(installedEdge) ? { executablePath: installedEdge } : {}),
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = 'http://127.0.0.1:3197';
    await page.request.post(base + '/login', { form: { username: 'test-admin', password: 'test-password' } });
    await page.goto(base + '/admin');
    const create = page.locator('.shared-link-create');
    await create.locator('[name=name]').fill('Menu test');
    await create.locator(`[name=playlist_ids][value="${playlist}"]`).check();
    await create.locator('[type=search]').fill('enregistrement');
    assert.equal(await create.locator('.playlist-checkbox:visible').count(), 1);
    await create.locator(`[name=record_ids][value="${record}"]`).check();
    await Promise.all([page.waitForURL(base + '/admin'), create.locator('[type=submit]').click()]);
    const link = db.prepare("SELECT * FROM shared_links WHERE name = 'Menu test'").get();
    const token = db.prepare('SELECT share_token FROM playlists WHERE id = ?').get(playlist).share_token;
    assert.ok(token);
    // Editing filters are independent from the creation form and keep hidden selections.
    await page.locator('.edit-link-btn').click();
    const edit = page.locator('.shared-link-form');
    await edit.locator('[type=search]').fill('protegee test-admin');
    assert.equal(await edit.locator('.playlist-checkbox:visible').count(), 1);
    assert.equal(await create.locator('.playlist-checkbox:visible').count(), 2);
    await edit.locator('[data-clear-selection]').click();
    await edit.locator('[type=search]').fill('oral');
    await edit.locator('[data-select-visible]').click();
    await Promise.all([page.waitForURL(base + '/admin'), edit.locator('[type=submit]').click()]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shared_link_playlists WHERE shared_link_id = ?').get(link.id).n, 0);
    const response = await page.request.post(base + `/admin/shared-links/${link.id}/update`, {
      form: { playlist_ids: String(playlist), record_ids: String(record) },
    });
    assert.equal(response.status(), 200);
    await page.goto(base + '/l/' + link.token);
    assert.equal(await page.locator('a.sl-pl-card').count(), 2);
    await page.locator('#destinationSearch').fill('enregistrement');
    assert.equal(await page.locator('a.sl-pl-card:visible').count(), 1);
    await page.locator('a.sl-pl-card:visible').click();
    assert.equal(new URL(page.url()).pathname, '/record/record-test');
    await page.goto(base + '/l/' + link.token);
    await page.locator(`a[href="/playlist/${token}"]`).click();
    assert.equal(await page.locator('input[type=password]').count(), 1);
    // A single destination still opens the menu; old query strings cannot bypass it.
    db.prepare('DELETE FROM shared_link_records WHERE shared_link_id = ?').run(link.id);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(base + '/l/' + link.token + '?playlist=' + playlist);
    assert.equal(await page.locator('a.sl-pl-card').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    db.prepare('UPDATE playlists SET share_token = NULL WHERE id = ?').run(playlist);
    await page.reload();
    assert.equal(await page.locator('a.sl-pl-card').count(), 0);
    db.prepare('DELETE FROM shared_link_playlists WHERE shared_link_id = ?').run(link.id);
    await page.reload();
    assert.match(await page.locator('main').innerText(), /Aucune playlist/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (db) db.close();
    const exited = once(server, 'exit');
    server.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
