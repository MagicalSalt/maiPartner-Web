'use strict';

// maipartner.js — Lightweight embeddable maimai FiNALE partner widget

const FRAME_MS = 1000 / 60;

const CHAR_SCENES = {
    ras:     'assets/scenes/ras.json',
    chiffon: 'assets/scenes/chiffon.json',
    salt:    'assets/scenes/salt.json',
    otohime: 'assets/scenes/otohime.json',
    shama:   'assets/scenes/shama.json',
    milk:    'assets/scenes/milk.json',
};

const BODY_FRAC = {
    shama: 0.75, milk: 0.75, otohime: 0.78, ras: 0.85, chiffon: 0.83, salt: 0.85,
};

const CHAR_HEIGHT_CM = {
    shama: 157, milk: 157, otohime: 152, ras: 158, chiffon: 160, salt: 142,
};

// Precomputed: max(bodyCm * envW / (envH * bodyFrac)) across all characters (shama)
const BODY_SCALE_REF = 153.24;

// ---------------------------------------------------------------------------
// Animation engine
// ---------------------------------------------------------------------------

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function evalTrack(track, frame) {
    const keys = track.k;
    if (!keys || !keys.length) return undefined;
    if (keys.length === 1) return keys[0][1];
    if (frame <= keys[0][0]) return keys[0][1];
    if (frame >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
    const interp = track.t & 0xF;
    for (let i = 0; i < keys.length - 1; i++) {
        const k0 = keys[i], k1 = keys[i + 1];
        if (frame >= k0[0] && frame < k1[0]) {
            if (interp === 0) return k0[1];
            const span = k1[0] - k0[0];
            if (span <= 0) return k0[1];
            const t = (frame - k0[0]) / span;
            if (interp === 3) {
                if (k0.length >= 5 && k1.length >= 5) {
                    const p0 = k0[1], p1 = k1[1];
                    const m0 = k0[4] * span, m1 = k1[3] * span;
                    const t2 = t * t, t3 = t2 * t;
                    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0
                         + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
                }
                const s = t * t * (3 - 2 * t);
                return lerp(k0[1], k1[1], s);
            }
            return lerp(k0[1], k1[1], t);
        }
    }
    return keys[keys.length - 1][1];
}

class ScenePlayer {
    constructor(sceneData, images) {
        this.scene = sceneData;
        this.images = images;
        this.frame = 0;
        this.active = [];
        this.baseAnims = [];
        this.nodes = sceneData.nodes.map(n => ({ ...n }));
        for (const anim of Object.values(sceneData.animations)) {
            for (const mot of anim.m) {
                let maxF = 0;
                for (const trk of mot.tr)
                    for (const k of trk.k)
                        if (k[0] > maxF) maxF = k[0];
                mot._period = maxF || 0;
            }
        }
    }

    resetNodes() {
        for (const n of this.nodes) {
            n._x = n.x; n._y = n.y;
            n._r = -(n.r * Math.PI / 32768);
            n._sx = n.sx; n._sy = n.sy;
            n._hidden = !n.v; n._a = n.a;
            n._pat = n._patBase ?? 0;
            n._cropW = undefined; n._cropH = undefined;
            n._cr = 1; n._cg = 1; n._cb = 1;
        }
    }

    applyTrack(node, trk, f) {
        const isDiscrete = trk.p === 11 || trk.p === 18;
        const v = evalTrack(isDiscrete ? { ...trk, t: trk.t & ~0xF } : trk, f);
        if (v === undefined) return;
        switch (trk.p) {
            case 0: node._x = v; break;
            case 1: node._y = v; break;
            case 5: node._r = -(v * Math.PI / 32768); break;
            case 6: node._sx = v; break;
            case 7: node._sy = v; break;
            case 11: node._hidden = !v; break;
            case 12: node._cropW = v; break;
            case 13: node._cropH = v; break;
            case 18: node._pat = v; break;
            case 21: node._cr = v; break;
            case 22: node._cg = v; break;
            case 23: node._cb = v; break;
            case 24: node._a = v; break;
        }
    }

    applyAnim(name, frame, forceLoop) {
        const anim = this.scene.animations[name];
        if (!anim) return;
        for (const mot of anim.m) {
            const node = this.nodes[mot.n];
            if (!node) continue;
            const loop = forceLoop || !!anim.l;
            const mf = loop && mot._period ? frame % mot._period : frame;
            for (const trk of mot.tr) this.applyTrack(node, trk, mf);
        }
    }

    play(name, opts = {}) {
        const anim = this.scene.animations[name];
        if (!anim) return null;
        const entry = {
            name, frame: 0,
            loop: opts.loop ?? !!anim.l,
            hold: opts.hold ?? false,
            ended: false,
            endFrame: Math.max(1, Number(anim.d) || 1),
            onEnd: opts.onEnd || null,
        };
        this.active.push(entry);
        return entry;
    }

    stopAnim(name) { this.active = this.active.filter(e => e.name !== name); }
    clearAll() { this.active = []; }
    clearByPrefix(prefix) { this.active = this.active.filter(e => !e.name.startsWith(prefix)); }

    tick() {
        this.resetNodes();
        for (const b of this.baseAnims) this.applyAnim(b.name, b.frame, false);
        for (const e of this.active) this.applyAnim(e.name, e.frame, e.loop);
        const callbacks = [];
        for (const e of this.active) {
            e.frame++;
            if (!e.loop && e.frame >= e.endFrame) {
                e.ended = true;
                if (e.onEnd) callbacks.push(e.onEnd);
            }
        }
        this.active = this.active.filter(e => !e.ended || e.hold);
        this.frame++;
        for (const cb of callbacks) cb();
    }

    drawNode(ctx, idx, parentAlpha, parentHidden) {
        const node = this.nodes[idx];
        if (!node) return;
        const hidden = node._hidden || parentHidden;
        const alpha = Math.max(0, Math.min(1, node._a ?? 1)) * parentAlpha;
        ctx.save();
        ctx.translate(node._x, node._y);
        if (node._r) ctx.rotate(node._r);
        if (node._sx !== 1 || node._sy !== 1) ctx.scale(node._sx, node._sy);
        if (node._cr < 0.999 || node._cg < 0.999 || node._cb < 0.999)
            ctx.filter = `brightness(${(node._cr + node._cg + node._cb) / 3})`;
        if (!hidden && node.s && alpha > 0.003) {
            const spr = node.s;
            const layer = (spr.layers || []).length > 1
                ? spr.layers[Math.round(node._pat || 0)]
                : (spr.layers || [])[0];
            if (layer) {
                const tex = this.scene.textures[layer.ti];
                const img = this.images[layer.ti];
                if (tex && img) {
                    const crop = tex.crops[layer.ci];
                    if (crop) {
                        let sx = crop[0], sy = crop[1];
                        let sw = crop[2] - crop[0], sh = crop[3] - crop[1];
                        let dw = spr.w, dh = spr.h;
                        if (node._cropW !== undefined) { sw = node._cropW; dw = node._cropW; }
                        if (node._cropH !== undefined) { sh = node._cropH; dh = node._cropH; }
                        if (sw > 0 && sh > 0) {
                            ctx.globalAlpha = alpha;
                            const key = layer.ti * 10000 + layer.ci;
                            const iso = this.cropImages?.get(key);
                            const pad = this.cropPads?.get(key) || 0;
                            const src = iso || img, csx = iso ? pad : sx, csy = iso ? pad : sy;
                            if (spr.fx) {
                                ctx.save(); ctx.scale(-1, 1);
                                ctx.drawImage(src, csx, csy, sw, sh, spr.px - dw, -spr.py, dw, dh);
                                ctx.restore();
                            } else {
                                ctx.drawImage(src, csx, csy, sw, sh, -spr.px, -spr.py, dw, dh);
                            }
                        }
                    }
                }
            }
        }
        for (const ci of node.ch) this.drawNode(ctx, ci, alpha, hidden);
        ctx.restore();
    }

    render(ctx, tx, ty, scale) {
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(scale, scale);
        this.drawNode(ctx, 0, 1);
        ctx.restore();
    }
}

// ---------------------------------------------------------------------------
// Scene loader
// ---------------------------------------------------------------------------

function loadImage(path) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load: ' + path));
        img.src = path;
    });
}

