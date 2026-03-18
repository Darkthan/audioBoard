#!/usr/bin/env node
'use strict';
/**
 * Génère les captures d'écran pour la documentation.
 * Requiert : serveur lancé + DB seedée.
 * Usage : APP_URL=http://localhost:3000 node scripts/take-screenshots.js
 */
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const BASE    = process.env.APP_URL || 'http://localhost:3000';
const OUT     = path.join(__dirname, '..', 'docs', 'screenshots');
const DB_PATH = path.join(__dirname, '..', 'data', 'audioboard.db');

fs.mkdirSync(OUT, { recursive: true });

// ── Lire les données de test depuis la DB ─────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true });
const firstPublic = db.prepare(`
  SELECT p.id, p.share_token, af.share_token as track_token, af.original_name
  FROM playlists p
  JOIN audio_files af ON af.playlist_id = p.id
  WHERE p.share_token IS NOT NULL
  ORDER BY af.position LIMIT 1
`).get() ?? {};

const firstPlaylist = db.prepare(`
  SELECT p.id, p.name, af.share_token as track_token, af.original_name
  FROM playlists p
  JOIN audio_files af ON af.playlist_id = p.id
  ORDER BY p.id, af.position LIMIT 1
`).get() ?? {};
db.close();

const PUBLIC_URL   = firstPublic.share_token   ? `${BASE}/playlist/${firstPublic.share_token}` : null;
const PLAYLIST_URL = firstPlaylist.id           ? `${BASE}/playlists/${firstPlaylist.id}`       : null;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function shot(page, name) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`  ✓ ${name}.png`);
}

async function loginWithPassword(page, username, password) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('networkidle');
  // Étape 1 : saisie du nom d'utilisateur
  await page.fill('#usernameInput', username);
  await page.click('#continueBtn');
  // Étape 2 : saisie du mot de passe
  await page.waitForSelector('#password', { state: 'visible' });
  await page.fill('#password', password);
  await page.locator('#formPassword [type=submit]').click();
  await page.waitForURL(`${BASE}/`);
}

/**
 * Injecte un état "en lecture" complet dans le player sans audio réel.
 * Reconstruit les barres de la waveform, affiche la progression, l'icône pause,
 * les temps réalistes et fait tourner le disque vinyle.
 */
async function simulatePlayer(page, { token, name, playlistName, progress = 0.37,
                                      currentTime = '1:23', duration = '3:44' } = {}) {
  await page.evaluate(({ token, name, playlistName, progress, currentTime, duration }) => {
    const BAR_COUNT = 120;

    // Construire les barres (même algo que le player)
    function buildBarsHTML(seed) {
      let s = seed;
      const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
      return Array.from({ length: BAR_COUNT }, (_, i) => {
        const env = Math.sin(Math.PI * i / BAR_COUNT);
        const h   = 0.12 + env * 0.72 * (0.35 + rand() * 0.65);
        return `<div class="sc-bar" style="height:${Math.round(h * 100)}%"></div>`;
      }).join('');
    }

    function applyProgress(containerId, prog) {
      const bars   = document.querySelectorAll(`#${containerId} .sc-bar`);
      const filled = Math.floor(prog * bars.length);
      bars.forEach((b, i) => b.classList.toggle('sc-bar-played', i < filled));
    }

    const seed = (token || 'demo').split('').reduce((a, c) => a + c.charCodeAt(0), 0) || 42;
    const html  = buildBarsHTML(seed);

    // Injecter les barres
    ['scBars', 'scFsBars'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.children.length === 0) el.innerHTML = html;
    });
    applyProgress('scBars',   progress);
    applyProgress('scFsBars', progress);

    // Labels
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('scTrackName',    name);
    set('scPlaylistName', playlistName);
    set('scMiniName',     name);
    set('scMiniPl',       playlistName);
    set('scFsName',       name);
    set('scFsPl',         playlistName);
    set('scTimeCurrent',  currentTime);
    set('scTimeDuration', duration);
    set('scFsTimeCur',    currentTime);
    set('scFsTimeDur',    duration);

    // Rendre le player visible
    document.getElementById('scPlayer')?.classList.add('sc-visible');

    // Icône pause (état "en lecture")
    ['scIconPlay', 'scMiniIconPlay', 'scFsIconPlay']
      .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    ['scIconPause', 'scMiniIconPause', 'scFsIconPause']
      .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });

    // Progression mini-player
    const fill = document.getElementById('scMiniFill');
    if (fill) fill.style.width = (progress * 100) + '%';

    // Disque vinyle en rotation
    document.getElementById('scFsDisc')?.classList.add('spinning');

    // Surligner la piste active dans la liste
    document.querySelectorAll('[data-sc-token]').forEach(el =>
      el.classList.toggle('sc-active', el.dataset.scToken === token)
    );
  }, { token, name, playlistName, progress, currentTime, duration });

  await page.waitForTimeout(200);
}

