// ==UserScript==
// @name         自动阅读 linux.do 论坛
// @namespace    https://github.com/auto-read-linuxDo
// @version      4.4.2
// @description  自动滚动阅读 linux.do 未读帖子，支持自动点赞与 AI 评论；设置面板可配置 AI 接口地址与模型，并可一键测试生成回复。每个标签页一个实例，可多开并行互不干扰。滚动由计时器驱动，窗口失焦也不暂停；没有回复的单楼帖没有进度条，宽限一小段时间后自动跳过。面板使用 Shadow DOM 隔离，不依赖任何外部 CDN。
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

    // ===================== 配置 =====================
    // 这里的值只是默认值，用户可在面板「设置」中覆盖，覆盖后存入本地存储。
    const VERSION = '4.4.2';

    const DEFAULTS = {
        likeLimit: 30,             // 每日点赞上限
        maxRetries: 3,             // 连续错误页重试次数
        scrollSpeed: 50,           // 每次滚动像素
        scrollInterval: 150,       // 滚动间隔（毫秒）
        noProgressGraceTicks: 15,  // 读不到进度条时再多滚几拍才判读完（默认约 3 秒），给异步渲染留窗口
        likeIntervalMin: 2000,     // 点赞间隔下限
        likeIntervalMax: 5000,     // 点赞间隔上限
        waitTimeout: 8000,         // 等待元素超时（毫秒）
        commentLimit: 20,          // 每日评论上限
        panelCollapsed: false,     // 面板是否收起（只留右缘手柄）

        logLimit: 300,             // 日志最多保留条数
        readKeyLimit: 2000,        // 已读去重表最多保留条数
        unseenLimit: 300,          // 一次最多取多少个未读链接

        updateInterval: 500,       // 状态栏刷新间隔
        markReadInterval: 200,     // 已读扫描间隔
        saveThrottle: 2000,        // 存档节流
        heartbeatInterval: 10000,  // 运行锁心跳
        lockStale: 30000,          // 运行锁过期时间
        claimStale: 180000,        // 帖子认领有效期：实例崩了，别的实例最多等这么久接手

        baseUrl: 'https://linux.do',

        aiUrl: 'https://tbai.xin/v1/chat/completions',
        aiModel: 'gpt-4.1-mini',
        aiSystemPrompt: `角色设定：资深水贴狂魔。看到任何帖子，评论！原则：1. 不分析、不解答、不帮忙、不预测、不深入。2. 氛围融入大师：语气必须中立/凑热闹，绝不突兀。3. 超短口语化：每条评论不少于20字，越接地气越好。4. 严禁说教或攻击：不准出现建议、批评、分析、教育等一切“认真你就输了”的内容。输出格式：textarea[评论内容]`,
    };

    // 面板里可编辑的 AI 配置项：markup 与保存字段都从这张表生成，
    // 新增一项（比如 temperature）只需在这里加一行，不必再同步改四处。
    const AI_FIELDS = [
        { key: 'aiUrl', id: 'setAiUrl', label: 'AI 接口地址' },
        { key: 'aiModel', id: 'setAiModel', label: 'AI 模型' },
    ];

    // 选择器集中管理：优先用稳定的 class / 属性，中文 title 只做兜底，
    // 避免站点改文案或切换语言后脚本整体失效。
    const SEL = {
        unseenLink: 'a.title.raw-link.raw-topic-link',
        post: 'article[data-post-id]',
        likeButton: 'button.like-button, button.like, button[title="点赞此帖子"]',
        replyOpen: 'button.reply-to-post, button[title="开始撰写此话题的回复"]',
        replyTextarea: '#reply-control textarea, .reply-area textarea, textarea.d-editor-input',
        replySubmit: '#reply-control .btn-primary, .reply-area button.btn-primary',
        cooked: '.cooked',
        topicTitle: '#topic-title .fancy-title, .title-wrapper .fancy-title',
        errorMarker: '#main-outlet .not-found, .page-not-found',
        selfLink: '[data-link-name="my-messages"], #current-user a[href^="/u/"]',
        postAuthor: 'article[data-post-id] .topic-meta-data .names a[href^="/u/"]',
        timeline: '.timeline-replies',
    };

    // 存储键分两类：settings / apiKey 全局共用（改一次处处生效），
    // state 与 lock 按实例隔离——否则两个标签页会抢同一把锁、互相覆盖阅读进度。
    const KEYS = {
        settings: 'autoReadSettingsV4',
        apiKey: 'autoReadApiKeyV4',
        // 多实例改造前的那份共享状态：只作为新实例首次启动的基线读一次，不再写
        legacyState: 'autoReadStateV4',
        state: (id) => `autoReadStateV4:${id}`,
        lock: (id) => `autoReadLockV4:${id}`,
        instances: 'autoReadInstancesV4',
        // 帖子认领表：谁先拿到谁读，多个实例各读各的，不会同时扑同一篇
        claims: 'autoReadClaimsV4',
    };

    // ===================== 实例标识 =====================
    // 每个标签页一个实例 id：刷新复用（队列与进度不丢），关掉标签页即弃。
    // window.open 出来的新标签页会连 sessionStorage 一起复制，只看 sessionStorage
    // 会让两个标签页拿到同一个 id；用 window.name 里的标记区分「同页刷新」与
    // 「复制出来的新标签页」——标记对得上才复用，否则重新发号。
    const INSTANCE_SLOT = 'autoReadInstanceV4';
    const INSTANCE_MARK = 'ar:';

    function newInstanceId() {
        const t = Date.now().toString(36);
        const r = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
        return `${t}${r}`;
    }

    function resolveInstanceId() {
        let mark = '';
        try {
            mark = String(window.name || '');
        } catch (e) {
            /* 沙箱封了 window.name：按新实例处理 */
        }
        let rec = null;
        try {
            rec = JSON.parse(sessionStorage.getItem(INSTANCE_SLOT) || 'null');
        } catch (e) {
            rec = null; // 隐私模式封了 sessionStorage：退化成内存内唯一 id
        }
        if (rec && rec.id && mark === INSTANCE_MARK + rec.id) return rec.id;
        const id = newInstanceId();
        try {
            sessionStorage.setItem(INSTANCE_SLOT, JSON.stringify({ id, ts: Date.now() }));
        } catch (e) {
            /* ignore */
        }
        try {
            window.name = INSTANCE_MARK + id;
        } catch (e) {
            /* ignore */
        }
        return id;
    }

    // 面板上只显示后 4 位，够分辨，也不把整串噪音塞进标题
    const shortId = (id) => String(id || '').slice(-4);

    // 认领键用 pathname：/t/slug/123 与 /t/123?page=2 指向同一篇帖子，
    // 带上域名或查询串会变成两个键，两个实例就都以为自己是第一个。
    function topicKey(href, base) {
        try {
            const u = new URL(String(href || ''), base || location.origin);
            return (u.pathname || '').replace(/\/+$/, '') || '/';
        } catch (e) {
            return '';
        }
    }

    // ===================== 通用工具 =====================
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 点赞后等待服务端确认的窗口（毫秒）
    const LIKE_CONFIRM_MS = 1500;
    // Discourse 的「已赞」标记：has-like class 或 aria-pressed=true
    const isLiked = (btn) => !!btn && (btn.classList.contains('has-like') || btn.getAttribute('aria-pressed') === 'true');
    // 同一按钮一次访问只尝试一次，网络慢时不会反复点成「取消赞」
    const likeKey = (btn) => {
        const post = btn && btn.closest ? btn.closest('[data-post-id]') : null;
        return (post && post.getAttribute('data-post-id')) || (btn && btn.id) || 'unknown';
    };
    const randomBetween = (min, max) => Math.round(min + Math.random() * (max - min));

    function textOf(el, max = 0) {
        const t = (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
        return max > 0 ? t.slice(0, max) : t;
    }


    // 话题进度：.timeline-replies 里是「当前楼层 / 总楼层」，如 28 / 29。
    // Discourse 只有滚动到底、所有楼层加载完才会显示 29/29，因此追平即代表读完。
    // 只有楼主、没有任何回复的单楼帖不会渲染这条进度条，此时返回 null，由调用方按「无进度条」跳过。
    function topicProgress() {
        const el = document.querySelector(SEL.timeline);
        if (!el) return null;
        const m = String(el.textContent || '').replace(/\s+/g, '').match(/(\d+)\/(\d+)/);
        if (!m) return null;
        const current = Number(m[1]);
        const total = Number(m[2]);
        if (!total) return null;
        return { current, total, done: current >= total };
    }

    // 轮询等待条件成立：点赞等「服务端确认」的场景不能靠固定 sleep
    async function waitFor(predicate, timeout) {
        const deadline = Date.now() + timeout;
        do {
            if (predicate()) return true;
            await sleep(120);
        } while (Date.now() < deadline);
        return false;
    }

    // 等待元素出现；超时返回 null，由调用方决定降级路径
    function waitForElm(selector, timeout = 8000) {
        return new Promise((resolve) => {
            const found = document.querySelector(selector);
            if (found) return resolve(found);
            let done = false;
            const finish = (el) => {
                if (done) return;
                done = true;
                observer.disconnect();
                clearTimeout(timer);
                resolve(el);
            };
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) finish(el);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            const timer = setTimeout(() => finish(null), timeout);
        });
    }

    function downloadFile(filename, content, mime) {
        const url = URL.createObjectURL(new Blob([content], { type: mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // CSV 单元格：引号翻倍 + 去换行，保证表格软件能正确解析；
    // 首字符是 = + - @ 或制表符时前置单引号，避免 Excel / WPS 把帖子标题当公式执行
    const csvCell = (v) => {
        let s = String(v === null || v === undefined ? '' : v)
            .replace(/"/g, '""')
            .replace(/\r?\n/g, ' ');
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return '"' + s + '"';
    };

    // 切换按钮：统一设置文案与 aria-pressed
    const setToggle = (btn, on, onText, offText) => {
        btn.textContent = on ? onText : offText;
        btn.setAttribute('aria-pressed', String(!!on));
    };

    // 把用户填写的接口地址/模型安全地塞进 value="..."，避免引号提前闭合
    function escapeAttr(v) {
        return String(v === null || v === undefined ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // 只放行 http(s)：帖子里的 url 可能被写成 javascript: / data:，不能直接进 href
    function safeHref(u) {
        const raw = String(u === null || u === undefined ? '' : u).trim();
        // 空串会被 new URL('', base) 解析成「当前页」，不能当成有效链接
        if (!raw) return '';
        try {
            const url = new URL(raw, location.href);
            return /^https?:$/.test(url.protocol) ? url.href : '';
        } catch (e) {
            return '';
        }
    }

    // ===================== 请求头字符集 =====================
    // fetch 的 Header 值只能是 ISO-8859-1（有效字节串）。API Key 里一旦混进中文、
    // 全角空格、中文引号、零宽字符，浏览器在发请求之前就直接抛
    // "String contains non ISO-8859-1 code point"，根本到不了服务端。
    // 所以这里统一做「清洗 + 定位」两步：能救的自动救（首尾空白、Bearer 前缀、引号、
    // 零宽字符），救不了的把第一个非法字符的位置和内容报出来，方便用户自己改。
    function normalizeSecret(raw) {
        let v = String(raw === null || raw === undefined ? '' : raw);
        v = v.replace(/[\u200B-\u200D\uFEFF]/g, '');          // 零宽字符 / BOM
        v = v.replace(/^Bearer\s+/i, '');                       // 整段粘进来的 "Bearer xxx"
        v = v.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');        // 半角 + 全角空格、换行
        v = v.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '');          // 中英文引号 / 反引号
        return v.trim();
    }

    // 找出第一个非 ISO-8859-1 字符（charCode > 0xFF）；返回 null 表示合法
    function findNonLatin1(s) {
        for (let i = 0; i < s.length; i++) {
            if (s.charCodeAt(i) > 0xff) {
                return { index: i, ch: s[i], code: s.charCodeAt(i) };
            }
        }
        return null;
    }

    // 回车/换行/Tab 之类控制字符同样会让 fetch 拒绝整个请求头，单独查一遍
    function findControlChar(s) {
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c < 0x20 || c === 0x7f) {
                return { index: i, ch: s[i], code: c };
            }
        }
        return null;
    }

    // 校验任意「会进入 HTTP 头」的值，非法时抛一个能直接照着改的错误
    function assertHeaderSafe(value, label) {
        const s = String(value === null || value === undefined ? '' : value);
        const bad = findNonLatin1(s) || findControlChar(s);
        if (!bad) return s;
        const code = 'U+' + bad.code.toString(16).toUpperCase().padStart(4, '0');
        const shown = bad.code < 0x20 ? `控制字符 U+${bad.code.toString(16).toUpperCase().padStart(2, '0')}` : `「${bad.ch}」`;
        throw new Error(
            `${label} 第 ${bad.index + 1} 个字符 ${shown} (${code}) 不是合法请求头字符，` +
                'HTTP 请求头只接受 ISO-8859-1 单字节，浏览器会直接拒绝发送。请检查是否粘贴了中文、全角空格或换行后重新填写。'
        );
    }

    // ===================== 存储 =====================
    // 优先 GM_* 存储（不受站点清理影响），没有授权时退回 localStorage。
    const GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function readRaw(key, fallback) {
        try {
            if (GM) {
                const v = GM_getValue(key, null);
                return v === null || v === undefined ? fallback : v;
            }
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }

    function writeRaw(key, value) {
        try {
            if (GM) GM_setValue(key, value);
            else localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn('[auto-read] 存储写入失败：', e);
        }
    }

    function removeRaw(key) {
        try {
            if (GM && typeof GM_deleteValue === 'function') GM_deleteValue(key);
            else localStorage.removeItem(key);
        } catch (e) {
            /* ignore */
        }
    }

    // 用本地日期（而非毫秒差）判断跨天，避免时区与 24 小时窗口错位
    const todayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

    // 从 /u/xxx 形式的链接里取出用户名，统一转小写后比较
    function usernameFromHref(href) {
        const m = String(href || '').match(/^\/u\/([^/?#]+)/i);
        return m ? decodeURIComponent(m[1]).toLowerCase() : '';
    }

    // 当前登录用户：侧边栏「我的个人消息」链接形如 /u/ououmm/messages
    function selfUsername() {
        return usernameFromHref(document.querySelector(SEL.selfLink)?.getAttribute('href'));
    }

    const defaultState = () => ({
        isReading: false,
        isPaused: false,
        isLiking: false,
        autoCommentEnabled: false,
        unseenHrefs: [],
        errorRetries: 0,

        likeCount: 0,
        likeDateKey: todayKey(),

        commentCount: 0,
        commentDateKey: todayKey(),

        readPostIds: [],          // 已读去重表
        postsReadCount: 0,        // 累计已读
        readDateKey: todayKey(),
        readCountToday: 0,        // 今日已读

        actionLog: [],
    });

    class Store {
        constructor({ instanceId } = {}) {
            this.instanceId = String(instanceId || newInstanceId());
            this.stateKey = KEYS.state(this.instanceId);
            this.lockKey = KEYS.lock(this.instanceId);

            this.settings = Object.assign({}, DEFAULTS, readRaw(KEYS.settings, {}));
            this.state = Object.assign(defaultState(), this._initialState());
            this._timer = null;
            this._saved = '';
        }

        // 新实例第一次启动时，把老版本那份共享状态里的已读表与配额继承过来，
        // 否则升级后每个实例都从「零已读」重来。只读老键、不写回，
        // 所以多个实例各继承一次也不会互相覆盖。
        _initialState() {
            const own = readRaw(this.stateKey, null);
            if (own && typeof own === 'object') return own;
            const legacy = readRaw(KEYS.legacyState, null);
            if (!legacy || typeof legacy !== 'object') return {};
            const carry = {};
            const fields = [
                'readPostIds',
                'postsReadCount',
                'readCountToday',
                'readDateKey',
                'likeCount',
                'likeDateKey',
                'commentCount',
                'commentDateKey',
            ];
            fields.forEach((k) => {
                if (legacy[k] !== undefined) carry[k] = legacy[k];
            });
            return carry;
        }

        // ---------- 设置与 Key ----------
        updateSettings(patch) {
            Object.assign(this.settings, patch);
            writeRaw(KEYS.settings, this.settings);
        }

        getApiKey() {
            const v = readRaw(KEYS.apiKey, '');
            // 老版本存进去的 Key 可能带全角空格/中文引号，读出来先洗一遍，避免一用就撞 header 报错
            return typeof v === 'string' ? normalizeSecret(v) : '';
        }

        setApiKey(key) {
            const v = normalizeSecret(key);
            assertHeaderSafe(v, 'API Key');
            if (v) writeRaw(KEYS.apiKey, v);
            else removeRaw(KEYS.apiKey);
        }

        hasApiKey() {
            return this.getApiKey().length > 0;
        }

        // 三个按日计数共用同一套「本地日期变化即归零」逻辑
        _daily(countKey, dateKey) {
            if (this.state[dateKey] !== todayKey()) {
                this.state[dateKey] = todayKey();
                this.state[countKey] = 0;
            }
            return this.state[countKey];
        }

        // ---------- 点赞计数（单一数据源，跨天清零） ----------
        getLikeCount() { return this._daily('likeCount', 'likeDateKey'); }
        canLike() { return this.getLikeCount() < this.settings.likeLimit; }

        // ---------- 评论计数（同点赞） ----------
        getCommentCount() { return this._daily('commentCount', 'commentDateKey'); }
        canComment() { return this.getCommentCount() < this.settings.commentLimit; }

        // ---------- 已读计数 ----------
        getReadCountToday() { return this._daily('readCountToday', 'readDateKey'); }

        getReadCountTotal() {
            return this.state.postsReadCount || 0;
        }

        // 只有真正新增的帖子才计数，重复浏览同一个帖子不会多算
        markPostRead(postId) {
            const id = String(postId || '');
            if (!id || this.state.readPostIds.includes(id)) return false;
            this.state.readPostIds.push(id);
            const limit = this.settings.readKeyLimit;
            if (this.state.readPostIds.length > limit) {
                this.state.readPostIds.splice(0, this.state.readPostIds.length - limit);
            }
            this.state.postsReadCount += 1;
            this.state.readCountToday = this.getReadCountToday() + 1;
            this.save();
            return true;
        }

        // 只清计数，不清已读去重表
        resetReadCount() {
            this.state.postsReadCount = 0;
            this.state.readCountToday = 0;
            this.state.readDateKey = todayKey();
            this.save();
        }

        // ---------- 动作日志 ----------
        recordAction(entry) {
            const log = this.state.actionLog;
            const e = Object.assign({ time: Date.now() }, entry);
            const i = log.findIndex((x) => x.url === e.url);
            let newLike = false;
            let newComment = false;

            if (i === -1) {
                log.unshift(e);
                newLike = !!e.liked;
                newComment = !!e.commented;
            } else {
                // 只有此前未点赞/未评论、本次才计数，避免重复点击多算
                const old = log[i];
                newLike = !!e.liked && !old.liked;
                newComment = !!e.commented && !old.commented;
                log[i] = Object.assign({}, old, e, {
                    liked: old.liked || !!e.liked,
                    commented: old.commented || !!e.commented,
                });
            }
            if (newLike) this.state.likeCount = this.getLikeCount() + 1;
            if (newComment) this.state.commentCount = this.getCommentCount() + 1;
            if (log.length > this.settings.logLimit) log.length = this.settings.logLimit;
            this.save();
        }

        clearActionLog() {
            this.state.actionLog = [];
            this.save();
        }

        // ---------- 持久化（节流，避免每帧写盘） ----------
        save() {
            if (this._timer) return;
            this._timer = setTimeout(() => this.flush(), this.settings.saveThrottle);
        }

        flush() {
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            const json = JSON.stringify(this.state);
            if (json === this._saved) return;
            this._saved = json;
            writeRaw(this.stateKey, this.state);
        }

        // ---------- 实例锁（每实例一把，只防「同一个实例被重复注入」） ----------
        // 多实例并行时各锁各的键，互不阻塞。同一个 id 上出现第二个存活 token
        // 只会发生在同页重复注入、或浏览器把 sessionStorage 复制给了别的标签页。
        readLock() {
            const rec = readRaw(this.lockKey, null);
            return rec && typeof rec === 'object' ? rec : null;
        }

        acquireLock(token) {
            const rec = this.readLock();
            if (rec && rec.token !== token && Date.now() - (rec.ts || 0) < this.settings.lockStale) return false;
            writeRaw(this.lockKey, { token, ts: Date.now() });
            return true;
        }

        heartbeat(token) {
            const rec = this.readLock();
            if (rec && rec.token !== token) return false;
            writeRaw(this.lockKey, { token, ts: Date.now() });
            return true;
        }

        releaseLock(token) {
            const rec = this.readLock();
            if (rec && rec.token === token) removeRaw(this.lockKey);
        }

        // ---------- 实例表（只为在面板上显示「并行几个」并回收死实例） ----------
        // 读-改-写之间有窗口，并发时可能少记一条，只影响状态栏的计数显示，
        // 不影响阅读本身，所以不做跨标签页的互斥。
        pruneInstances() {
            const raw = readRaw(KEYS.instances, {});
            const table = raw && typeof raw === 'object' ? raw : {};
            const now = Date.now();
            const alive = {};
            Object.keys(table).forEach((id) => {
                if (id === this.instanceId) return;
                const rec = table[id] || {};
                if (now - (rec.ts || 0) < this.settings.lockStale) {
                    alive[id] = rec;
                } else {
                    // 心跳停够久：那个标签页已经关了，连带它留在存储里的进度一起回收
                    removeRaw(KEYS.state(id));
                    removeRaw(KEYS.lock(id));
                }
            });
            alive[this.instanceId] = { ts: now, at: String(location.pathname || '') };
            writeRaw(KEYS.instances, alive);
            return Object.keys(alive);
        }

        // 只读，供每 500ms 的状态刷新调用
        instanceCount() {
            const table = readRaw(KEYS.instances, {});
            if (!table || typeof table !== 'object') return 1;
            const now = Date.now();
            const n = Object.keys(table).filter(
                (id) => id === this.instanceId || now - ((table[id] || {}).ts || 0) < this.settings.lockStale
            ).length;
            return Math.max(1, n);
        }

        // ---------- 帖子认领（多实例之间唯一需要协同的地方） ----------
        // 两个实例同时进 /unseen 会拿到同一份列表，不协调就会重复读同一篇。
        // 谁先写进认领表谁读，另一个跳过；崩溃没释放的条目按 claimStale
        // 自动过期，不会永久占着。
        _claims() {
            const raw = readRaw(KEYS.claims, {});
            const table = raw && typeof raw === 'object' ? raw : {};
            const now = Date.now();
            const live = {};
            Object.keys(table).forEach((href) => {
                const rec = table[href] || {};
                if (now - (rec.ts || 0) < this.settings.claimStale) live[href] = rec;
            });
            return live;
        }

        claim(href) {
            const key = String(href || '');
            if (!key) return false;
            const table = this._claims();
            const rec = table[key];
            if (rec && rec.id !== this.instanceId) return false;
            table[key] = { id: this.instanceId, ts: Date.now() };
            writeRaw(KEYS.claims, table);
            return true;
        }

        // 只释放自己的，避免把别的实例正在读的条目删掉
        releaseClaim(href) {
            const key = String(href || '');
            if (!key) return;
            const table = this._claims();
            const rec = table[key];
            if (!rec || rec.id !== this.instanceId) return;
            delete table[key];
            writeRaw(KEYS.claims, table);
        }

        // 供 /unseen 列表预筛：被别人占着的不必当作「待读」
        unclaimed(links) {
            const table = this._claims();
            return (links || []).filter((href) => {
                const rec = table[href];
                return !rec || rec.id === this.instanceId;
            });
        }
    }

    // ===================== AI 评论 =====================
    // 开启「自动评论」时，帖子标题与前 500 字正文会发送到设置中的 AI 接口。
    // 这是脚本唯一的外发数据，未设置 API Key 时不会发生。
    const MAX_CONTEXT_CHARS = 500;

    // 「保存 / 测试回复 / 真正发请求」三条入口共用这份校验，
    // 配置错误在用户还看着面板时就暴露，而不是半夜自动评论静默失败。
    function validateAiSettings(raw) {
        const aiUrl = String((raw && raw.aiUrl) || '').trim() || DEFAULTS.aiUrl;
        if (!/^https?:\/\//i.test(aiUrl)) throw new Error('AI 接口地址需以 http:// 或 https:// 开头');
        let parsed;
        try {
            parsed = new URL(aiUrl);
        } catch (e) {
            throw new Error(`AI 接口地址无法解析：${aiUrl}（请检查是否含有空格、中文或全角字符）`);
        }
        // 只校验 protocol 不够：'https:///v1' 会被解析成 host='v1'，这种地址请求必然失败
        const host = parsed.hostname || '';
        const realHost =
            host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:]+\]$/i.test(host) || host.includes('.');
        if (!realHost) throw new Error(`AI 接口地址缺少有效域名：${aiUrl}`);
        const aiModel = String((raw && raw.aiModel) || '').trim() || DEFAULTS.aiModel;
        return { aiUrl, aiModel };
    }

    // 从返回文本里抽 textarea[...] 内的内容，失败则取首行
    function parseComment(text) {
        const raw = String(text || '').trim();
        if (!raw) return '';
        const m = raw.match(/textarea\[([\s\S]*?)\]/);
        // 没按格式输出时只取首行，避免把整段解释文字塞进回复框
        let out = (m ? m[1] : raw.split('\n')[0]).trim();
        out = out.replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim();
        if (!out) out = raw.split('\n')[0].trim();
        return out.slice(0, 120);
    }

    async function generateComment({ title, context, settings, apiKey, signal }) {
        const key = normalizeSecret(apiKey);
        if (!key) throw new Error('未设置 API Key');
        // 请求头只接受 ISO-8859-1：Key 里有中文/全角字符时提前报清楚，别让浏览器抛原始 DOMException
        assertHeaderSafe(key, 'API Key');
        const ai = validateAiSettings(settings);
        let res;
        try {
            res = await fetch(ai.aiUrl, {
                method: 'POST',
                signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: ai.aiModel,
                    messages: [
                        { role: 'system', content: settings.aiSystemPrompt },
                        {
                            role: 'user',
                            content: `标题：${String(title || '').slice(0, 200)}\n正文片段：${String(context || '').slice(0, MAX_CONTEXT_CHARS)}`,
                        },
                    ],
                    temperature: 0.9,
                }),
            });
        } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            const msg = String((e && e.message) || e || '');
            // 头字符集错误优先判定：它同样是 TypeError，但原因和网络故障完全不同
            if (/ISO-8859-1|non ISO/i.test(msg)) {
                throw new Error(
                    'API Key 或接口地址里含有非 ASCII 字符（中文、全角空格、中文标点等），' +
                        'HTTP 请求头只接受 ISO-8859-1，浏览器拒绝发送。请到设置里清空 API Key 重新粘贴一次纯英文 Key。'
                );
            }
            // 浏览器把 fetch 的网络层失败统一抛成 TypeError，不必去匹配各家私有的报错文案
            if (e instanceof TypeError) {
                throw new Error(`网络请求失败（地址不可达或被 CORS 拦截）：${ai.aiUrl}`);
            }
            throw new Error(`请求 AI 接口失败：${msg}`);
        }
        if (!res.ok) {
            // 尽量把服务端的错误原因带出来，配置错时不必再翻控制台
            let detail = '';
            try {
                const err = await res.json();
                detail = (err && err.error && err.error.message) || (err && err.message) || '';
            } catch (e) {
                detail = '';
            }
            throw new Error(`AI 接口返回 ${res.status}${detail ? `：${String(detail).slice(0, 200)}` : ''}`);
        }
        const data = await res.json();
        return parseComment(data?.choices?.[0]?.message?.content || '');
    }

    // 当前页面的话题上下文：标题 + 正文前 500 字。
    // 自动评论与「测试 AI 回复」共用同一份取数逻辑，保证测试结果与实际发帖一致。
    function currentTopicContext() {
        const title = textOf(document.querySelector(SEL.topicTitle)) || String(document.title || '').trim();
        const context = textOf(document.querySelector(SEL.cooked), MAX_CONTEXT_CHARS);
        return { title, context };
    }

    // ===================== UI：Shadow DOM 隔离 + 内联样式 =====================
    const STYLE = `
:host {
    all: initial;
    --bg: #fff; --fg: #111; --soft: #f3f4f6; --line: #e5e7eb;
    --btn: #f9fafb; --btnline: #d1d5db;
    --ok: #16a34a; --bad: #dc2626; --warn: #d97706; --accent: #2563eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color-scheme: light dark;
}
:host([data-theme="dark"]) {
    --bg: #1f2937; --fg: #f9fafb; --soft: #111827; --line: #4b5563;
    --btn: #374151; --btnline: #4b5563; --accent: #3b82f6;
}
*, *::before, *::after { box-sizing: border-box; }

.ar-dock { position: fixed; top: 50%; right: 12px; transform: translateY(-50%); z-index: 2147483000; display: flex; align-items: center; gap: 6px; }
.ar-panel { width: 236px; display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0,0,0,.18); }
.ar-panel[hidden], .ar-launcher[hidden] { display: none; }
.ar-head { display: flex; align-items: center; gap: 6px; padding: 0 2px; }
.ar-brand { font-size: 13px; font-weight: 700; }
.ar-user { font-size: 11px; opacity: .7; padding: 0 2px; margin-top: -4px; }
.ar-ver { font-size: 10px; opacity: .45; margin-right: auto; }
.ar-icon { appearance: none; width: 22px; height: 22px; padding: 0; font-family: inherit; font-size: 15px; line-height: 1; cursor: pointer; border: 0; border-radius: 6px; background: transparent; color: inherit; opacity: .55; }
.ar-icon:hover { opacity: 1; background: var(--soft); }
.ar-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.ar-grid .span { grid-column: 1 / -1; }
.ar-btn { appearance: none; font-family: inherit; border: 1px solid var(--btnline); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; font-weight: 600; line-height: 1.2; cursor: pointer; background: var(--btn); color: var(--fg); white-space: nowrap; }
.ar-btn:hover { background: var(--soft); }
.ar-btn[aria-pressed="true"] { background: #dbeafe; border-color: #3b82f6; color: #1d4ed8; }
.ar-btn:disabled { opacity: .5; cursor: not-allowed; }
.ar-btn.sm { padding: 4px 8px; font-size: 12px; }
.ar-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ar-btn.danger { background: transparent; border-color: var(--bad); color: var(--bad); }
.ar-btn:focus-visible, .ar-icon:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ar-status { padding: 8px 9px; border-radius: 8px; background: var(--soft); font-size: 11.5px; line-height: 1.75; }
.ar-ok { color: var(--ok); font-weight: 700; }
.ar-bad { color: var(--bad); font-weight: 700; }
.ar-warn { color: var(--warn); font-weight: 700; }

.ar-launcher { appearance: none; display: flex; align-items: center; gap: 6px; padding: 12px 7px; font-family: inherit; font-size: 12px; font-weight: 700; writing-mode: vertical-rl; letter-spacing: 2px; cursor: pointer; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); box-shadow: 0 6px 18px rgba(0,0,0,.16); opacity: .92; }
.ar-launcher:hover { opacity: 1; }
.ar-dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; flex: none; }
.ar-dot.run { background: var(--ok); box-shadow: 0 0 0 3px rgba(22,163,74,.18); animation: arpulse 1.8s ease-in-out infinite; }
.ar-dot.pause { background: var(--warn); box-shadow: 0 0 0 3px rgba(217,119,6,.18); }
@keyframes arpulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
@media (prefers-reduced-motion: reduce) { .ar-dot.run { animation: none } }

.ar-log { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 2147483001; width: min(860px, 92vw); max-height: 80vh; overflow: auto; padding: 18px; border-radius: 12px; background: var(--bg); color: var(--fg); font-size: 13px; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.ar-log-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 10px; }
.ar-title { font-size: 15px; font-weight: 700; margin: 0 auto 0 0; }
.ar-sum { width: 100%; opacity: .65; font-size: 12px; }
.ar-tbl { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.ar-tbl th, .ar-tbl td { padding: 6px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
.ar-tbl th { position: sticky; top: 0; background: var(--soft); }
.ar-tbl .c { text-align: center; }
.ar-tbl .cut { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-tbl a { color: var(--accent); text-decoration: none; }

.ar-toasts { position: fixed; top: 16px; right: 16px; z-index: 2147483002; display: flex; flex-direction: column; gap: 8px; max-width: 320px; }
.ar-toast { padding: 9px 12px; border-radius: 8px; font-size: 13px; background: #111827; color: #f9fafb; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.ar-toast.ok { background: var(--ok); }
.ar-toast.bad { background: var(--bad); }

.ar-modal { position: fixed; inset: 0; z-index: 2147483003; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.ar-box { width: min(400px, 92vw); max-height: 86vh; overflow: auto; padding: 18px; border-radius: 12px; background: var(--bg); color: var(--fg); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
.ar-text { font-size: 13px; line-height: 1.7; margin-bottom: 12px; }
.ar-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 12px; }
.ar-field input { font-family: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--btnline); border-radius: 6px; background: var(--bg); color: var(--fg); }
.ar-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 4px 0 12px; }
.ar-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ar-actions .danger { margin-right: auto; }

.ar-sect { border-top: 1px dashed var(--line); margin-top: 12px; padding-top: 10px; }
.ar-sect-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ar-sect-title { font-size: 12px; font-weight: 700; margin-right: auto; }
.ar-hint { font-size: 11px; line-height: 1.6; opacity: .68; }
.ar-meta { font-size: 11px; line-height: 1.6; opacity: .8; margin-top: 6px; word-break: break-word; }
.ar-out { margin-top: 6px; padding: 8px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; max-height: 170px; overflow: auto; }
.ar-out.ok { border-color: #86efac; }
.ar-out.bad { border-color: #fca5a5; }
.ar-out[hidden] { display: none; }
`;

    class UI {
        constructor({ instanceId = '' } = {}) {
            this.host = null;
            this.root = null;
            this.instanceId = instanceId;
            this._statusHtml = '';
        }

        // 挂载 Shadow Root（只做一次），并把主题同步到 host 上
        mount() {
            if (this.root) return this.root;
            const host = document.createElement('div');
            // 带上实例后缀：同一个页面里被注入两次（多实例插件、手动粘贴脚本）
            // 时两个面板各有各的 host，不会互相覆盖，也不会重复 id。
            host.id = this.instanceId ? `auto-read-ui-root-${shortId(this.instanceId)}` : 'auto-read-ui-root';
            host.setAttribute('data-auto-read-instance', this.instanceId || '');
            const root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = STYLE;
            const toasts = document.createElement('div');
            toasts.className = 'ar-toasts';
            root.append(style, toasts);
            document.body.appendChild(host);

            this.host = host;
            this.root = root;
            this.toasts = toasts;
            this.syncTheme();
            // 跟随站点主题：html.dark / data-theme 变化时重刷配色
            new MutationObserver(() => this.syncTheme()).observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['class', 'data-theme'],
            });
            return root;
        }

        syncTheme() {
            const de = document.documentElement;
            const dark = de.classList.contains('dark') || /^dark/.test(de.getAttribute('data-theme') || '');
            this.host.setAttribute('data-theme', dark ? 'dark' : 'light');
        }

        // ---------- 控制面板 ----------
        // 回调统一收进 handlers：加一个能力只改这里，调用点一处
        buildPanel({ collapsed, instanceId, handlers }) {
            const { read, pause, like, comment, log, settings, collapse } = handlers;
            const root = this.mount();
            // 重建前先移除旧面板：残留的同名 id 会让 querySelector('#x') 命中旧节点
            if (this.dock) this.dock.remove();
            const dock = document.createElement('div');
            dock.className = 'ar-dock';
            dock.innerHTML = `
                <div class="ar-panel" id="pan">
                    <div class="ar-head">
                        <span class="ar-brand">自动阅读</span>
                        <span class="ar-ver" title="实例 ${escapeAttr(instanceId || '')}">v${VERSION} · #${shortId(instanceId)}</span>
                        <button type="button" class="ar-icon" id="bHide" title="隐藏面板" aria-label="隐藏面板">×</button>
                    </div>
                    <div class="ar-user" id="user"></div>
                    <div class="ar-grid">
                        <button type="button" class="ar-btn span" id="bRead">开始阅读</button>
                        <button type="button" class="ar-btn" id="bPause">暂停</button>
                        <button type="button" class="ar-btn" id="bLike">启用点赞</button>
                        <button type="button" class="ar-btn" id="bComment">启用评论</button>
                        <button type="button" class="ar-btn" id="bLog">查看日志</button>
                        <button type="button" class="ar-btn" id="bSet">设置</button>
                    </div>
                    <div class="ar-status" id="status" aria-live="polite"></div>
                </div>
                <button type="button" class="ar-launcher" id="bShow" title="显示面板" aria-label="显示自动阅读面板" hidden>
                    <span class="ar-dot" id="dot"></span><span>自动阅读</span>
                </button>`;
            root.appendChild(dock);
            this.dock = dock;

            const q = (id) => dock.querySelector('#' + id);
            this.panel = q('pan');
            this.launcher = q('bShow');
            this.dot = q('dot');
            this.status = q('status');
            this.user = q('user');
            this.btnRead = q('bRead');
            this.btnPause = q('bPause');
            this.btnLike = q('bLike');
            this.btnComment = q('bComment');

            q('bHide').onclick = () => {
                this.setCollapsed(true);
                collapse(true);
            };
            q('bShow').onclick = () => {
                this.setCollapsed(false);
                collapse(false);
            };
            this.btnRead.onclick = read;
            this.btnPause.onclick = pause;
            this.btnLike.onclick = like;
            this.btnComment.onclick = comment;
            q('bLog').onclick = log;
            q('bSet').onclick = settings;

            this.setCollapsed(!!collapsed);
        }

        setCollapsed(v) {
            this.panel.hidden = v;
            this.launcher.hidden = !v;
        }

        // 只在内容变化时重写 DOM，避免每 500ms 的无效重排
        renderStatus(m) {
            if (!this.status) return;

            // 顶部展示从侧边栏「我的个人消息」链接解析到的当前登录用户名
            if (this.user) this.user.textContent = m.selfName ? `当前用户：@${m.selfName}` : '当前用户：未检测到';

            // 收起态手柄上的状态点：绿=运行中，橙=暂停，灰=已停止
            this.dot.className = 'ar-dot' + (m.isReading ? (m.isPaused ? ' pause' : ' run') : '');
            this.launcher.title = m.isReading ? (m.isPaused ? '已暂停 · 点击展开' : '运行中 · 点击展开') : '已停止 · 点击展开';

            setToggle(this.btnRead, m.isReading, '停止阅读', '开始阅读');
            // 只有「同一实例确实在别处运行」时才禁用；自己停止后应能再次开始
            this.btnRead.disabled = !m.isReading && m.locked === true;
            this.btnRead.title = this.btnRead.disabled ? '这个实例已在别处运行，请先在那边停止' : '';
            setToggle(this.btnLike, m.isLiking, '禁用点赞', '启用点赞');
            setToggle(this.btnComment, m.autoCommentEnabled, '禁用评论', '启用评论');
            setToggle(this.btnPause, m.isPaused, '继续', '暂停');
            this.btnPause.disabled = !m.isReading;

            const html =
                `阅读：${m.isReading ? (m.isPaused ? '<span class="ar-warn">已暂停</span>' : '<span class="ar-ok">运行中</span>') : '<span class="ar-bad">已停止</span>'}<br>` +
                `点赞：${m.isLiking ? '<span class="ar-ok">启用</span>' : '<span class="ar-bad">禁用</span>'}（${m.likeCount}/${m.likeLimit}）<br>` +
                `评论：${m.autoCommentEnabled ? '<span class="ar-ok">启用</span>' : '<span class="ar-bad">禁用</span>'}（${m.commentCount}/${m.commentLimit}）<br>` +
                `已读帖子：<span class="ar-ok">${m.readCountToday}</span> 今日 / ${m.readCountTotal} 累计<br>` +
                `剩余帖子：${m.unseenCount}<br>` +
                `错误重试：<span class="ar-bad">${m.errorRetries}/${m.maxRetries}</span><br>` +
                `实例：<span class="ar-ok">#${shortId(m.instanceId)}</span> · 并行 ${m.instanceCount || 1} 个`;
            if (html === this._statusHtml) return;
            this._statusHtml = html;
            this.status.innerHTML = html;
        }

        // ---------- 日志面板 ----------
        // 表格用 DOM + textContent 组装：帖子标题来自他人，任何 innerHTML 插值都是 XSS sink
        showLog({ entries, readCountToday, readCountTotal, handlers }) {
            const { exportCsv, clear, close } = handlers;
            this.closeLog();
            const likes = entries.filter((e) => e.liked).length;
            const comments = entries.filter((e) => e.commented).length;

            const panel = document.createElement('div');
            panel.className = 'ar-log';
            panel.id = 'ar-log';
            panel.innerHTML = `
                <div class="ar-log-head">
                    <span class="ar-title">操作日志</span>
                    <button type="button" class="ar-btn sm primary" id="logCsv">导出 CSV</button>
                    <button type="button" class="ar-btn sm danger" id="logClear">清空</button>
                    <button type="button" class="ar-btn sm" id="logClose">关闭</button>
                </div>
                <div class="ar-sum" id="logSum"></div>
                <table class="ar-tbl">
                    <thead><tr><th>时间</th><th>标题</th><th class="c">点赞</th><th class="c">评论</th><th>链接</th></tr></thead>
                    <tbody id="logBody"></tbody>
                </table>`;
            this.mount().appendChild(panel);

            panel.querySelector('#logSum').textContent =
                `已读 ${readCountTotal} 篇（今日 ${readCountToday} 篇）· 共 ${entries.length} 条记录 · 点赞 ${likes} · 评论 ${comments}`;

            const body = panel.querySelector('#logBody');
            if (!entries.length) {
                const tr = body.insertRow();
                const td = tr.insertCell();
                td.className = 'c';
                td.colSpan = 5;
                td.textContent = '暂无记录';
            } else {
                for (const e of entries) {
                    const tr = body.insertRow();
                    tr.insertCell().textContent = e.time ? new Date(e.time).toLocaleString() : '';
                    const titleCell = tr.insertCell();
                    titleCell.className = 'cut';
                    titleCell.textContent = e.title || '(无标题)';
                    const likeCell = tr.insertCell();
                    likeCell.className = 'c';
                    likeCell.textContent = e.liked ? '✓' : '—';
                    const commentCell = tr.insertCell();
                    commentCell.className = 'c';
                    commentCell.textContent = e.commented ? '✓' : '—';
                    const linkCell = tr.insertCell();
                    const href = safeHref(e.url);
                    if (href) {
                        const a = document.createElement('a');
                        a.href = href;
                        a.textContent = '打开';
                        a.target = '_blank';
                        a.rel = 'noreferrer';
                        linkCell.appendChild(a);
                    } else {
                        linkCell.textContent = '—';
                    }
                }
            }

            const q = (id) => panel.querySelector('#' + id);
            q('logCsv').onclick = exportCsv;
            q('logClear').onclick = clear;
            q('logClose').onclick = close;
            this.logEl = panel;
        }

        closeLog() {
            if (this.logEl) {
                this.logEl.remove();
                this.logEl = null;
            }
        }

        // ---------- 设置面板 ----------
        showSettings({ settings, hasApiKey, readCountToday, readCountTotal, instanceId, instanceCount, handlers }) {
            const { save, dropKey, resetCount, testReply, newInstance, prune, close } = handlers;
            this.closeSettings();

            // AI 配置项由 AI_FIELDS 生成：加一项只改表，不用再动 markup 与保存逻辑
            const aiInputs = AI_FIELDS.map(
                (f) =>
                    `<label class="ar-field">${f.label}<input id="${f.id}" type="text" spellcheck="false" ` +
                    `autocomplete="off" value="${escapeAttr(settings[f.key])}" ` +
                    `placeholder="${escapeAttr(DEFAULTS[f.key])}"></label>`
            ).join('\n                    ');

            const modal = document.createElement('div');
            modal.className = 'ar-modal';
            modal.id = 'ar-settings';
            modal.innerHTML = `
                <div class="ar-box" style="width:min(440px,94vw)">
                    <div class="ar-title" style="margin-bottom:12px">设置</div>
                    <label class="ar-field">每日点赞上限<input id="setLike" type="number" min="0" max="500" value="${settings.likeLimit}"></label>
                    <label class="ar-field">每日评论上限<input id="setComment" type="number" min="0" max="500" value="${settings.commentLimit}"></label>
                    <label class="ar-field">错误重试次数<input id="setRetry" type="number" min="0" max="10" value="${settings.maxRetries}"></label>
                    ${aiInputs}
                    <label class="ar-field">AI API Key<input id="setKey" type="password" autocomplete="off" placeholder="${hasApiKey ? '已保存，留空则不修改' : '未设置'}"></label>
                    <div class="ar-row">
                        <span id="setCount" style="flex:1">已读 ${readCountTotal} 篇（今日 ${readCountToday} 篇）</span>
                        <button type="button" class="ar-btn sm danger" id="setResetCount">清零</button>
                    </div>
                    <div class="ar-sect">
                        <div class="ar-sect-head">
                            <span class="ar-sect-title">测试 AI 回复</span>
                            <button type="button" class="ar-btn sm primary" id="setTest">生成回复</button>
                        </div>
                        <div class="ar-hint">按上面填写的接口与模型，把当前帖子的标题与正文前 ${MAX_CONTEXT_CHARS} 字发给 AI，只展示生成的回复，不会真的发帖。</div>
                        <div class="ar-meta" id="setMeta"></div>
                        <div class="ar-out" id="setOut" hidden></div>
                    </div>
                    <div class="ar-sect">
                        <div class="ar-sect-head">
                            <span class="ar-sect-title">多实例</span>
                            <button type="button" class="ar-btn sm" id="setNewInst">新开一个</button>
                        </div>
                        <div class="ar-hint">当前实例 <b title="${escapeAttr(instanceId || '')}">#${shortId(instanceId)}</b>。阅读队列、进度与点赞/评论配额按实例独立，可以同时开多个标签页各跑各的；AI 接口地址、模型与 Key 为全局共用。</div>
                        <div class="ar-row">
                            <span id="setInstInfo" style="flex:1">并行实例：${instanceCount || 1} 个</span>
                            <button type="button" class="ar-btn sm danger" id="setPruneInst">清理失效实例</button>
                        </div>
                    </div>
                    <div class="ar-actions">
                        <button type="button" class="ar-btn sm danger" id="setDropKey">删除已存 Key</button>
                        <button type="button" class="ar-btn sm" id="setCancel">取消</button>
                        <button type="button" class="ar-btn sm primary" id="setOk">保存</button>
                    </div>
                </div>`;
            this.mount().appendChild(modal);

            const q = (id) => modal.querySelector('#' + id);
            // AI 字段按表收集，避免「面板能填、保存丢失」这类漏改
            const aiDraft = () =>
                AI_FIELDS.reduce((acc, f) => {
                    acc[f.key] = q(f.id).value.trim();
                    return acc;
                }, {});

            q('setResetCount').onclick = async () => {
                if (!(await this.confirm('确定把已读计数清零吗？已读去重记录会保留。'))) return;
                resetCount();
                q('setCount').textContent = '已读 0 篇（今日 0 篇）';
            };
            q('setDropKey').onclick = () => {
                dropKey();
                q('setKey').value = '';
                q('setKey').placeholder = '未设置';
            };
            // 测试回复：直接用输入框里的地址/模型/Key，不写设置，避免半成品配置被保存
            q('setTest').onclick = async () => {
                const btn = q('setTest');
                const out = q('setOut');
                const meta = q('setMeta');
                btn.disabled = true;
                btn.textContent = '生成中…';
                out.hidden = false;
                out.className = 'ar-out';
                out.textContent = '正在请求 AI 接口…';
                meta.textContent = '';
                try {
                    const r = await testReply(Object.assign(aiDraft(), { apiKey: q('setKey').value.trim() }));
                    meta.textContent = `标题：${r.title || '(未取到标题)'} · 正文 ${r.context.length} 字 · 模型：${r.model}`;
                    out.className = 'ar-out ok';
                    out.textContent = r.comment || '（接口返回内容为空）';
                } catch (e) {
                    meta.textContent = '生成失败';
                    out.className = 'ar-out bad';
                    out.textContent = String((e && e.message) || e || '未知错误');
                } finally {
                    btn.disabled = false;
                    btn.textContent = '生成回复';
                }
            };
            q('setNewInst').onclick = () => newInstance();
            q('setPruneInst').onclick = () => {
                const left = prune();
                q('setInstInfo').textContent = `并行实例：${left || 1} 个`;
            };
            q('setCancel').onclick = close;
            q('setOk').onclick = () =>
                save(
                    Object.assign(
                        {
                            likeLimit: Math.max(0, Number(q('setLike').value) || 0),
                            commentLimit: Math.max(0, Number(q('setComment').value) || 0),
                            maxRetries: Math.max(0, Number(q('setRetry').value) || 0),
                        },
                        aiDraft(),
                        { apiKey: q('setKey').value.trim() }
                    )
                );
        }

        closeSettings() {
            const el = this.root && this.root.getElementById('ar-settings');
            if (el) el.remove();
        }

        // ---------- Toast / Confirm（替代 alert、confirm） ----------
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
                modal.innerHTML = `
                    <div class="ar-box">
                        <div class="ar-text"></div>
                        <div class="ar-actions">
                            <button type="button" class="ar-btn sm" data-v="0">取消</button>
                            <button type="button" class="ar-btn sm primary" data-v="1">确定</button>
                        </div>
                    </div>`;
                modal.querySelector('.ar-text').textContent = message;
                modal.querySelectorAll('button').forEach((b) => {
                    b.onclick = () => {
                        modal.remove();
                        resolve(b.dataset.v === '1');
                    };
                });
                this.mount().appendChild(modal);
            });
        }
    }

    // ===================== 主流程 =====================
    // 职责：路由处理、滚动阅读、点赞、AI 评论、错误重试。
    // 所有状态读写走 Store，所有 UI 操作走 UI（Shadow DOM）。
    class Reader {
        constructor({ store, ui }) {
            this.store = store;
            this.ui = ui;

            // 滚动循环用计时器驱动（不是 requestAnimationFrame）：
            // rAF 与渲染帧绑定，窗口失焦 / 被遮挡 / 切后台会被暂停，表现为「没盯着就停」。
            this.scrollTimer = null;
            this._noProgressTicks = 0;   // 连续多少拍读不到进度条（单楼帖判定）
            this.lastMarkAt = 0;
            this.heartbeatTimer = null;
            this.statusTimer = null;
            this.abortCtrl = null;
            // 实例 id 跨标签页唯一；lockToken 只区分「同一实例的哪一份注入」
            this.instanceId = store.instanceId;
            this.lockToken = `ar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.authorSeen = false;
            this._likeTried = new Set();
            this._posts = null;
            this._postsAt = 0;
        }

        get state() {
            return this.store.state;
        }

        get settings() {
            return this.store.settings;
        }

        // 落盘 + 重绘状态栏：开关与动作后成对出现，收敛成一步
        commit() {
            this.store.flush();
            this.renderStatus();
        }

        // ---------- 启动 ----------
        start() {
            this.ui.buildPanel({
                collapsed: !!this.settings.panelCollapsed,
                instanceId: this.instanceId,
                handlers: {
                    read: () => this.toggleReading(),
                    pause: () => this.togglePause(),
                    like: () => this.toggleLiking(),
                    comment: () => this.toggleCommenting(),
                    log: () => this.openLog(),
                    settings: () => this.openSettings(),
                    // 显隐状态记忆到设置里，刷新后保持上次选择
                    collapse: (collapsed) => this.store.updateSettings({ panelCollapsed: collapsed }),
                },
            });
            this.renderStatus();
            this.statusTimer = setInterval(() => this.renderStatus(), this.settings.updateInterval);

            // 页面卸载时落盘并交还锁，只注册一次
            window.addEventListener('pagehide', () => {
                this.store.flush();
                this.store.releaseLock(this.lockToken);
                // 只交还当前这篇：openNextTopic 刚认领的下一篇要留给下一个页面用
                this.store.releaseClaim(topicKey(location.pathname, this.settings.baseUrl));
            });

            // @run-at document-idle 时 load 可能已触发，需兼容 readyState
            if (document.readyState === 'complete') this.onReady();
            else window.addEventListener('load', () => this.onReady(), { once: true });
        }

        onReady() {
            if (!this.store.acquireLock(this.lockToken)) {
                this.ui.toast('这个实例已在别处运行，本页不会自动开始', 'bad');
                return;
            }
            this.startHeartbeat();
            this.handleRoute();
        }

        // 心跳只续期，不重复绑定 pagehide（多次 start/stop 会叠出多个监听）
        startHeartbeat() {
            if (this.heartbeatTimer) return;
            this.heartbeatTimer = setInterval(() => {
                if (this.store.heartbeat(this.lockToken)) {
                    // 心跳同时刷新实例表：状态栏的「并行 N 个」靠它保持新鲜
                    this.store.pruneInstances();
                    return;
                }
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
                this.stopScrolling();
                this.state.isReading = false;
                this.commit();
                this.ui.toast('实例锁已被接管，已停止', 'bad');
            }, this.settings.heartbeatInterval);
        }

        stopHeartbeat() {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // ---------- 面板开关 ----------
        toggleReading() {
            if (this.state.isReading) this.stopReading();
            else this.startReading();
        }

        // 是否持有运行锁：isReading 的真实含义是「本标签页持锁并在推进」，
        // 两者脱钩就会出现两个标签页抢同一份未读队列。
        hasLock() {
            const rec = this.store.readLock();
            return !!rec && rec.token === this.lockToken;
        }

        // 同一个实例 id 上另有存活 token：只有同页重复注入、或浏览器把
        // sessionStorage 复制给了别的标签页时才会命中，此时才禁用「开始阅读」。
        // 自己没持锁（比如刚点过停止）不该禁用，否则按钮再也点不起来。
        lockedByOther() {
            const rec = this.store.readLock();
            return !!rec && rec.token !== this.lockToken && Date.now() - (rec.ts || 0) < this.settings.lockStale;
        }

        // 唯一的「开始」入口：先拿锁再置位，拿不到就明确告知，不假装在跑
        beginReading() {
            if (!this.store.acquireLock(this.lockToken)) {
                this.ui.toast('这个实例已经在别处运行，本页无法开始', 'bad');
                return false;
            }
            this.startHeartbeat();
            this.state.isReading = true;
            this.state.isPaused = false;
            return true;
        }

        startReading() {
            if (!this.beginReading()) {
                this.renderStatus();
                return;
            }
            this.store.flush();
            this.handleRoute();
            if (this.isTopicPage()) {
                this.startScrolling();
            } else if (window.location.pathname !== '/unseen') {
                // 不在帖子页也不在未读列表：先去未读列表，避免点了开始却毫无反应
                this.navigateToUnseen();
            }
            this.renderStatus();
        }

        stopReading() {
            this.state.isReading = false;
            this.state.isPaused = false;
            if (this.abortCtrl) this.abortCtrl.abort();
            this.stopScrolling();
            // 主动停下就交还运行锁：否则另一标签页永远拿不到，自己也不在推进
            this.stopHeartbeat();
            this.store.releaseLock(this.lockToken);
            // 交还当前帖的认领：停下就不再占着，别的实例可以立即接手
            this.store.releaseClaim(topicKey(location.pathname, this.settings.baseUrl));
            this.commit();
        }

        // 暂停：保留 isReading，仅停止滚动循环，随时可继续
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
            this.commit();
            if (this.state.isLiking && this.state.isReading && this.isTopicPage()) this.autoLike();
        }

        toggleCommenting() {
            this.state.autoCommentEnabled = !this.state.autoCommentEnabled;
            this.commit();
        }

        // ---------- 路由 ----------
        isTopicPage() {
            return /^\/t\//.test(window.location.pathname);
        }

        handleRoute() {
            // 用户手动访问 /unseen 时不再被脚本劫持
            if (window.location.pathname === '/unseen' && this.state.isReading) {
                this.collectUnseenLinks();
            } else if (this.isTopicPage() && this.state.isReading) {
                this.processTopic();
            }
        }

        collectUnseenLinks() {
            const all = Array.from(document.querySelectorAll(SEL.unseenLink), (a) => a.getAttribute('href'))
                .filter(Boolean)
                .slice(0, this.settings.unseenLimit);
            // 别的实例正在读的帖子先摘掉，避免两个标签页扑同一篇
            const links = this.store.unclaimed(all.map((h) => topicKey(h, this.settings.baseUrl)));
            if (!links.length) {
                this.stopReading();
                this.ui.toast(all.length ? '未读都已被其他实例认领，已停止' : '未发现未读内容，已停止', '');
                return;
            }
            this.state.unseenHrefs = links;
            this.store.flush();
            this.openNextTopic();
        }

        // 推进阅读游标的唯一出口。停止/暂停后必须原地不动：
        // autoReply 的 finally 与错误重试都会走到这里，否则「点停止反而跳走」。
        openNextTopic() {
            if (!this.state.isReading || this.state.isPaused) return;
            this.authorSeen = false;
            // 当前这篇读完了，先交还认领，别的实例马上就能接手
            this.store.releaseClaim(topicKey(location.pathname, this.settings.baseUrl));

            // 队列里的条目可能已被别的实例抢先认领，逐个往后找第一篇还空着的
            while (this.state.unseenHrefs.length) {
                const next = this.state.unseenHrefs.shift();
                const key = topicKey(next, this.settings.baseUrl);
                if (key && !this.store.claim(key)) continue;
                this.store.flush();
                window.location.href = new URL(next, this.settings.baseUrl).href;
                return;
            }
            this.state.isReading = false;
            this.commit();
            this.ui.toast('所有未读已处理完毕', 'ok');
            this.navigateToUnseen();
        }

        navigateToUnseen() {
            window.location.href = `${this.settings.baseUrl}/unseen?ascending=false&order=activity`;
        }

        processTopic() {
            if (this.isErrorPage()) {
                this.handleErrorPage();
                return;
            }
            if (!document.querySelector(SEL.post)) {
                this.openNextTopic();
                return;
            }
            // 成功进入正题：连续错误计数归零，否则偶发 404 会一路累加到「连续错误过多」
            this.state.errorRetries = 0;
            // 认领续期：这篇确实由本实例在读，别的实例看到新鲜 ts 就会跳过
            this.store.claim(topicKey(location.pathname, this.settings.baseUrl));
            this._likeTried = new Set();
            // 进帖先整页扫一遍：只要本话题里出现过自己的回复就不再评论
            this.authorSeen = this.hasOwnPost();
            this.startScrolling();
            if (this.state.isLiking) this.autoLike();
        }

        // ---------- 滚动阅读 ----------
        // 计时器驱动滚动，刻意不用 requestAnimationFrame：
        // rAF 由渲染帧调度，浏览器窗口失焦、被遮挡或切到后台时会被暂停（甚至完全不回调），
        // 表现为「没盯着浏览器就不滚了」。setTimeout 与焦点、可见性解耦，后台最多被
        // 浏览器降频到约 1 秒一次但不会停，能保证无人值守时继续阅读。
        startScrolling() {
            if (this.scrollTimer || !this.state.isReading || this.state.isPaused) return;

            // 每次重新进入一篇帖子都从头数：上一帖的宽限拍数不能带到这一帖
            this._noProgressTicks = 0;
            const baseInterval = () => Number(this.settings.scrollInterval) || 150;
            const graceTicks = () => {
                const n = Number(this.settings.noProgressGraceTicks);
                return Number.isFinite(n) && n > 0 ? n : 15;
            };
            const tick = () => {
                if (!this.state.isReading || this.state.isPaused) {
                    this.stopScrolling();
                    return;
                }
                window.scrollBy(0, this.settings.scrollSpeed);
                this.markReadPosts();

                // 读完判定：进度条追平（current >= total）即为已读完。只有滚动到底、
                // 全部楼层加载完才会显示 29/29，所以不需要再判物理底部或加超时兜底。
                const progress = topicProgress();
                if (progress) {
                    if (progress.done) {
                        this.stopScrolling();
                        this.onReachBottom();
                        return;
                    }
                    this._noProgressTicks = 0;
                } else {
                    // 单楼帖（只有楼主、没有任何回复）不渲染 .timeline-replies，进度条永远读不到。
                    // 真实页面是异步渲染的，刚进帖可能还没挂上进度条，所以给一小段宽限；
                    // 宽限拍数用完仍没有进度条，就当作读完，直接走切下篇流程，避免无限空滚。
                    this._noProgressTicks += 1;
                    if (this._noProgressTicks >= graceTicks()) {
                        this.stopScrolling();
                        this.onReachBottom();
                        return;
                    }
                }
                // 递归 setTimeout 排下一拍：带一点随机抖动，节奏不机械；
                // 每次只挂一个待执行计时器，stopScrolling 清掉的就是它。
                this.scrollTimer = setTimeout(tick, baseInterval() + Math.random() * 100);
            };
            this.scrollTimer = setTimeout(tick, baseInterval());
        }

        stopScrolling() {
            if (this.scrollTimer) {
                clearTimeout(this.scrollTimer);
                this.scrollTimer = null;
            }
        }

        async onReachBottom() {
            await sleep(randomBetween(600, 1500));
            if (!this.state.isReading || this.state.isPaused) return;
            if (this.state.autoCommentEnabled && !this.authorSeen) await this.autoReply();
            else this.openNextTopic();
        }

        // 当前话题里是否存在自己的回复（按 /u/xxx 的 href 比对，忽略大小写）
        hasOwnPost() {
            const me = selfUsername();
            if (!me) return false;
            return Array.from(document.querySelectorAll(SEL.postAuthor)).some(
                (a) => usernameFromHref(a.getAttribute('href')) === me
            );
        }

        // 节流 + 缓存节点列表，避免每帧 querySelectorAll 与强制回流
        markReadPosts() {
            const now = performance.now();
            if (now - this.lastMarkAt < this.settings.markReadInterval) return;
            this.lastMarkAt = now;

            if (!this._posts || now - this._postsAt > 1000) {
                this._posts = Array.from(document.querySelectorAll(SEL.post));
                this._postsAt = now;
            }

            const vh = window.innerHeight;
            for (const post of this._posts) {
                const rect = post.getBoundingClientRect();
                if (rect.top < 0 || rect.bottom > vh) continue;
                this.store.markPostRead(post.getAttribute('data-post-id'));
            }
            // 滚动过程中新加载出来的回复也要算进去
            if (!this.authorSeen && this.hasOwnPost()) this.authorSeen = true;
        }

        // ---------- 点赞 ----------
        // 只点「尚未点赞、本次未尝试过」的按钮；点击后必须等到状态翻转才记账。
        // 否则失败也计数烧配额，重试还会把刚点上的赞再点一次变成取消赞。
        likeTargets() {
            return Array.from(document.querySelectorAll(SEL.likeButton)).filter(
                (b) => !isLiked(b) && !this._likeTried.has(likeKey(b))
            );
        }

        async autoLike() {
            if (!this.state.isReading || !this.state.isLiking || this.state.isPaused) return;
            // 每日点赞配额用完：只关掉点赞，阅读继续
            if (!this.store.canLike()) {
                this.state.isLiking = false;
                this.commit();
                this.ui.toast(`已达到每日点赞上限（${this.settings.likeLimit} 次），点赞已停止，阅读继续`, '');
                return;
            }

            const btn = this.likeTargets()[0];
            // 本页暂时没有可点的赞：等下一页，保持沉默
            if (!btn) return;
            this._likeTried.add(likeKey(btn));
            btn.click();

            // 以服务端确认（class / aria-pressed 翻转）为准，超时视为没点上、不记账
            if (await waitFor(() => isLiked(btn), LIKE_CONFIRM_MS)) {
                this.store.recordAction({
                    url: window.location.href,
                    title: document.title,
                    liked: true,
                    commented: false,
                });
                this.commit();
            }

            await sleep(randomBetween(this.settings.likeIntervalMin, this.settings.likeIntervalMax));
            if (this.state.isReading && this.state.isLiking) this.autoLike();
        }

        // ---------- AI 评论 ----------
        async autoReply() {
            if (!this.state.isReading || this.state.isPaused || !this.state.autoCommentEnabled) return;
            // 每日评论配额用完：只关掉评论，阅读继续
            if (!this.store.canComment()) {
                this.state.autoCommentEnabled = false;
                this.commit();
                this.ui.toast(`已达到每日评论上限（${this.settings.commentLimit} 条），评论已停止，阅读继续`, '');
                this.openNextTopic();
                return;
            }
            if (!this.store.hasApiKey()) {
                this.ui.toast('未设置 API Key，跳过评论', 'bad');
                this.openNextTopic();
                return;
            }

            // 无论走哪条分支，最后都只调用一次 openNextTopic()，
            // 否则提前 return + finally 会连 shift 两次，白跳过一个未读帖。
            try {
                const openBtn = await waitForElm(SEL.replyOpen, this.settings.waitTimeout);
                if (!openBtn) throw new Error('未找到「回复」按钮，可能是权限不足或页面结构变化');
                openBtn.click();

                const textarea = await waitForElm(SEL.replyTextarea, this.settings.waitTimeout);
                if (!textarea) throw new Error('未找到回复输入框');

                const { title, context } = currentTopicContext();
                if (!title || !context) throw new Error('未取到当前帖子的标题或正文');

                this.abortCtrl = new AbortController();
                let comment = '';
                for (let i = 0; i < 3 && (!comment || comment.length < 5); i++) {
                    try {
                        comment = await generateComment({
                            title,
                            context,
                            settings: this.settings,
                            apiKey: this.store.getApiKey(),
                            signal: this.abortCtrl.signal,
                        });
                    } catch (e) {
                        console.warn('[auto-read] AI 生成失败：', e.message);
                    }
                }
                if (!comment || comment.length < 5) {
                    this.ui.toast('AI 未生成有效评论，跳过', '');
                    return;
                }

                textarea.focus();
                // 用原生 setter 触发 Discourse 的受控输入
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(textarea, comment);
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(300);

                const submit = await waitForElm(SEL.replySubmit, this.settings.waitTimeout);
                if (!submit) return;
                submit.click();
                this.store.recordAction({
                    url: window.location.href,
                    title,
                    liked: false,
                    commented: true,
                    commentContent: comment,
                });
                this.commit();
                await sleep(1200);
            } catch (e) {
                console.error('[auto-read] 自动评论失败：', e);
                this.ui.toast('自动评论失败，已跳过', 'bad');
            } finally {
                this.abortCtrl = null;
                this.openNextTopic();
            }
        }

        // ---------- 错误页 ----------
        isErrorPage() {
            return !!document.querySelector(SEL.errorMarker) || /找不到页面|页面不存在|404/.test(document.title);
        }

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

        // ---------- 状态栏 ----------
        renderStatus() {
            this.ui.renderStatus({
                selfName: selfUsername(),
                instanceId: this.instanceId,
                instanceCount: this.store.instanceCount(),
                locked: this.lockedByOther(),
                isReading: this.state.isReading,
                isPaused: this.state.isPaused,
                isLiking: this.state.isLiking,
                autoCommentEnabled: this.state.autoCommentEnabled,
                likeCount: this.store.getLikeCount(),
                likeLimit: this.settings.likeLimit,
                readCountToday: this.store.getReadCountToday(),
                readCountTotal: this.store.getReadCountTotal(),
                unseenCount: this.state.unseenHrefs.length,
                commentCount: this.store.getCommentCount(),
                commentLimit: this.settings.commentLimit,
                errorRetries: this.state.errorRetries,
                maxRetries: this.settings.maxRetries,
            });
        }

        // ---------- 日志 ----------
        openLog() {
            const wasReading = this.state.isReading;
            this.stopScrolling();
            this.state.isReading = false;
            this.commit();

            const entries = this.state.actionLog.slice();
            this.ui.showLog({
                entries,
                readCountToday: this.store.getReadCountToday(),
                readCountTotal: this.store.getReadCountTotal(),
                handlers: {
                    exportCsv: () => {
                        const head = ['时间', '标题', '是否点赞', '评论内容', '链接'].map(csvCell).join(',');
                        const body = entries.map((e) =>
                            [
                                e.time ? new Date(e.time).toLocaleString() : '',
                                e.title || '',
                                e.liked ? '是' : '否',
                                e.commentContent || '',
                                e.url || '',
                            ]
                                .map(csvCell)
                                .join(',')
                        );
                        downloadFile(
                            `auto-read-log-${Date.now()}.csv`,
                            '\ufeff' + [head, ...body].join('\r\n'),
                            'text/csv;charset=utf-8'
                        );
                        this.ui.toast('已导出 CSV', 'ok');
                    },
                    clear: async () => {
                        if (!(await this.ui.confirm('确定清空全部日志吗？此操作不可撤销。'))) return;
                        this.store.clearActionLog();
                        this.ui.closeLog();
                        this.openLog();
                    },
                    close: () => {
                        this.ui.closeLog();
                        // 走统一入口重新确认锁，避免日志期间锁被别人接管却假装在跑
                        if (wasReading) this.startReading();
                        this.renderStatus();
                    },
                },
            });
        }

        // ---------- 设置 ----------
        openSettings() {
            this.ui.showSettings({
                settings: this.settings,
                hasApiKey: this.store.hasApiKey(),
                instanceId: this.instanceId,
                instanceCount: this.store.instanceCount(),
                readCountToday: this.store.getReadCountToday(),
                readCountTotal: this.store.getReadCountTotal(),
                handlers: {
                    save: ({ apiKey, ...rest }) => {
                        try {
                            // 保存时就校验：地址写错在这里拦下，而不是等半夜静默失败
                            const ai = validateAiSettings(rest);
                            this.store.updateSettings(Object.assign({}, rest, ai));
                            if (apiKey) this.store.setApiKey(apiKey);
                        } catch (e) {
                            this.ui.toast(String((e && e.message) || e || '保存失败'), 'bad');
                            return;
                        }
                        this.ui.closeSettings();
                        this.ui.toast('设置已保存', 'ok');
                        this.renderStatus();
                    },
                    dropKey: () => {
                        this.store.setApiKey('');
                        this.ui.toast('已删除本地 API Key', 'ok');
                    },
                    resetCount: () => {
                        this.store.resetReadCount();
                        this.ui.toast('已读计数已清零', 'ok');
                        this.renderStatus();
                    },
                    // 测试 AI 回复：不写设置、不发帖，只把「当前帖子标题 + 正文前 500 字」发一次请求
                    testReply: async ({ aiUrl, aiModel, apiKey }) => {
                        const key = normalizeSecret(apiKey) || this.store.getApiKey();
                        if (!key) throw new Error('未设置 API Key：请在上面填写，或先保存设置');
                        assertHeaderSafe(key, 'API Key');
                        const ai = validateAiSettings({ aiUrl, aiModel });
                        const { title, context } = currentTopicContext();
                        if (!context) throw new Error('未取到帖子正文，请先打开一个帖子再测试');
                        const settings = Object.assign({}, this.settings, ai);
                        const ctrl = new AbortController();
                        const timer = setTimeout(() => ctrl.abort(), 30000);
                        try {
                            const comment = await generateComment({
                                title,
                                context,
                                settings,
                                apiKey: key,
                                signal: ctrl.signal,
                            });
                            if (!comment) throw new Error('AI 返回内容为空或未按格式给出评论');
                            return { title, context, model: ai.aiModel, comment };
                        } catch (e) {
                            if (e && e.name === 'AbortError') throw new Error('请求超时（30 秒）');
                            throw e;
                        } finally {
                            clearTimeout(timer);
                        }
                    },
                    // 新开一个并行实例：新标签页会自己领一个 id，队列与进度独立
                    newInstance: () => {
                        window.open(`${this.settings.baseUrl}/`, '_blank');
                        this.ui.toast('已打开新标签页，那边会是一个独立实例', 'ok');
                    },
                    // 回收心跳已停的实例，连带删掉它们留在存储里的进度
                    prune: () => {
                        const ids = this.store.pruneInstances();
                        this.ui.toast(`已清理失效实例，当前并行 ${ids.length} 个`, 'ok');
                        this.renderStatus();
                        return ids.length;
                    },
                    close: () => this.ui.closeSettings(),
                },
            });
        }
    }

    // ===================== 入口 =====================
    function boot() {
        try {
            // 先发号再建 Store：此后所有读写都挂在这个实例 id 上
            const instanceId = resolveInstanceId();
            const store = new Store({ instanceId });
            const ui = new UI({ instanceId });
            const reader = new Reader({ store, ui });
            reader.start();
            // 便于在控制台调试，也让测试能直接验证纯函数
            // 调试出口只暴露只读快照：真实 store 里有 API Key，
            // 整个挂到 window 上，只要有人改成 @grant none 就变成一行提权。
            window.__autoRead = {
                ui,
                reader,
                instanceId,
                shortId,
                store: {
                    getSettings: () => Object.assign({}, store.settings),
                    getState: () => JSON.parse(JSON.stringify(store.state)),
                    hasApiKey: () => store.hasApiKey(),
                    apiKeyMasked: () => {
                        const k = store.getApiKey();
                        // 短 Key 首尾各留一段就等于全泄露，直接整体打码
                        return k ? (k.length <= 8 ? '***' : `${k.slice(0, 3)}***${k.slice(-2)}`) : '';
                    },
                },
                utils: {
                    csvCell,
                    parseComment,
                    textOf,
                    topicProgress,
                    currentTopicContext,
                    normalizeSecret,
                    assertHeaderSafe,
                    findNonLatin1,
                    validateAiSettings,
                    safeHref,
                    isLiked,
                    generateComment,
                    resolveInstanceId,
                    newInstanceId,
                    shortId,
                    topicKey,
                },
            };
        } catch (e) {
            console.error('[auto-read] 启动失败：', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
