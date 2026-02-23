// ==UserScript==
// @name         Auto Read (Linux.do Only)
// @namespace    http://tampermonkey.net/
// @version      2.4.3
// @description  自动刷阅读回复，仅支持Linux.do社区
// @author       XinSong(https://blog.warhut.cn)自
// @match        https://linux.do/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @license      MIT
// @icon         https://www.google.com/s2/favicons?domain=linux.do
// ==/UserScript==

(() => {
    'use strict';
    // 挂载全局对象（避免作用域污染）
    const { document, window } = unsafeWindow;

    // 默认配置（首次运行时使用）
    const DEFAULT_CONFIG = {
        BASE_URL: 'https://linux.do',          // 基础URL
        LIKE_LIMIT: 20,                      // 每日点赞上限
        MAX_RETRIES: 3,                      // 错误页面最大重试次数
        SCROLL_OPTIONS: {                    // 滚动配置
            speed: 200,                      // 滚动速度（像素/次）
            interval: 500,                   // 滚动间隔（毫秒）
        },
        LIKE_INTERVAL: {                     // 点赞间隔配置
            min: 5000,                       // 最小间隔（毫秒）
            max: 5000                        // 最大间隔（毫秒）
        },
        UPDATE_INTERVAL: 500                // 状态更新间隔（毫秒）
    };

    // 从GM存储加载配置（如果不存在则使用默认值）
    const loadConfig = () => {
        const savedConfig = GM_getValue('userConfig');
        if (savedConfig) {
            return JSON.parse(savedConfig);
        }
        // 首次运行，保存默认配置
        GM_setValue('userConfig', JSON.stringify(DEFAULT_CONFIG));
        return DEFAULT_CONFIG;
    };

    // 保存配置到GM存储
    const saveConfig = (config) => {
        GM_setValue('userConfig', JSON.stringify(config));
    };

    // 加载配置
    const CONFIG = loadConfig();

    /**
     * 状态管理类
     * 负责本地存储管理和状态初始化
     */
    class StateManager {
        constructor() {
            this.initState();          // 初始化默认状态
            this.loadFromStorage();    // 从本地存储加载状态
        }

        // 初始化默认状态
        initState() {
            this.isReading = false;        // 是否正在阅读
            this.isLiking = false;         // 是否启用自动点赞
            this.isPanelHidden = false;    // 是否隐藏面板
            this.errorRetries = 0;         // 错误页面重试次数
            this.unseenHrefs = [];         // 未读帖子链接列表
            this.currentTask = null;       // 当前任务（导航/滚动等）
            this.scrollTimer = null;       // 滚动定时器
        }

        // 从GM存储加载状态
        loadFromStorage() {
            // 解析存储的状态对象，默认空对象
            const state = JSON.parse(GM_getValue('autoReadState', '{}'));
            // 合并默认状态与存储状态
            Object.assign(this, {
                isReading: !!state.isReading,        // 布尔值转换
                isLiking: state.isLiking ?? false,    // 安全默认值
                isPanelHidden: state.isPanelHidden ?? false, // 面板隐藏状态
                errorRetries: state.errorRetries || 0,
                unseenHrefs: state.unseenHrefs || []
            });
            this.resetLikeCounter();  // 重置每日点赞计数
        }

        // 保存状态到GM存储
        saveToStorage() {
            GM_setValue('autoReadState', JSON.stringify(this));
        }

        // 每日点赞计数重置（超过24小时）
        resetLikeCounter() {
            const lastUpdate = GM_getValue('likeTimestamp');
            if (lastUpdate && Date.now() - +lastUpdate > 86400000) { // 86400000ms = 24小时
                GM_setValue('likeCount', 0);       // 重置计数
                GM_setValue('likeTimestamp', Date.now()); // 更新时间戳
            }
        }
    }

    /**
     * 自动阅读核心类
     * 负责业务逻辑处理和用户交互
     */
    class AutoReader {
        constructor() {
            this.state = new StateManager();  // 初始化状态管理器
            this.init();                      // 初始化脚本
        }

        // 初始化入口
        init() {
            window.addEventListener('load', () => {
                this.createControlPanel();   // 创建控制面板
                this.handleRoute();          // 处理当前路由
                setInterval(() => this.updateStatus(), CONFIG.UPDATE_INTERVAL); // 定期更新状态
            });
        }

        /**
         * 路由处理
         * 根据当前页面路径执行不同逻辑
         */
        handleRoute() {
            if (window.location.pathname === '/unseen') { // 未读页面
                this.fetchUnseenLinks();  // 获取未读链接
            } else if (this.state.isReading) { // 阅读中状态
                this.processCurrentPage();  // 处理当前页面内容
            }
        }

        /**
         * 获取未读帖子链接
         */
        fetchUnseenLinks() {
            // 使用CSS选择器获取所有未读帖子链接
            const links = Array.from(document.querySelectorAll('a.title.raw-link.raw-topic-link'))
                .map(link => link.getAttribute('href'));  // 提取链接

            if (links.length) { // 存在未读链接
                this.state.unseenHrefs = links;            // 更新状态
                this.state.saveToStorage();                // 保存到本地
                this.openNextTopic();                     // 打开下一个帖子
            } else { // 无未读内容
                alert('未发现未读内容');
            }
        }

        /**
         * 打开下一个帖子
         */
        openNextTopic() {
            const nextUrl = this.state.unseenHrefs.shift(); // 取出队列中第一个链接
            if (nextUrl) { // 存在有效链接
                this.state.currentTask = 'navigating';      // 设置任务状态为导航
                this.state.saveToStorage();                // 保存状态
                window.location.href = `${CONFIG.BASE_URL}${nextUrl}`; // 跳转页面
            } else { // 链接队列已空
                this.navigateToUnseen();                    // 回到未读页面重新获取
            }
        }

        /**
         * 处理当前页面内容（阅读逻辑）
         */
        processCurrentPage() {
            if (this.isErrorPage()) return this.handleError(); // 先检查错误页面

            // 判断是不是帖子详情页，如果不是，打开第一个未读链接
            if (!document.querySelector('article[data-post-id]')) {
                this.openNextTopic();
                return;
            }
            // 判断是否存在返回上次阅读的按钮
            const backButton = document.querySelector('[title="返回上一个未读帖子"]');
            if (backButton) {
                backButton.click(); // 点击按钮返回
            }

            // 获取当前页面所有帖子
            this.state.posts = Array.from(document.querySelectorAll('article[data-post-id]'));
            this.state.currentTask = 'scrolling';             // 设置任务状态为滚动
            this.startSmoothScroll();                         // 启动平滑滚动
            if (this.state.isLiking) this.runAutoLike();       // 启用点赞则执行点赞逻辑
        }

        /**
         * 启动平滑滚动
         */
        startSmoothScroll() {
            if (this.state.scrollTimer) return; // 避免重复启动

            // 滚动速度（像素/次）
            const scrollSpeed = CONFIG.SCROLL_OPTIONS.speed;

            // 使用 setTimeout 实现滚动（支持后台运行）
            const scrollStep = () => {
                window.scrollBy(0, scrollSpeed); // 执行滚动

                // 判断是否阅读完毕
                const divReplies = document.querySelector('div.timeline-replies'); // 查找底部元素
                if (divReplies) {
                    const parts = divReplies.textContent.trim().replace(/[^0-9/]/g, '').split('/');
                    // 判断是否相等（如：1/1），表示已到达底部
                    if (parts.length >= 2 && parts[0] === parts[1]) {
                        this.stopScrolling();       // 停止滚动
                        this.openNextTopic();       // 打开下一个帖子
                        return;
                    }
                }

                this.markReadPosts();           // 标记已读帖子
                
                // 设置下一次滚动
                this.state.scrollTimer = setTimeout(scrollStep, CONFIG.SCROLL_OPTIONS.interval);
            };

            // 开始滚动
            scrollStep();
        }

        /**
         * 停止滚动
         */
        stopScrolling() {
            if (this.state.scrollTimer) {
                clearTimeout(this.state.scrollTimer); // 取消定时器
                this.state.scrollTimer = null;         // 重置定时器引用
            }
            this.state.currentTask = null;         // 清除当前任务
        }

        /**
         * 标记可见帖子为已读
         */
        markReadPosts() {
            document.querySelectorAll('article[data-post-id]').forEach(post => {
                const rect = post.getBoundingClientRect(); // 获取元素位置信息
                // 元素完全在视口内时并且是已读状态，标记为已读，
                if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
                    post.classList.add('read-state'); // 添加已读类
                }
            });
        }

        /**
         * 自动点赞逻辑（递归调用实现随机间隔）
         */
        runAutoLike() {
            const likeCount = parseInt(GM_getValue('likeCount', 0)); // 当前点赞数
            if (likeCount >= CONFIG.LIKE_LIMIT) return; // 达到上限则停止

            // 查找未点赞的按钮（优先使用明确的选择器）
            const likeButton = document.querySelector('.discourse-reactions-reaction-button:not(.liked)');
            if (likeButton) {
                likeButton.click(); // 模拟点击
                // 更新点赞计数和时间戳
                GM_setValue('likeCount', likeCount + 1);
                GM_setValue('likeTimestamp', Date.now());
                // 生成随机间隔（递归调用实现链式延迟）
                const randomDelay = Math.random() * (CONFIG.LIKE_INTERVAL.max - CONFIG.LIKE_INTERVAL.min) + CONFIG.LIKE_INTERVAL.min;
                setTimeout(() => this.runAutoLike(), randomDelay);
            }
        }

        /**
         * 检测是否为错误页面
         * @returns {boolean} 是否为404页面
         */
        isErrorPage() {
            return document.title.includes('找不到页面');
        }

        /**
         * 错误页面处理
         */
        handleError() {
            this.state.errorRetries++; // 重试次数加一

            if (this.state.errorRetries > CONFIG.MAX_RETRIES) { // 超过最大重试次数
                this.resetState();                             // 重置所有状态
                return;
            }
            this.openNextTopic(); // 尝试打开下一个帖子
        }

        /**
         * 重置所有状态（用于错误处理或用户重置）
         */
        resetState() {
            this.state.initState(); // 恢复初始状态
            this.state.saveToStorage(); // 保存到本地
        }

        /**
         * 创建控制面板
         */
        createControlPanel() {
            const host = document.createElement('div'); // Shadow host
            host.id = 'auto-read-root';
            const shadowRoot = host.attachShadow({ mode: 'open' });
            this.uiRoot = shadowRoot;

            shadowRoot.innerHTML = `
                <style>
                    :host { all: initial; }
                    .panel {
                        position: fixed;
                        bottom: 16px;
                        left: 16px;
                        z-index: 9999;
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
                        transition: opacity 0.3s ease, transform 0.3s ease;
                    }
                    .panel.hidden {
                        opacity: 0;
                        transform: translateX(-100%);
                        pointer-events: none;
                    }
                    .btn {
                        padding: 8px 16px;
                        border-radius: 10px;
                        border: 1px solid #e5e7eb;
                        background: #ffffff;
                        color: #111827;
                        font-weight: 700;
                        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
                        cursor: pointer;
                        transition: transform 0.2s ease, box-shadow 0.2s ease;
                    }
                    .btn:hover {
                        transform: scale(1.04);
                        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16);
                    }
                    .status {
                        position: fixed;
                        top: 80px;
                        left: 20px;
                        z-index: 9999;
                        background: #ffffff;
                        border-radius: 10px;
                        padding: 8px 10px;
                        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
                        font-size: 12px;
                        color: #111827;
                        transition: opacity 0.3s ease, transform 0.3s ease;
                    }
                    .status.hidden {
                        opacity: 0;
                        transform: translateX(-100%);
                        pointer-events: none;
                    }
                    .status strong { font-weight: 700; }
                    .ok { color: #16a34a; font-weight: 700; }
                    .bad { color: #dc2626; font-weight: 700; }
                </style>
                <div class="panel" id="auto-read-controls"></div>
                <div class="status" id="auto-read-status"></div>
            `;

            const controls = shadowRoot.getElementById('auto-read-controls'); // 容器元素

            // 创建阅读控制按钮
            this.createControlButton(controls, 'openRead', '开始阅读', '停止阅读', () => {
                this.state.isReading = !this.state.isReading; // 切换阅读状态
                this.state.saveToStorage();                   // 保存状态
                this.state.isReading ? this.processCurrentPage() : this.stopScrolling();// 根据状态执行相应操作
                this.updateStatus();// 更新状态
                this.uiRoot.getElementById('openRead').textContent = this.state.isReading ? '停止阅读' : '开始阅读';// 更新按钮文本
            });

            // 创建点赞控制按钮
            this.createControlButton(controls, 'openUP', '启用点赞', '禁用点赞', () => {
                this.state.isLiking = !this.state.isLiking; // 切换点赞状态
                this.state.saveToStorage();                 // 保存状态
                this.updateStatus(); // 更新状态
                this.uiRoot.getElementById('openUP').textContent = this.state.isLiking ? '禁用点赞' : '启用点赞';// 更新按钮文本
            });

            // 创建重置列表按钮
            this.createControlButton(controls, 'resetList', '重置列表', '重置列表', () => {
                if (confirm('确定要重置未读列表吗？')) { // 确认提示
                    this.resetState();                     // 重置状态
                    alert('未读列表已重置');
                }
            });

            // 创建隐藏面板按钮
            this.createControlButton(controls, 'hidePanel', '隐藏面板', '隐藏面板', () => {
                this.togglePanel();
            });

            // 创建配置中心按钮
            this.createControlButton(controls, 'configCenter', '配置中心', '配置中心', () => {
                this.openConfigDialog();
            });

            // 创建状态显示面板
            this.updateStatus(); // 初始化状态显示

            // 应用初始隐藏状态
            this.applyPanelVisibility();

            // 注册脚本菜单命令
            this.registerMenuCommands();

            document.body.appendChild(host); // 添加到页面
        }

        /**
         * 注册Tampermonkey菜单命令
         */
        registerMenuCommands() {
            // 保存菜单命令ID以便后续更新
            this.menuCommandId = GM_registerMenuCommand(
                this.state.isPanelHidden ? '📱 显示面板' : '🙈 隐藏面板',
                () => {
                    this.togglePanel();
                    // 注销旧菜单命令并重新注册
                    if (this.menuCommandId) {
                        GM_unregisterMenuCommand(this.menuCommandId);
                    }
                    this.registerMenuCommands();
                }
            );
        }

        /**
         * 切换面板显示/隐藏
         */
        togglePanel() {
            this.state.isPanelHidden = !this.state.isPanelHidden;
            this.state.saveToStorage();
            this.applyPanelVisibility();
        }

        /**
         * 应用面板可见性状态
         */
        applyPanelVisibility() {
            const panel = this.uiRoot?.getElementById('auto-read-controls');
            const status = this.uiRoot?.getElementById('auto-read-status');

            if (this.state.isPanelHidden) {
                panel?.classList.add('hidden');
                status?.classList.add('hidden');
            } else {
                panel?.classList.remove('hidden');
                status?.classList.remove('hidden');
            }
        }

        /**
         * 打开配置对话框
         */
        openConfigDialog() {
            const dialogHTML = `
                <div style="
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: white;
                    padding: 24px;
                    border-radius: 12px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    z-index: 10000;
                    min-width: 400px;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                ">
                    <h3 style="margin: 0 0 20px 0; color: #111827;">⚙️ 配置中心</h3>

                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 6px; color: #6b7280; font-weight: 600; font-size: 13px;">
                            每日点赞上限
                        </label>
                        <input type="number" id="config-like-limit" value="${CONFIG.LIKE_LIMIT}"
                            style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                    </div>

                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 6px; color: #6b7280; font-weight: 600; font-size: 13px;">
                            错误重试次数
                        </label>
                        <input type="number" id="config-max-retries" value="${CONFIG.MAX_RETRIES}"
                            style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                    </div>

                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 6px; color: #6b7280; font-weight: 600; font-size: 13px;">
                            滚动速度（像素/次）
                        </label>
                        <input type="number" id="config-scroll-speed" value="${CONFIG.SCROLL_OPTIONS.speed}"
                            style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                    </div>

                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 6px; color: #6b7280; font-weight: 600; font-size: 13px;">
                            滚动间隔（毫秒）
                        </label>
                        <input type="number" id="config-scroll-interval" value="${CONFIG.SCROLL_OPTIONS.interval}"
                            style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                    </div>

                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 6px; color: #6b7280; font-weight: 600; font-size: 13px;">
                            点赞最小间隔（毫秒）
                        </label>
                        <input type="number" id="config-like-min" value="${CONFIG.LIKE_INTERVAL.min}"
                            style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 6px; color: #6b7280; font-weight: 600; font-size: 13px;">
                            点赞最大间隔（毫秒）
                        </label>
                        <input type="number" id="config-like-max" value="${CONFIG.LIKE_INTERVAL.max}"
                            style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                    </div>

                    <div style="display: flex; gap: 12px; justify-content: flex-end;">
                        <button id="config-cancel" style="
                            padding: 8px 20px;
                            border: 1px solid #d1d5db;
                            background: white;
                            color: #6b7280;
                            border-radius: 6px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 14px;
                        ">取消</button>
                        <button id="config-save" style="
                            padding: 8px 20px;
                            border: none;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            border-radius: 6px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 14px;
                        ">保存</button>
                    </div>
                </div>

                <div id="config-overlay" style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    z-index: 9999;
                "></div>
            `;

            // 创建对话框容器
            const dialogContainer = document.createElement('div');
            dialogContainer.id = 'config-dialog-container';
            dialogContainer.innerHTML = dialogHTML;
            document.body.appendChild(dialogContainer);

            // 绑定按钮事件
            document.getElementById('config-save').addEventListener('click', () => {
                this.saveConfigFromDialog();
                document.body.removeChild(dialogContainer);
            });

            document.getElementById('config-cancel').addEventListener('click', () => {
                document.body.removeChild(dialogContainer);
            });

            document.getElementById('config-overlay').addEventListener('click', () => {
                document.body.removeChild(dialogContainer);
            });
        }

        /**
         * 从对话框保存配置
         */
        saveConfigFromDialog() {
            const newConfig = {
                BASE_URL: CONFIG.BASE_URL,
                LIKE_LIMIT: parseInt(document.getElementById('config-like-limit').value),
                MAX_RETRIES: parseInt(document.getElementById('config-max-retries').value),
                SCROLL_OPTIONS: {
                    speed: parseInt(document.getElementById('config-scroll-speed').value),
                    interval: parseInt(document.getElementById('config-scroll-interval').value),
                },
                LIKE_INTERVAL: {
                    min: parseInt(document.getElementById('config-like-min').value),
                    max: parseInt(document.getElementById('config-like-max').value),
                },
                UPDATE_INTERVAL: CONFIG.UPDATE_INTERVAL
            };

            // 保存到GM存储
            saveConfig(newConfig);

            // 更新全局CONFIG对象
            Object.assign(CONFIG, newConfig);

            alert('配置已保存！刷新页面后生效。');
        }

        /**
         * 创建通用控制按钮
         * @param {HTMLElement} parent - 父容器
         * @param {string} id - 唯一ID
         * @param {string} startText - 初始文本
         * @param {string} stopText - 激活后文本
         * @param {Function} onClick - 点击事件处理函数
         */
        createControlButton(parent, id, startText, stopText, onClick) {
            const button = document.createElement('button'); // 创建按钮元素
            // 基础样式
            button.id = id;
            button.className = 'btn';
            // 初始文本（根据当前状态判断）
            button.textContent = this.state.isReading && startText === '开始阅读' ? stopText : startText;
            button.addEventListener('click', onClick); // 绑定点击事件
            parent.appendChild(button); // 添加到父容器
        }

        /**
         * 更新状态显示面板
         */
        updateStatus() {
            const status = this.uiRoot?.getElementById('auto-read-status');
            if (!status) return; // 面板不存在时返回

            const likeCount = parseInt(GM_getValue('likeCount', 0)); // 获取点赞计数
            // 使用模板字符串更新面板内容
            status.innerHTML = `
                <div>
                    阅读状态：${this.state.isReading ? '<span class="ok">运行中</span>' : '<span class="bad">已停止</span>'}<br />
                    点赞状态：${this.state.isLiking ? '<span class="ok">启用</span>' : '<span class="bad">禁用</span>'}<br />
                    今日点赞：${likeCount}/${CONFIG.LIKE_LIMIT}<br />
                    剩余帖子：${this.state.unseenHrefs.length}<br />
                    错误重试：<span class="bad">${this.state.errorRetries}/${CONFIG.MAX_RETRIES}</span>
                </div>
            `;
        }

        /**
         * 导航到未读页面
         */
        navigateToUnseen() {
            window.location.href = `${CONFIG.BASE_URL}/unseen`; // 跳转URL
        }
    }

    // 初始化脚本入口
    new AutoReader();
})();