async function openFullscreen(page) {
  await page.evaluate(() => {
    document.getElementById('scFullscreen')?.classList.add('sc-fs-open');
    document.body.style.overflow = 'hidden';
  });
  await page.waitForTimeout(200);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch();
  const trackInfo = {
    token:        firstPlaylist.track_token || 'demo-token',
    name:         (firstPlaylist.original_name || 'Hotel California.mp3').replace(/\.mp3$/i, ''),
    playlistName: firstPlaylist.name || 'Rock Classics',
  };

  // ════════════════════════════════════════════════════════════════════════════
  // DESKTOP 1280 × 800
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\nDesktop (1280×800)…');
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await desktop.newPage();

  // 1. Connexion — mode mot de passe
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('networkidle');
  await shot(page, 'login-password');

  // 2. Connexion admin
  await loginWithPassword(page, 'admin', 'admin');

  // 3. Tableau de bord
  await shot(page, 'dashboard-admin');

  // 4. Éditeur de playlist + player simulé
  if (PLAYLIST_URL) {
    await page.goto(PLAYLIST_URL);
    await page.waitForLoadState('networkidle');
    await shot(page, 'playlist-editor');

    // 5. Player desktop avec audio simulé
    await simulatePlayer(page, trackInfo);
    await shot(page, 'player-desktop');
  }

  // 6. Panneau admin — vue globale
  await page.goto(`${BASE}/admin`);
  await page.waitForLoadState('networkidle');
  await shot(page, 'admin-panel');

  // 7. Section SMTP (scroll)
  const smtpInput = page.locator('input[name=smtp_host]');
  if (await smtpInput.count()) {
    await smtpInput.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, 'admin-smtp');
  }

  // 8. Activer passwordless → screenshot login magic link
  const pwCheck = page.locator('[name=passwordless_enabled]');
  if (await pwCheck.count() && !(await pwCheck.isChecked())) {
    await pwCheck.scrollIntoViewIfNeeded();
    await pwCheck.check();
    await page.locator('form[action="/admin/settings"] [type=submit]').click();
    await page.waitForLoadState('networkidle');
  }
  await page.goto(`${BASE}/logout`);
  await page.waitForURL(`${BASE}/login`);
  await page.waitForLoadState('networkidle');
  await shot(page, 'login-passwordless');

  // Reconnecter
  await loginWithPassword(page, 'admin', 'admin');

  // 9. Playlist publique avec player simulé
  if (PUBLIC_URL) {
    const anonCtx  = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(PUBLIC_URL);
    await anonPage.waitForLoadState('networkidle');
    await shot(anonPage, 'public-playlist');

    // Player simulé sur la page publique
    const pubTrack = {
      token:        firstPublic.track_token  || trackInfo.token,
      name:         (firstPublic.original_name || trackInfo.name).replace(/\.mp3$/i, ''),
      playlistName: 'Rock Classics',
    };
    await simulatePlayer(anonPage, pubTrack);
    await shot(anonPage, 'player-desktop-public');
    await anonCtx.close();
  }

  await desktop.close();

  // ════════════════════════════════════════════════════════════════════════════
  // MOBILE 390 × 844
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\nMobile (390×844)…');
  const mobile = await browser.newContext({
    viewport:  { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const mpage = await mobile.newPage();

  await loginWithPassword(mpage, 'admin', 'admin');

  if (PLAYLIST_URL) {
    await mpage.goto(PLAYLIST_URL);
    await mpage.waitForLoadState('networkidle');

    // Mini-player mobile simulé
    await simulatePlayer(mpage, { ...trackInfo, progress: 0.52, currentTime: '2:01', duration: '3:44' });
    await shot(mpage, 'player-mobile');

    // Plein écran mobile simulé
    await openFullscreen(mpage);
    await shot(mpage, 'player-fullscreen');
  }

  await mobile.close();
  await browser.close();

  const count = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).length;
  console.log(`\n✓ ${count} captures dans docs/screenshots/\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