async function loadScene(basePath, scenePath) {
    const url = basePath + '/' + scenePath;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to load scene ${url}: ${r.status}`);
    const scene = await r.json();

    for (const tex of (scene.textures || [])) {
        const crops = tex?.crops;
        if (!Array.isArray(crops)) continue;
        if (!crops.some(c => c?.length >= 4 && (c[0] === 0 || c[1] === 0))) continue;
        for (const c of crops) { if (c?.length >= 4) { c[0]++; c[1]++; c[2]++; c[3]++; } }
    }

    const images = [];
    const cropImages = new Map(), cropPads = new Map();
    for (let ti = 0; ti < scene.textures.length; ti++) {
        const tex = scene.textures[ti];
        const img = await loadImage(basePath + '/' + tex.file);
        images.push(img);
        for (let ci = 0; ci < tex.crops.length; ci++) {
            const crop = tex.crops[ci];
            if (!crop || crop.length < 4) continue;
            const sw = crop[2] - crop[0], sh = crop[3] - crop[1];
            if (sw <= 0 || sh <= 0) continue;
            const cv = document.createElement('canvas');
            cv.width = sw + 2; cv.height = sh + 2;
            const dc = cv.getContext('2d'), cx = crop[0], cy = crop[1];
            dc.drawImage(img, cx, cy, sw, sh, 1, 1, sw, sh);
            dc.drawImage(img, cx, cy, sw, 1, 1, 0, sw, 1);
            dc.drawImage(img, cx, cy + sh - 1, sw, 1, 1, sh + 1, sw, 1);
            dc.drawImage(img, cx, cy, 1, sh, 0, 1, 1, sh);
            dc.drawImage(img, cx + sw - 1, cy, 1, sh, sw + 1, 1, 1, sh);
            dc.drawImage(img, cx, cy, 1, 1, 0, 0, 1, 1);
            dc.drawImage(img, cx + sw - 1, cy, 1, 1, sw + 1, 0, 1, 1);
            dc.drawImage(img, cx, cy + sh - 1, 1, 1, 0, sh + 1, 1, 1);
            dc.drawImage(img, cx + sw - 1, cy + sh - 1, 1, 1, sw + 1, sh + 1, 1, 1);
            const key = ti * 10000 + ci;
            cropImages.set(key, cv);
            cropPads.set(key, 1);
        }
    }
    const player = new ScenePlayer(scene, images);
    player.cropImages = cropImages;
    player.cropPads = cropPads;
    return player;
}

// ---------------------------------------------------------------------------
// Bounding box computation
// ---------------------------------------------------------------------------

function computeBounds(player) {
    const rects = [];
    const walk = (idx, ma, mb, mc, md, mtx, mty, hidden) => {
        const n = player.nodes[idx];
        if (!n || n._hidden || hidden) return;
        if ((n._a ?? n.a) < 0.01) return;
        const lx = n._x ?? n.x, ly = n._y ?? n.y;
        const lsx = n._sx ?? n.sx, lsy = n._sy ?? n.sy;
        const lr = n._r ?? n.r ?? 0;
        let na = ma, nb = mb, nc = mc, nd = md;
        let ntx = mtx + ma * lx + mc * ly, nty = mty + mb * lx + md * ly;
        if (lr) {
            const cos = Math.cos(lr), sin = Math.sin(lr);
            const ta = na * cos + nc * sin, tb = nb * cos + nd * sin;
            const tc = nc * cos - na * sin, td = nd * cos - nb * sin;
            na = ta; nb = tb; nc = tc; nd = td;
        }
        na *= lsx; nb *= lsx; nc *= lsy; nd *= lsy;
        if (n.s && n.s.w * n.s.h > 5000) {
            const pts = [[-n.s.px, -n.s.py], [n.s.w - n.s.px, -n.s.py],
                         [n.s.w - n.s.px, n.s.h - n.s.py], [-n.s.px, n.s.h - n.s.py]];
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (const [cx, cy] of pts) {
                const px = ntx + na * cx + nc * cy, py = nty + nb * cx + nd * cy;
                x0 = Math.min(x0, px); x1 = Math.max(x1, px);
                y0 = Math.min(y0, py); y1 = Math.max(y1, py);
            }
            rects.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, area: (x1 - x0) * (y1 - y0) });
        }
        for (const ci of (n.ch || [])) walk(ci, na, nb, nc, nd, ntx, nty, hidden);
    };
    walk(0, 1, 0, 0, 1, 0, 0, false);
    if (!rects.length) return { cx: 540, cy: 540, w: 1080, h: 1080, minX: 0, maxX: 1080, minY: 0, maxY: 1080 };
    rects.sort((a, b) => b.area - a.area);
    let total = 0;
    for (const r of rects) total += r.area;
    let cum = 0, sumX = 0, sumY = 0, bodyArea = 0;
    for (const r of rects) {
        sumX += r.x * r.area; sumY += r.y * r.area; bodyArea += r.area;
        cum += r.area;
        if (cum >= total * 0.8) break;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of rects) {
        minX = Math.min(minX, r.x - r.w / 2); maxX = Math.max(maxX, r.x + r.w / 2);
        minY = Math.min(minY, r.y - r.h / 2); maxY = Math.max(maxY, r.y + r.h / 2);
    }
    return { cx: sumX / bodyArea, cy: sumY / bodyArea, w: maxX - minX, h: maxY - minY, minX, maxX, minY, maxY };
}

// ---------------------------------------------------------------------------
// PartnerWidget — public API
// ---------------------------------------------------------------------------

class PartnerWidget {
    constructor(options = {}) {
        this.character = options.character || 'salt';
        this.container = options.container || document.body;
        this.basePath = options.basePath || '.';
        this.costume = options.costume ?? 0;
        this.width = options.width ?? 300;
        this.clickable = options.clickable !== false;
        this.autoStart = options.autoStart !== false;
        this.background = options.background ?? 'transparent';

        this.player = null;
        this.canvas = null;
        this.ctx = null;
        this.height = 0;
        this.dpr = 1;
        this.bounds = null;
        this._raf = 0;
        this._lastTs = 0;
        this._accum = 0;
        this._touching = false;
    }

    async init() {
        const scenePath = CHAR_SCENES[this.character];
        if (!scenePath) throw new Error(`Unknown character: ${this.character}`);
        this.player = await loadScene(this.basePath, scenePath);
        this._applyPatches();
        this._setupBaseAnims();
        this._measureBounds();
        this._createCanvas();
        this._startIdle();
        if (this.autoStart) this.start();
        return this;
    }

    _applyPatches() {
        const p = this.player;
        const fx = p.scene.animations['Effect_Heart1'];
        if (fx)
            for (const mot of fx.m)
                for (const trk of mot.tr)
                    if (trk.p === 11 && p.nodes[mot.n]?.v === 1) p.nodes[mot.n].v = 0;
        const cf = p.scene.animations['Change_Fashion'];
        if (cf)
            for (const mot of cf.m)
                for (const trk of mot.tr)
                    if (trk.p === 24 && trk.k.length && trk.k.every(k => k[1] === 0))
                        if (p.nodes[mot.n]) p.nodes[mot.n].a = 0;
        if (this.character === 'milk') {
            for (const idx of [60, 142])
                if (p.nodes[idx]) p.nodes[idx]._milkHide = true;
            for (const n of p.nodes)
                if (['Leg_R_2_Under', 'Leg_L_2_Under', '02_Leg_L_2_Under'].includes(n._name))
                    n._milkHide = true;
            const happy = p.scene.animations['Action_Happy1'];
            if (happy && !happy.m.some(m => m.n === 291))
                happy.m.push({ n: 291, tr: [{ p: 24, t: 0, k: [[0, 0]] }] });
        }
    }

    _setupBaseAnims() {
        const p = this.player;
        p.baseAnims = [];
        if (p.scene.animations['Change_Fashion'])
            p.baseAnims.push({ name: 'Change_Fashion', frame: this.costume });
        if (p.scene.animations['Change_Position'])
            p.baseAnims.push({ name: 'Change_Position', frame: 0 });
        if (p.scene.animations['Change_Accessory']) {
            const frames = Math.max(1, Number(p.scene.animations['Change_Accessory'].d) || 1);
            p.baseAnims.push({ name: 'Change_Accessory', frame: this.costume % frames });
        }
        p.resetNodes();
        for (const b of p.baseAnims) p.applyAnim(b.name, b.frame, false);
    }

    _measureBounds() {
        const p = this.player;
        const cfAnim = p.scene.animations['Change_Fashion'];
        const n = cfAnim ? Math.max(1, cfAnim.d) : 1;
        let eMinX = Infinity, eMaxX = -Infinity, eMinY = Infinity, eMaxY = -Infinity;
        for (let f = 0; f < n; f++) {
            p.resetNodes();
            if (cfAnim) p.applyAnim('Change_Fashion', f, false);
            if (p.scene.animations['Change_Accessory']) {
                const fr = Math.max(1, Number(p.scene.animations['Change_Accessory'].d) || 1);
                p.applyAnim('Change_Accessory', f % fr, false);
            }
            if (p.scene.animations['Change_Position']) p.applyAnim('Change_Position', 0, false);
            if (this.character === 'milk') this._enforceMilkLegMask();
            const bb = computeBounds(p);
            eMinX = Math.min(eMinX, bb.minX); eMaxX = Math.max(eMaxX, bb.maxX);
            eMinY = Math.min(eMinY, bb.minY); eMaxY = Math.max(eMaxY, bb.maxY);
        }
        const bodyFrac = BODY_FRAC[this.character] || 0.85;
        const bodyCm = CHAR_HEIGHT_CM[this.character] || 155;
        this.bounds = {
            envW: eMaxX - eMinX, envH: eMaxY - eMinY,
            envMinX: eMinX, envMaxX: eMaxX, envMinY: eMinY, envMaxY: eMaxY,
            bodyH: (eMaxY - eMinY) * bodyFrac, feetY: eMaxY,
            centerX: (eMinX + eMaxX) / 2,
        };
        this.renderScale = (this.width * 0.95 * bodyCm) / (BODY_SCALE_REF * this.bounds.envH * bodyFrac);
        this.height = Math.ceil(this.bounds.envH * this.renderScale * 1.1);
    }

    _enforceMilkLegMask() {
        for (const n of this.player.nodes) if (n._milkHide) n._hidden = true;
    }

    _createCanvas() {
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width * this.dpr;
        this.canvas.height = this.height * this.dpr;
        this.canvas.style.cssText = `display:none;width:${this.width}px;height:${this.height}px;background:${this.background}`;
        if (this.clickable) this.canvas.style.cursor = 'pointer';
        this.ctx = this.canvas.getContext('2d');
        if (this.clickable)
            this.canvas.addEventListener('pointerdown', () => this._onTap());
    }

    _startIdle() {
        this.player.clearAll();
        this.player.play('Action_Wait1', { loop: true });
    }

    _onTap() {
        if (this._touching) return;
        this._touching = true;
        const p = this.player;
        p.clearByPrefix('Action_Touch'); p.clearByPrefix('Mouth_Touch');
        if (p.scene.animations['Action_Touch1'])
            p.play('Action_Touch1', { loop: false, onEnd: () => { this._touching = false; } });
        else this._touching = false;
        if (p.scene.animations['Mouth_Touch1'])
            p.play('Mouth_Touch1', { loop: false });
    }

    _tick() {
        if (this.character === 'milk') this._enforceMilkLegMask();
        this.player.tick();
        if (this.character === 'milk') this._enforceMilkLegMask();
    }

    _render() {
        const ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const b = this.bounds;
        const scale = this.renderScale * this.dpr;
        const tx = cw / 2 - b.centerX * scale;
        const ty = ch * 0.975 - b.feetY * scale;
        this.player.render(ctx, tx, ty, scale);
    }

    start() {
        if (this._raf) return;
        if (!this.canvas.parentNode) this.container.appendChild(this.canvas);
        this._tick();
        this._render();
        this.canvas.style.display = 'block';
        this._lastTs = performance.now();
        this._accum = 0;
        const loop = (ts) => {
            this._raf = requestAnimationFrame(loop);
            const dt = Math.min(ts - this._lastTs, 100);
            this._lastTs = ts;
            this._accum += dt;
            while (this._accum >= FRAME_MS) { this._tick(); this._accum -= FRAME_MS; }
            this._render();
        };
        this._raf = requestAnimationFrame(loop);
    }

    stop() {
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    }

    setCostume(index) {
        this.costume = index;
        const cf = this.player.baseAnims.find(b => b.name === 'Change_Fashion');
        if (cf) {
            const max = this.player.scene.animations['Change_Fashion']?.d || 1;
            cf.frame = ((index % max) + max) % max;
        }
        const ca = this.player.baseAnims.find(b => b.name === 'Change_Accessory');
        if (ca) {
            const fr = Math.max(1, Number(this.player.scene.animations['Change_Accessory']?.d) || 1);
            ca.frame = ((index % fr) + fr) % fr;
        }
    }

    get numCostumes() {
        return Math.max(1, this.player?.scene?.animations?.['Change_Fashion']?.d || 1);
    }

    resize(width) {
        this.width = width;
        const bodyCm = CHAR_HEIGHT_CM[this.character] || 155;
        const bodyFrac = BODY_FRAC[this.character] || 0.85;
        this.renderScale = (width * 0.95 * bodyCm) / (BODY_SCALE_REF * this.bounds.envH * bodyFrac);
        this.height = Math.ceil(this.bounds.envH * this.renderScale * 1.1);
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = this.width * this.dpr;
        this.canvas.height = this.height * this.dpr;
        this.canvas.style.width = this.width + 'px';
        this.canvas.style.height = this.height + 'px';
    }

    destroy() {
        this.stop();
        this.canvas?.parentNode?.removeChild(this.canvas);
        this.canvas = null; this.ctx = null; this.player = null;
    }
}

export default PartnerWidget;
export { PartnerWidget, CHAR_SCENES };
