// ==UserScript==
// @name         自动阅读 linux.do 论坛
// @namespace    https://github.com/auto-read-linuxDo
// @version      6.1.0
// @description  自动滚动阅读 linux.do 未读帖子，自动点赞，按论坛已读标记统计进度。滚动由计时器驱动、节奏随机化（防固定频率识别），窗口失焦也不暂停。面板使用 Shadow DOM 隔离，不依赖任何外部 CDN。
// @author       OuOumm
// @match        https://linux.do/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @homepageURL  https://github.com/OuOumm/autoRead-linuxDo
// @supportURL   https://github.com/OuOumm/autoRead-linuxDo/issues
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '6.1.0';

    const DEFAULTS = {
        likeLimit: 30, maxRetries: 3,
        scrollSpeed: 1, scrollInterval: 16, noProgressGraceMs: 3000,
        likeIntervalMin: 2000, likeIntervalMax: 5000, waitTimeout: 8000,
        likeCooldownBufferMs: 30 * 60 * 1000,   // 上限解除后再多等 30 分钟才恢复点赞
        // 滚动随机化：固定节奏容易被识别，这里让间隔与步长在基准值附近浮动
        scrollJitter: 0.35,        // 间隔随机幅度（0.35 = ±35%）
        speedJitter: 0.5,          // 步长随机幅度（0.5 = ±50%）
        pauseChance: 0.04,         // 每拍随机停顿的概率
        pauseMsMin: 300,           // 停顿最短毫秒
        pauseMsMax: 1500,          // 停顿最长毫秒
        readKeyLimit: 2000, unseenLimit: 300,
        updateInterval: 500, saveThrottle: 2000,
        panelCollapsed: false, baseUrl: 'https://linux.do',
    };

    const SEL = {
        unseenLink: 'a.title.raw-link.raw-topic-link',
        post: 'article[data-post-id]',
        readState: '.read-state',
        likeButton: 'button.like-button, button.like, button[title="点赞此帖子"]',
        cooked: '.cooked',
        topicTitle: '#topic-title .fancy-title, .title-wrapper .fancy-title',
        errorMarker: '#main-outlet .not-found, .page-not-found',
        selfLink: '[data-link-name="my-messages"], #current-user a[href^="/u/"]',
        postAuthor: 'article[data-post-id] .topic-meta-data .names a[href^="/u/"]',
        timeline: '.timeline-replies',
        // 点赞达到当日上限时论坛弹的提示框
        likeLimitDialog: '#dialog-holder, .dialog-container',
    };

    const KEYS = { state: 'autoReadStateV6', settings: 'autoReadSettingsV6' };

    // 设置面板的数值字段：markup 与保存时的钳制都从这张表生成，避免两处写死不同步
    const SET_FIELDS = [
        { key: 'likeLimit',      id: 'setLike',     label: '每日点赞上限',       min: 0,  max: 500,   step: 1 },
        { key: 'maxRetries',     id: 'setRetry',    label: '错误重试次数',       min: 0,  max: 10,    step: 1 },
        { key: 'scrollSpeed',    id: 'setSpeed',    label: '滚动步长（像素/帧）', min: 1,  max: 200,   step: 1 },
        { key: 'scrollInterval', id: 'setInterval', label: '滚动间隔（毫秒/帧）', min: 8,  max: 10000, step: 8 },
    ];

    /* ---------------- 工具 ---------------- */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const randomBetween = (min, max) => Math.round(min + Math.random() * (max - min));
    // 在基准值附近浮动：±ratio，返回浮点数
    const jitter = (base, ratio) => {
        const r = Math.max(0, Math.min(1, Number(ratio) || 0));
        return base * (1 - r + Math.random() * r * 2);
    };

    // 毫秒 → 「1小时23分」，用于显示点赞冷却剩余
    const fmtHours = (ms) => {
        const total = Math.max(0, Math.round(Number(ms) / 60000));
        const h = Math.floor(total / 60), m = total % 60;
        return h > 0 ? `${h}小时${m}分` : `${m}分`;
    };
    // 读设置里的数值并钳到安全区间；非法值退回 fallback
    const clampSetting = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const LIKE_CONFIRM_MS = 1500;
    const isLiked = (b) => !!b && (b.classList.contains('has-like') || b.getAttribute('aria-pressed') === 'true');
    const likeKey = (b) => (b && b.closest && b.closest('[data-post-id]')?.getAttribute('data-post-id')) || (b && b.id) || 'unknown';

    const textOf = (el, max = 0) => {
        const t = (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
        return max > 0 ? t.slice(0, max) : t;
    };

    // 进度条「当前楼层 / 总楼层」；单楼帖不渲染它 → 返回 null
    function topicProgress() {
        const el = document.querySelector(SEL.timeline);
        if (!el) return null;
        const m = String(el.textContent || '').replace(/\s+/g, '').match(/(\d+)\/(\d+)/);
        if (!m || !Number(m[2])) return null;
        const current = Number(m[1]), total = Number(m[2]);
        return { current, total, done: current >= total };
    }

    async function waitFor(pred, timeout) {
        const end = Date.now() + timeout;
        do { if (pred()) return true; await sleep(120); } while (Date.now() < end);
        return false;
    }

    const setToggle = (btn, on, onText, offText) => {
        btn.textContent = on ? onText : offText;
        btn.setAttribute('aria-pressed', String(!!on));
    };

    const escapeAttr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    /* ---------------- 存储 ---------------- */
    const GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function readRaw(key, fallback) {
        try {
            if (GM) { const v = GM_getValue(key, null); return v === null || v === undefined ? fallback : v; }
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
    }
    function writeRaw(key, value) {
        try { if (GM) GM_setValue(key, value); else localStorage.setItem(key, JSON.stringify(value)); }
        catch (e) { /* 写盘失败不影响运行 */ }
    }

    const todayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const usernameFromHref = (h) => { const m = String(h || '').match(/^\/u\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]).toLowerCase() : ''; };
    const selfUsername = () => usernameFromHref(document.querySelector(SEL.selfLink)?.getAttribute('href'));

    const defaultState = () => ({
        isReading: false, isPaused: false, isLiking: false,
        unseenHrefs: [], errorRetries: 0,
        likeCount: 0, likeDateKey: todayKey(),
        readPostIds: [], postsReadCount: 0, readDateKey: todayKey(), readCountToday: 0,
        // 论坛点赞上限的解除时间戳（0 = 未受限）
        likeCooldownUntil: 0,
        // 是否由冷却结束自动恢复点赞；用户手动关闭点赞时置 false，避免"关不掉"
        likeAutoResume: false,
    });

    class Store {
        constructor() {
            this.settings = Object.assign({}, DEFAULTS, readRaw(KEYS.settings, {}));
            this.state = Object.assign(defaultState(), readRaw(KEYS.state, {}));
            this._timer = null;
            this._saved = '';
        }

        updateSettings(patch) { Object.assign(this.settings, patch); writeRaw(KEYS.settings, this.settings); }

        // 三个按日计数共用：本地日期变化即归零
        _daily(countKey, dateKey) {
            if (this.state[dateKey] !== todayKey()) { this.state[dateKey] = todayKey(); this.state[countKey] = 0; }
            return this.state[countKey];
        }
        getLikeCount() { return this._daily('likeCount', 'likeDateKey'); }
        canLike() { return this.getLikeCount() < this.settings.likeLimit; }
        // 论坛侧上限（与本地配额不同）：没到期不许点
        likeCoolingDown() {
            const until = Number(this.state.likeCooldownUntil) || 0;
            return until > 0 && Date.now() < until;
        }
        // 记录论坛给的解除时间：小时数 + 缓冲（默认 30 分钟）
        setLikeCooldown(hours) {
            const h = Number(hours);
            if (!Number.isFinite(h) || h <= 0) return 0;
            const until = Date.now() + h * 3600 * 1000 + this.settings.likeCooldownBufferMs;
            this.state.likeCooldownUntil = until;
            this.save();
            return until;
        }
        getReadCountToday() { return this._daily('readCountToday', 'readDateKey'); }
        getReadCountTotal() { return this.state.postsReadCount || 0; }

        markPostRead(postId) {
            const id = String(postId || '');
            if (!id || this.state.readPostIds.includes(id)) return false;
            this.state.readPostIds.push(id);
            const limit = this.settings.readKeyLimit;
            if (this.state.readPostIds.length > limit) this.state.readPostIds.splice(0, this.state.readPostIds.length - limit);
            this.state.postsReadCount += 1;
            this.state.readCountToday = this.getReadCountToday() + 1;
            this.save();
            return true;
        }
        resetReadCount() {
            this.state.postsReadCount = 0; this.state.readCountToday = 0; this.state.readDateKey = todayKey();
            this.save();
        }
        // 点赞成功后计数
        recordLike() { this.state.likeCount = this.getLikeCount() + 1; this.save(); }

        save() { if (this._timer) return; this._timer = setTimeout(() => this.flush(), this.settings.saveThrottle); }
        flush() {
            if (this._timer) { clearTimeout(this._timer); this._timer = null; }
            const json = JSON.stringify(this.state);
            if (json === this._saved) return;
            this._saved = json;
            writeRaw(KEYS.state, this.state);
        }
    }

    /* ---------------- UI ---------------- */
    const STYLE = `
:host{
  /* all:initial 是面板能稳定显示的前提：不写它，论坛的全局样式（
     line-height、button 样式、display 等）会渗进来，把布局彻底冲掉。
     代价是 CSS 变量继承也会被切断，所以配色必须自带一套，
     再按论坛主题切深浅（见下面 [data-theme="dark"] 那条）。 */
  all:initial;
  --bg:#fff;--fg:#111;--soft:#f3f4f6;--line:#e5e7eb;--btn:#f9fafb;--btnline:#d1d5db;
  --ok:#16a34a;--bad:#dc2626;--warn:#d97706;--accent:#2563eb;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color-scheme:light dark;
}
:host([data-theme="dark"]){
  --bg:#1f2937;--fg:#f9fafb;--soft:#111827;--line:#4b5563;--btn:#374151;--btnline:#4b5563;--accent:#3b82f6;
}
*,*::before,*::after{box-sizing:border-box}

.ar-dock{position:fixed;top:50%;right:12px;transform:translateY(-50%);z-index:2147483000;display:flex;align-items:center;gap:6px}
.ar-panel{width:236px;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:12px;background:var(--bg);color:var(--fg);border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.18)}
.ar-panel[hidden],.ar-launcher[hidden]{display:none}
.ar-head{display:flex;align-items:center;gap:6px;padding:0 2px}
.ar-brand{font-size:13px;font-weight:700}
.ar-user{font-size:11px;opacity:.7;padding:0 2px;margin-top:-4px}
.ar-ver{font-size:10px;opacity:.45;margin-right:auto}
.ar-icon{appearance:none;width:22px;height:22px;padding:0;font-family:inherit;font-size:15px;line-height:1;cursor:pointer;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.55}
.ar-icon:hover{opacity:1;background:var(--soft)}
.ar-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ar-grid .span{grid-column:1/-1}
.ar-btn{appearance:none;font-family:inherit;border:1px solid var(--btnline);border-radius:8px;padding:7px 10px;font-size:12.5px;font-weight:600;line-height:1.2;cursor:pointer;background:var(--btn);color:var(--fg);white-space:nowrap}
.ar-btn:hover{background:var(--soft)}
.ar-btn[aria-pressed="true"]{background:#dbeafe;border-color:#3b82f6;color:#1d4ed8}
.ar-btn:disabled{opacity:.5;cursor:not-allowed}
.ar-btn.sm{padding:4px 8px;font-size:12px}
.ar-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.ar-btn.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
.ar-btn:focus-visible,.ar-icon:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ar-status{padding:8px 9px;border-radius:8px;background:var(--soft);font-size:11.5px;line-height:1.75}
.ar-ok{color:var(--ok);font-weight:700}.ar-bad{color:var(--bad);font-weight:700}.ar-warn{color:var(--warn);font-weight:700}
.ar-launcher{appearance:none;display:flex;align-items:center;gap:6px;padding:12px 7px;font-family:inherit;font-size:12px;font-weight:700;writing-mode:vertical-rl;letter-spacing:2px;cursor:pointer;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);box-shadow:0 6px 18px rgba(0,0,0,.16);opacity:.92}
.ar-launcher:hover{opacity:1}
.ar-dot{width:8px;height:8px;border-radius:50%;background:#cbd5e1;flex:none}
.ar-dot.run{background:var(--ok);box-shadow:0 0 0 3px rgba(22,163,74,.18);animation:arpulse 1.8s ease-in-out infinite}
.ar-dot.pause{background:var(--warn);box-shadow:0 0 0 3px rgba(217,119,6,.18)}
@keyframes arpulse{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.ar-dot.run{animation:none}}
.ar-toasts{position:fixed;top:16px;right:16px;z-index:2147483002;display:flex;flex-direction:column;gap:8px;max-width:320px}
.ar-toast{padding:9px 12px;border-radius:8px;font-size:13px;background:#111827;color:#f9fafb;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.ar-toast.ok{background:var(--ok)}.ar-toast.bad{background:var(--bad)}
.ar-modal{position:fixed;inset:0;z-index:2147483003;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
.ar-box{width:min(400px,92vw);max-height:86vh;overflow:auto;padding:18px;border-radius:12px;background:var(--bg);color:var(--fg);box-shadow:0 20px 60px rgba(0,0,0,.35)}
.ar-title{font-size:15px;font-weight:700;margin:0 auto 0 0}
.ar-text{font-size:13px;line-height:1.7;margin-bottom:12px}
.ar-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:12px}
.ar-field input{font-family:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--btnline);border-radius:6px;background:var(--bg);color:var(--fg)}
.ar-row{display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0 12px}
.ar-actions{display:flex;justify-content:flex-end;gap:8px}
.ar-actions .danger{margin-right:auto}
.ar-sect-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ar-sect-title{font-size:12px;font-weight:700;margin-right:auto}
.ar-hint{font-size:11px;line-height:1.6;opacity:.68}
`;

    class UI {
        constructor() { this.host = null; this.root = null; this._statusHtml = ''; }

        mount() {
            if (this.root) return this.root;
            const host = document.createElement('div');
            host.id = 'auto-read-ui-root';
            const root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = STYLE;
            const toasts = document.createElement('div');
            toasts.className = 'ar-toasts';
            root.append(style, toasts);
            document.body.appendChild(host);
            this.host = host; this.root = root; this.toasts = toasts;
            this.syncTheme();
            // 跟随站点主题：html.dark / data-theme 变化时重刷配色
            new MutationObserver(() => this.syncTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
            return root;
        }

        syncTheme() {
            const de = document.documentElement;
            const dark = de.classList.contains('dark') || /^dark/.test(de.getAttribute('data-theme') || '');
            this.host.setAttribute('data-theme', dark ? 'dark' : 'light');
        }

        buildPanel({ collapsed, handlers }) {
            const { read, pause, like, settings, collapse } = handlers;
            const root = this.mount();
            // 重建前先移除旧面板：残留同名 id 会让 querySelector 命中旧节点
            if (this.dock) this.dock.remove();
            const dock = document.createElement('div');
            dock.className = 'ar-dock';
            dock.innerHTML = `
                <div class="ar-panel" id="pan">
                    <div class="ar-head">
                        <span class="ar-brand">自动阅读</span>
                        <span class="ar-ver">v${VERSION}</span>
                        <button type="button" class="ar-icon" id="bHide" title="隐藏面板" aria-label="隐藏面板">×</button>
                    </div>
                    <div class="ar-user" id="user"></div>
                    <div class="ar-grid">
                        <button type="button" class="ar-btn span" id="bRead">开始阅读</button>
                        <button type="button" class="ar-btn" id="bPause">暂停</button>
                        <button type="button" class="ar-btn" id="bLike">启用点赞</button>
                        <button type="button" class="ar-btn span" id="bSet">设置</button>
                    </div>
                    <div class="ar-status" id="status" aria-live="polite"></div>
                </div>
                <button type="button" class="ar-launcher" id="bShow" title="显示面板" aria-label="显示自动阅读面板" hidden>
                    <span class="ar-dot" id="dot"></span><span>自动阅读</span>
                </button>`;
            root.appendChild(dock);
            this.dock = dock;
            const q = (id) => dock.querySelector('#' + id);
            this.panel = q('pan'); this.launcher = q('bShow'); this.dot = q('dot');
            this.status = q('status'); this.user = q('user');
            this.btnRead = q('bRead'); this.btnPause = q('bPause'); this.btnLike = q('bLike');
            q('bHide').onclick = () => { this.setCollapsed(true); collapse(true); };
            q('bShow').onclick = () => { this.setCollapsed(false); collapse(false); };
            this.btnRead.onclick = read; this.btnPause.onclick = pause;
            this.btnLike.onclick = like; q('bSet').onclick = settings;
            this.setCollapsed(!!collapsed);
        }

        setCollapsed(v) { this.panel.hidden = v; this.launcher.hidden = !v; }

        // 只在内容变化时重写 DOM，避免每 500ms 的无效重排
        renderStatus(m) {
            if (!this.status) return;
            if (this.user) this.user.textContent = m.selfName ? `当前用户：@${m.selfName}` : '当前用户：未检测到';
            this.dot.className = 'ar-dot' + (m.isReading ? (m.isPaused ? ' pause' : ' run') : '');
            this.launcher.title = m.isReading ? (m.isPaused ? '已暂停 · 点击展开' : '运行中 · 点击展开') : '已停止 · 点击展开';
            setToggle(this.btnRead, m.isReading, '停止阅读', '开始阅读');
            setToggle(this.btnLike, m.isLiking, '禁用点赞', '启用点赞');
            setToggle(this.btnPause, m.isPaused, '继续', '暂停');
            this.btnPause.disabled = !m.isReading;
            const html =
                `阅读：${m.isReading ? (m.isPaused ? '<span class="ar-warn">已暂停</span>' : '<span class="ar-ok">运行中</span>') : '<span class="ar-bad">已停止</span>'}<br>` +
                `点赞：${m.isLiking ? '<span class="ar-ok">启用</span>' : '<span class="ar-bad">禁用</span>'}（${m.likeCount}/${m.likeLimit}）` +
                (m.likeCoolingDown ? `<span class="ar-warn"> · 论坛上限 ${fmtHours(m.likeCooldownLeftMs)} 后恢复</span>` : '') + `<br>` +
                `已读帖子：<span class="ar-ok">${m.readCountToday}</span> 今日 / ${m.readCountTotal} 累计<br>` +
                `剩余帖子：${m.unseenCount}<br>` +
                `错误重试：<span class="ar-bad">${m.errorRetries}/${m.maxRetries}</span>`;
            if (html === this._statusHtml) return;
            this._statusHtml = html;
            this.status.innerHTML = html;
        }

        showSettings({ settings, readCountToday, readCountTotal, handlers }) {
            const { save, resetCount, close } = handlers;
            this.closeSettings();
            const modal = document.createElement('div');
            modal.className = 'ar-modal';
            modal.id = 'ar-settings';
            modal.innerHTML = `
                <div class="ar-box" style="width:min(440px,94vw)">
                    <div class="ar-title" style="margin-bottom:12px">设置</div>
                    ${SET_FIELDS.map((f) => `<label class="ar-field">${f.label}<input id="${f.id}" type="number" min="${f.min}" max="${f.max}" step="${f.step}" value="${settings[f.key]}"></label>`).join('\n                    ')}
                    <div class="ar-row">
                        <span id="setCount" style="flex:1">已读 ${readCountTotal} 篇（今日 ${readCountToday} 篇）</span>
                        <button type="button" class="ar-btn sm danger" id="setResetCount">清零</button>
                    </div>
                    <div class="ar-actions">
                        <button type="button" class="ar-btn sm" id="setCancel">取消</button>
                        <button type="button" class="ar-btn sm primary" id="setOk">保存</button>
                    </div>
                </div>`;
            this.mount().appendChild(modal);
            const q = (id) => modal.querySelector('#' + id);
            // 数值做安全区间钳制，防填出 0ms 停摆或超大步长
            const num = (id, min, max, fallback) => clampSetting(q(id).value, min, max, fallback);
            q('setResetCount').onclick = async () => {
                if (!(await this.confirm('确定把已读计数清零吗？已读去重记录会保留。'))) return;
                resetCount();
                q('setCount').textContent = '已读 0 篇（今日 0 篇）';
            };
            q('setCancel').onclick = close;
            q('setOk').onclick = () => save(
                SET_FIELDS.reduce((acc, f) => {
                    acc[f.key] = num(f.id, f.min, f.max, settings[f.key]);
                    return acc;
                }, {})
            );
        }

        closeSettings() { const el = this.root && this.root.getElementById('ar-settings'); if (el) el.remove(); }

        toast(message, kind = '') {
            this.mount();
            const t = document.createElement('div');
            t.className = ('ar-toast ' + kind).trim();
            t.textContent = message;
            this.toasts.appendChild(t);
            setTimeout(() => t.remove(), 4000);
        }

        confirm(message) {
            return new Promise((resolve) => {
                const modal = document.createElement('div');
                modal.className = 'ar-modal';
                modal.innerHTML = `<div class="ar-box"><div class="ar-text"></div><div class="ar-actions"><button type="button" class="ar-btn sm" data-v="0">取消</button><button type="button" class="ar-btn sm primary" data-v="1">确定</button></div></div>`;
                modal.querySelector('.ar-text').textContent = message;
                modal.querySelectorAll('button').forEach((b) => {
                    b.onclick = () => { modal.remove(); resolve(b.dataset.v === '1'); };
                });
                this.mount().appendChild(modal);
            });
        }
    }

    /* ---------------- 主流程 ---------------- */
    class Reader {
        constructor({ store, ui }) {
            this.store = store; this.ui = ui;
            // 滚动用计时器而非 rAF：rAF 与渲染帧绑定，失焦/切后台会被暂停
            this.scrollTimer = null;
            this._noProgressSince = 0;
            this._lastScanAt = 0;
            this.statusTimer = null;
            this._likeTried = new Set();
        }

        get state() { return this.store.state; }
        get settings() { return this.store.settings; }
        commit() { this.store.flush(); this.renderStatus(); }

        start() {
            this.ui.buildPanel({
                collapsed: !!this.settings.panelCollapsed,
                handlers: {
                    read: () => this.toggleReading(),
                    pause: () => this.togglePause(),
                    like: () => this.toggleLiking(),
                    settings: () => this.openSettings(),
                    collapse: (c) => this.store.updateSettings({ panelCollapsed: c }),
                },
            });
            this.renderStatus();
            this.statusTimer = setInterval(() => {
                this.resumeLikeIfReady();   // 冷却到期自动恢复点赞
                this.renderStatus();
            }, this.settings.updateInterval);
            window.addEventListener('pagehide', () => this.store.flush());
            if (document.readyState === 'complete') this.handleRoute();
            else window.addEventListener('load', () => this.handleRoute(), { once: true });
        }

        toggleReading() { if (this.state.isReading) this.stopReading(); else this.startReading(); }

        startReading() {
            this.state.isReading = true;
            this.state.isPaused = false;
            this.store.flush();
            this.handleRoute();
            if (this.isTopicPage()) this.startScrolling();
            else if (window.location.pathname !== '/unseen') this.navigateToUnseen();
            this.renderStatus();
        }

        stopReading() {
            this.state.isReading = false;
            this.state.isPaused = false;
            this.stopScrolling();
            this.commit();
        }

        // 暂停保留 isReading，只停滚动循环
        togglePause() {
            if (!this.state.isReading) return;
            this.state.isPaused = !this.state.isPaused;
            this.store.flush();
            if (this.state.isPaused) this.stopScrolling();
            else if (this.isTopicPage()) this.startScrolling();
            this.renderStatus();
        }

        toggleLiking() {
            this.state.isLiking = !this.state.isLiking;
            // 用户自己操作就以用户为准：关掉时取消自动恢复，打开时也不再等冷却
            this.state.likeAutoResume = false;
            this.commit();
            if (this.state.isLiking && this.state.isReading && this.isTopicPage()) this.autoLike();
        }

        isTopicPage() { return /^\/t\//.test(window.location.pathname); }

        handleRoute() {
            if (window.location.pathname === '/unseen' && this.state.isReading) this.collectUnseenLinks();
            else if (this.isTopicPage() && this.state.isReading) this.processTopic();
        }

        collectUnseenLinks() {
            const links = Array.from(document.querySelectorAll(SEL.unseenLink), (a) => a.getAttribute('href'))
                .filter(Boolean).slice(0, this.settings.unseenLimit);
            if (!links.length) {
                this.stopReading();
                this.ui.toast('未发现未读内容，已停止', '');
                return;
            }
            this.state.unseenHrefs = links;
            this.store.flush();
            this.openNextTopic();
        }

        // 推进游标的唯一出口。停止/暂停后必须原地不动：autoReply 与错误重试都会走到这里
        openNextTopic() {
            if (!this.state.isReading || this.state.isPaused) return;
            this.authorSeen = false;
            const next = this.state.unseenHrefs.shift();
            if (next) {
                this.store.flush();
                window.location.href = new URL(next, this.settings.baseUrl).href;
                return;
            }
            this.state.isReading = false;
            this.commit();
            this.ui.toast('所有未读已处理完毕', 'ok');
            this.navigateToUnseen();
        }

        navigateToUnseen() { window.location.href = `${this.settings.baseUrl}/unseen?ascending=false&order=activity`; }

        processTopic() {
            if (this.isErrorPage()) { this.handleErrorPage(); return; }
            if (!document.querySelector(SEL.post)) { this.openNextTopic(); return; }
            // 成功进帖：连续错误计数归零
            this.state.errorRetries = 0;
            this._likeTried = new Set();
            this.startScrolling();
            if (this.state.isLiking) this.autoLike();
        }

        /* 滚动阅读
           高频小步 + 时间补偿：默认 1px/16ms ≈ 60fps。
           刻意不用 rAF——rAF 与渲染帧绑定，失焦/被遮挡/切后台会被暂停。
           按真实经过时间补偿，后台降频时一帧补多帧距离，整体速度不变慢。 */
        startScrolling() {
            if (this.scrollTimer || !this.state.isReading || this.state.isPaused) return;
            this._noProgressSince = 0;
            this._lastScanAt = 0;
            // 基准值（配置）+ 每拍扰动。固定节奏过于规律，这里让间隔与步长
            // 在基准附近浮动，并偶发停顿，接近人手滚动的随机感。
            const baseInterval = () => clampSetting(this.settings.scrollInterval, 8, 10000, 16);
            const baseStep = () => clampSetting(this.settings.scrollSpeed, 1, 200, 1);
            const graceMs = () => clampSetting(this.settings.noProgressGraceMs, 1, 600000, 3000);
            let lastTs = 0;
            const tick = (ts) => {
                if (!this.state.isReading || this.state.isPaused) { this.stopScrolling(); return; }
                const now = ts || Date.now();
                const expect = baseInterval();
                const elapsed = lastTs ? Math.min(1000, now - lastTs) : expect;
                lastTs = now;
                const frames = Math.min(60, Math.max(0.5, elapsed / expect));
                // 步长每拍在 ±speedJitter 内浮动，再按经过时间补偿
                const px = jitter(baseStep(), this.settings.speedJitter) * frames;
                window.scrollBy(0, Math.max(1, Math.round(px)));
                // 高频滚动下不必每帧都扫：约 200ms 检查一次进度与已读即可
                if (!this._lastScanAt || now - this._lastScanAt >= 200) {
                    this._lastScanAt = now;
                    this.markReadPosts();
                    const progress = topicProgress();
                    if (progress) {
                        if (progress.done) { this.stopScrolling(); this.onReachBottom(); return; }
                        this._noProgressSince = 0;
                    } else {
                        // 单楼帖没有进度条：按真实时间给宽限，超时就跳下一篇
                        if (!this._noProgressSince) this._noProgressSince = now;
                        if (now - this._noProgressSince >= graceMs()) { this.stopScrolling(); this.onReachBottom(); return; }
                    }
                }
                // 间隔随机化；小概率插入一次较长停顿，模拟"看一会儿再往下滚"
                let delay = jitter(baseInterval(), this.settings.scrollJitter);
                const pc = Math.max(0, Math.min(1, Number(this.settings.pauseChance) || 0));
                if (pc > 0 && Math.random() < pc) {
                    const lo = clampSetting(this.settings.pauseMsMin, 1, 60000, 300);
                    const hi = Math.max(lo, clampSetting(this.settings.pauseMsMax, 1, 60000, 1500));
                    delay += randomBetween(lo, hi);
                }
                this.scrollTimer = setTimeout(() => tick(Date.now()), Math.max(8, Math.round(delay)));
            };
            this.scrollTimer = setTimeout(() => tick(Date.now()), baseInterval());
        }

        stopScrolling() { if (this.scrollTimer) { clearTimeout(this.scrollTimer); this.scrollTimer = null; } }

        async onReachBottom() {
            await sleep(randomBetween(600, 1500));
            if (!this.state.isReading || this.state.isPaused) return;
            this.openNextTopic();
        }

        // 已读统计以论坛的 .read-state.read 为唯一数据源，与滚动几何无关
        markReadPosts() {
            for (const post of document.querySelectorAll(SEL.post)) {
                const marker = post.querySelector(SEL.readState);
                if (marker && marker.classList.contains('read')) this.store.markPostRead(post.getAttribute('data-post-id'));
            }
        }

        // 只点未赞且本次没试过的；点完等服务端确认才记账，否则会误点成取消赞
        likeTargets() {
            return Array.from(document.querySelectorAll(SEL.likeButton)).filter((b) => !isLiked(b) && !this._likeTried.has(likeKey(b)));
        }

        async autoLike() {
            if (!this.state.isReading || !this.state.isLiking || this.state.isPaused) return;
            if (!this.store.canLike()) {
                this.state.isLiking = false; this.commit();
                this.ui.toast(`已达到每日点赞上限（${this.settings.likeLimit} 次），点赞已停止，阅读继续`, '');
                return;
            }
            const btn = this.likeTargets()[0];
            if (!btn) return;
            this._likeTried.add(likeKey(btn));
            btn.click();

            // 点完先看有没有弹「今日点赞已达上限」：弹了就说明这个赞没算上
            const limited = await this.handleLikeLimitDialog();
            if (!limited && (await waitFor(() => isLiked(btn), LIKE_CONFIRM_MS))) {
                this.store.recordLike();
                this.commit();
            }
            await sleep(randomBetween(this.settings.likeIntervalMin, this.settings.likeIntervalMax));
            if (this.state.isReading && this.state.isLiking) this.autoLike();
        }

        /* 论坛的「今日点赞上限」提示框
           文案形如：今天您已经达到 24 小时点赞上限……您可以在 9 小时后再次点赞。
           读到小时数就排冷却（小时 + 缓冲），关掉弹窗，然后恢复点赞继续跑。 */
        likeLimitDialog() {
            const box = document.querySelector(SEL.likeLimitDialog);
            if (!box) return null;
            const text = textOf(box);
            if (!/点赞上限|like limit/i.test(text)) return null;
            return { box, text };
        }

        // 从提示里取「N 小时后」；取不到就给个保守默认值
        static parseCooldownHours(text) {
            const m = String(text || '').match(/(\d+)\s*小时后/);
            return m ? Number(m[1]) : 24;
        }

        // 返回 true 表示撞上了上限（本次点赞无效）
        async handleLikeLimitDialog() {
            const dlg = this.likeLimitDialog();
            if (!dlg) return false;
            const hours = Reader.parseCooldownHours(dlg.text);
            this.store.setLikeCooldown(hours);
            // 拿到上限就立刻把点赞关掉：面板显示"禁用"，阅读继续
            this.state.isLiking = false;
            this.state.likeAutoResume = true;
            // 关掉弹窗，否则它会挡住后续操作
            const ok = dlg.box.querySelector('button');
            if (ok) ok.click();
            else dlg.box.remove();
            this.commit();
            this.ui.toast(`论坛提示今日点赞已达上限，已关闭点赞；${hours} 小时后（另加缓冲）自动恢复`, 'bad');
            return true;
        }

        // 冷却到期就自动把点赞打开
        resumeLikeIfReady() {
            if (!this.state.likeAutoResume) return;   // 不是冷却关掉的，就别擅自打开
            if (this.state.isLiking || !this.state.isReading) return;
            if (this.store.likeCoolingDown()) return;
            this.state.isLiking = true;
            this.state.likeAutoResume = false;
            this.commit();
            this.ui.toast('点赞冷却结束，已自动恢复点赞', 'ok');
            if (this.isTopicPage()) this.autoLike();
        }

        isErrorPage() { return !!document.querySelector(SEL.errorMarker) || /找不到页面|页面不存在|404/.test(document.title); }

        handleErrorPage() {
            this.state.errorRetries += 1;
            this.commit();
            if (this.state.errorRetries > this.settings.maxRetries) {
                this.state.errorRetries = 0;
                this.state.unseenHrefs = [];
                this.stopReading();
                this.ui.toast('连续错误过多，已停止', 'bad');
                return;
            }
            this.openNextTopic();
        }

        renderStatus() {
            this.ui.renderStatus({
                selfName: selfUsername(),
                isReading: this.state.isReading,
                isPaused: this.state.isPaused,
                isLiking: this.state.isLiking,
                likeCount: this.store.getLikeCount(),
                likeLimit: this.settings.likeLimit,
                likeCoolingDown: this.store.likeCoolingDown(),
                likeCooldownLeftMs: Math.max(0, (Number(this.state.likeCooldownUntil) || 0) - Date.now()),
                readCountToday: this.store.getReadCountToday(),
                readCountTotal: this.store.getReadCountTotal(),
                unseenCount: this.state.unseenHrefs.length,
                errorRetries: this.state.errorRetries,
                maxRetries: this.settings.maxRetries,
            });
        }

        openSettings() {
            this.ui.showSettings({
                settings: this.settings,
                readCountToday: this.store.getReadCountToday(),
                readCountTotal: this.store.getReadCountTotal(),
                handlers: {
                    save: (patch) => {
                        this.store.updateSettings(patch);
                        this.ui.closeSettings();
                        this.ui.toast('设置已保存', 'ok');
                        this.renderStatus();
                    },
                    resetCount: () => {
                        this.store.resetReadCount();
                        this.ui.toast('已读计数已清零', 'ok');
                        this.renderStatus();
                    },
                    close: () => this.ui.closeSettings(),
                },
            });
        }
    }

    /* ---------------- 入口 ---------------- */
    function boot() {
        try {
            const store = new Store();
            const ui = new UI();
            const reader = new Reader({ store, ui });
            reader.start();
            // 调试出口只暴露只读快照
            window.__autoRead = {
                ui, reader,
                store: {
                    getSettings: () => Object.assign({}, store.settings),
                    getState: () => JSON.parse(JSON.stringify(store.state)),
                },
                utils: { textOf, topicProgress, escapeAttr, fmtHours },
            };
        } catch (e) {
            console.error('[auto-read] 启动失败：', e);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
