'use strict';
/**
 * AudioBoard P2P Audio Loader
 *
 * Stratégie :
 *  1. La piste démarre immédiatement via HTTP (comportement inchangé).
 *  2. En arrière-plan, les chunks sont téléchargés (peers d'abord, HTTP en fallback)
 *     et mis en cache dans IndexedDB.
 *  3. Les chunks disponibles localement sont annoncés aux pairs via DataChannel.
 *  4. Lors de la prochaine lecture du même token, l'audio est servi depuis le cache
 *     local (Blob URL) → charge serveur = 0.
 *
 * Compatibilité : fonctionne dans tout navigateur supportant WebRTC.
 * Dégradation : si WebRTC ou IDB indisponibles, seul le HTTP est utilisé.
 */
(function () {

  const CHUNK    = 256 * 1024;   // 256 Ko par chunk
  const MAX_PEERS = 4;
  const REQ_TIMEOUT = 7000;       // ms avant d'abandonner une requête peer
  const IDB_NAME  = 'audioboard-p2p';
  const IDB_STORE = 'chunks';     // clé : `${token}:${idx}`
  const STUN = [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  // ── IndexedDB cache ───────────────────────────────────────────────────────
  let _db = null;
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
      req.onsuccess  = e => { _db = e.target.result; res(_db); };
      req.onerror    = () => rej();
    });
  }
  async function idbGet(key) {
    try {
      const db = await openDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r  = tx.objectStore(IDB_STORE).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej();
      });
    } catch { return undefined; }
  }
  async function idbSet(key, val) {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const r  = tx.objectStore(IDB_STORE).put(val, key);
        r.onsuccess = res; r.onerror = rej;
      });
    } catch {}
  }
  async function idbGetAll(prefix) {
    try {
      const db = await openDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const range = IDBKeyRange.bound(prefix + ':', prefix + ':\uffff');
        const r = tx.objectStore(IDB_STORE).getAll(range);
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej();
      });
    } catch { return []; }
  }

  // ── In-memory chunk store (session) ──────────────────────────────────────
  class MemStore {
    constructor() { this._m = new Map(); }
    has(i)    { return this._m.has(i); }
    get(i)    { return this._m.get(i); }
    set(i, b) { this._m.set(i, b); }
    keys()    { return [...this._m.keys()]; }
  }

  // ── One WebRTC peer ───────────────────────────────────────────────────────
  class Peer {
    constructor(id, onSignal) {
      this.id      = id;
      this.have    = new Set();
      this._reqs   = new Map();
      this.ready   = false;
      this.onWant  = null;
      this.pc = new RTCPeerConnection({ iceServers: STUN });
      this.dc = null;
      this.pc.onicecandidate = e => e.candidate && onSignal({ type: 'ice', candidate: e.candidate });
    }

    attach(dc) {
      this.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.onopen  = () => { this.ready = true; };
      dc.onclose = () => { this.ready = false; };
      dc.onmessage = ({ data }) => {
        if (typeof data === 'string') {
          const m = JSON.parse(data);
          if (m.t === 'have') m.l.forEach(i => this.have.add(i));
          if (m.t === 'want' && this.onWant) this.onWant(this, m.i);
        } else {
          const idx = new DataView(data).getUint32(0);
          const p   = this._reqs.get(idx);
          if (p) { clearTimeout(p.timer); this._reqs.delete(idx); p.res(data.slice(4)); }
        }
      };
    }

    request(idx) {
      return new Promise((res, rej) => {
        if (!this.ready || this.dc?.readyState !== 'open') return rej(new Error('not open'));
        const timer = setTimeout(() => { this._reqs.delete(idx); rej(new Error('timeout')); }, REQ_TIMEOUT);
        this._reqs.set(idx, { res, rej, timer });
        this.dc.send(JSON.stringify({ t: 'want', i: idx }));
      });
    }

    serve(idx, buf) {
      if (!this.ready || this.dc?.readyState !== 'open') return;
      const out = new Uint8Array(4 + buf.byteLength);
      new DataView(out.buffer).setUint32(0, idx);
      out.set(new Uint8Array(buf), 4);
      this.dc.send(out.buffer);
    }

    announce(list) {
      if (!this.ready || this.dc?.readyState !== 'open') return;
      this.dc.send(JSON.stringify({ t: 'have', l: list }));
    }
  }

  // ── Swarm (signaling + peer connections) ─────────────────────────────────
  class Swarm {
    constructor(token, mem) {
      this.token  = token;
      this.mem    = mem;
      this.peers  = new Map();
      this.myId   = null;
      this._ws    = null;
      this._alive = true;
    }

    connect() {
      if (!this._alive) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this._ws = new WebSocket(`${proto}://${location.host}/p2p`);
      this._ws.onopen    = () => this._send({ type: 'join', token: this.token });
      this._ws.onmessage = e  => { try { this._onMsg(JSON.parse(e.data)); } catch {} };
      this._ws.onerror   = () => {};
      this._ws.onclose   = () => {};
    }

    _send(m) { this._ws?.readyState === 1 && this._ws.send(JSON.stringify(m)); }
    _sig(to, data) { this._send({ type: 'signal', to, data }); }

    async _onMsg(m) {
      if (!this._alive) return;
      switch (m.type) {
        case 'ready':
          this.myId = m.peerId;
          break;
        case 'peers':
          for (const id of m.peers.slice(0, MAX_PEERS)) await this._mkPeer(id, true);
          break;
        case 'peer-join':
          if (this.peers.size < MAX_PEERS) await this._mkPeer(m.peerId, false);
          break;
        case 'peer-leave': {
          const p = this.peers.get(m.peerId);
          if (p) { try { p.pc.close(); } catch {} this.peers.delete(m.peerId); }
          break;
        }
        case 'signal': {
          let p = this.peers.get(m.from);
          if (!p && this.peers.size < MAX_PEERS) p = await this._mkPeer(m.from, false);
          if (!p) break;
          const d = m.data;
          if (d.type === 'offer') {
            await p.pc.setRemoteDescription(d);
            const ans = await p.pc.createAnswer();
            await p.pc.setLocalDescription(ans);
            this._sig(m.from, ans);
          } else if (d.type === 'answer') {
            await p.pc.setRemoteDescription(d);
          } else if (d.type === 'ice') {
            await p.pc.addIceCandidate(d.candidate).catch(() => {});
          }
          break;
        }
      }
    }

    async _mkPeer(id, initiator) {
      const p = new Peer(id, data => this._sig(id, data));
      p.onWant = (peer, idx) => {
        const b = this.mem.get(idx);
        if (b) peer.serve(idx, b);
      };
      this.peers.set(id, p);

      if (initiator) {
        const dc = p.pc.createDataChannel('ab');
        p.attach(dc);
        dc.onopen = () => { const h = this.mem.keys(); if (h.length) p.announce(h); };
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        this._sig(id, offer);
      } else {
        p.pc.ondatachannel = e => {
          p.attach(e.channel);
          e.channel.onopen = () => { const h = this.mem.keys(); if (h.length) p.announce(h); };
        };
      }
      return p;
    }

    async fromPeers(idx) {
      for (const p of this.peers.values()) {
        if (p.have.has(idx) && p.ready) {
          try { return await p.request(idx); } catch {}
        }
      }
      return null;
    }

    announce(idx) {
      this.peers.forEach(p => { if (p.ready) p.announce([idx]); });
    }

    close() {
      this._alive = false;
      this.peers.forEach(p => { try { p.pc.close(); } catch {} });
      this.peers.clear();
      this._ws?.close();
    }
  }

  // ── Loader (mem cache → peers → HTTP) ────────────────────────────────────
  class Loader {
    constructor(token) {
      this.token  = token;
      this.mem    = new MemStore();
      this.swarm  = null;
      this.size   = 0;
      this.total  = 0;
      this._abort = false;
    }

    async init() {
      try {
        const r = await fetch(`/stream/${this.token}`, { method: 'HEAD' });
        this.size  = parseInt(r.headers.get('content-length') || '0');
        this.total = Math.ceil(this.size / CHUNK);
        if (!this.size) return false;
      } catch { return false; }

      if (window.AB_WEBRTC !== false && typeof RTCPeerConnection !== 'undefined') {
        this.swarm = new Swarm(this.token, this.mem);
        try { this.swarm.connect(); } catch {}
      }
      return true;
    }

    async get(idx) {
      if (this._abort) throw new Error('aborted');

      // 1. Memory
      if (this.mem.has(idx)) return this.mem.get(idx);

      // 2. IndexedDB
      const cached = await idbGet(`${this.token}:${idx}`);
      if (cached) { this.mem.set(idx, cached); return cached; }

      // 3. Peers
      if (this.swarm) {
        const fromP = await this.swarm.fromPeers(idx);
        if (fromP) { this.mem.set(idx, fromP); return fromP; }
      }

      // 4. HTTP
      const start = idx * CHUNK;
      const end   = Math.min(start + CHUNK - 1, this.size - 1);
      const r   = await fetch(`/stream/${this.token}`, { headers: { Range: `bytes=${start}-${end}` } });
      const buf = await r.arrayBuffer();
      this.mem.set(idx, buf);
      idbSet(`${this.token}:${idx}`, buf); // persist async
      this.swarm?.announce(idx);
      return buf;
    }

    abort() {
      this._abort = true;
      this.swarm?.close();
    }
  }

  // ── P2PAudio public API ───────────────────────────────────────────────────
  let _current = null; // { token, loader }

  async function load(token, audioEl) {
    // Abort previous background loader
    if (_current && _current.token !== token) {
      _current.loader.abort();
      _current = null;
    }

    // Check if fully cached in IDB → instant Blob URL play
    try {
      const loader = new Loader(token);
      const headOk = await loader.init();
      if (headOk && loader.total > 0) {
        const allChunks = await idbGetAll(token);
        if (allChunks.length >= loader.total) {
          // Reconstruct Blob from ordered chunks
          const ordered = [];
          for (let i = 0; i < loader.total; i++) {
            const b = await idbGet(`${token}:${i}`);
            if (!b) { ordered.length = 0; break; }
            ordered.push(b);
          }
          if (ordered.length === loader.total) {
            const blob = new Blob(ordered, { type: 'audio/mpeg' });
            audioEl.src = URL.createObjectURL(blob);
            audioEl.load();
            loader.abort();
            // Still connect to swarm to serve peers
            const servLoader = new Loader(token);
            await servLoader.init();
            // Pre-fill memory from IDB
            for (let i = 0; i < servLoader.total; i++) {
              const b = await idbGet(`${token}:${i}`);
              if (b) servLoader.mem.set(i, b);
            }
            _current = { token, loader: servLoader };
            return;
          }
        }

        // Not fully cached: HTTP stream + background P2P download
        audioEl.src = `/stream/${token}`;
        audioEl.load();
        _current = { token, loader };
        _bgDownload(loader).catch(() => {});
        return;
      }
    } catch {}

    // Total fallback
    audioEl.src = `/stream/${token}`;
    audioEl.load();
  }

  async function _bgDownload(loader) {
    for (let i = 0; i < loader.total; i++) {
      try { await loader.get(i); } catch { break; }
    }
  }

  window.P2PAudio = { load };

})();
