// ==UserScript==
// @name         Auto Read (Linux.do Only)
// @namespace    http://tampermonkey.net/
// @version      1.5.2
// @description  自动刷文章工具，仅支持Linux.do社区，使用DOM获取未读帖子
// @author       XinSong(https://blog.warhut.cn)
// @match        https://linux.do/*
// @grant        unsafeWindow
// @license      MIT
// @icon         https://www.google.com/s2/favicons?domain=linux.do
// @require      https://cdn.tailwindcss.com
// ==/UserScript==

(function() {
    'use strict';
    const window = unsafeWindow;

    // 配置参数
    const possibleBaseURLs = ["https://linux.do"];
    const likeLimit = 50;
    const maxRetries = 3;         // 访问错误页面后的最大重试次数
    const retryDelay = 3000;      // 错误页面重试延迟(毫秒)
    const scrollCheckDelay = 2000; // 滚动检查间隔(毫秒)
    const pageLoadTimeout = 10000; // 页面加载超时时间(毫秒)
    const scrollSpeed = 50;       // 滚动速度(像素/次)

    // 确定当前BASE_URL
    let BASE_URL = possibleBaseURLs.find((url) => window.location.href.startsWith(url)) || possibleBaseURLs[0];
    console.log("脚本运行在:", BASE_URL);

    // 状态变量
    let scriptState = {
        isReading: false,
        isLiking: false,
        currentTask: null,
        errorRetries: 0,
        currentPostIndex: 0,
        posts: [],
        unseenHrefs: [], // 存储未读帖子链接
        pageLoadTimer: null,
        isProcessingError: false,
        scrollInterval: null, // 滚动计时器
        isScrolling: false,   // 是否正在滚动
        lastScrollPosition: 0 // 上次滚动位置
    };

    // 初始化存储数据
    function initStorage() {
        if (!localStorage.getItem("isFirstRun")) {
            console.log("首次运行，初始化存储数据...");
            localStorage.setItem("isFirstRun", "false");
            localStorage.setItem("read", "false");
            localStorage.setItem("autoLikeEnabled", "false");
            localStorage.setItem("errorPageRetries", "0");
            localStorage.setItem("clickCounter", "0");
            localStorage.setItem("clickCounterTimestamp", Date.now().toString());
            localStorage.setItem("unseenHrefs", "[]"); // 初始化未读链接存储
        }

        // 恢复状态
        scriptState.isReading = localStorage.getItem("read") === "true";
        scriptState.isLiking = localStorage.getItem("autoLikeEnabled") !== "false";
        scriptState.errorRetries = parseInt(localStorage.getItem("errorPageRetries") || "0", 10);
        scriptState.unseenHrefs = JSON.parse(localStorage.getItem("unseenHrefs") || "[]"); // 加载未读链接

        // 恢复点赞计数器
        const clickCounter = parseInt(localStorage.getItem("clickCounter") || "0", 10);
        const clickTimestamp = parseInt(localStorage.getItem("clickCounterTimestamp") || "0", 10);

        if (clickTimestamp && Date.now() - clickTimestamp > 24 * 60 * 60 * 1000) {
            localStorage.setItem("clickCounter", "0");
            localStorage.setItem("clickCounterTimestamp", Date.now().toString());
            console.log("点赞计数器已重置(超过24小时)");
        }
    }

    // 从/unseen页面获取未读链接
    function fetchUnseenHrefs() {
        return new Promise(resolve => {
            const hrefs = Array.from(document.querySelectorAll('a.title.raw-link.raw-topic-link'))
                .map(link => link.getAttribute('href'));

            scriptState.unseenHrefs = hrefs;
            localStorage.setItem("unseenHrefs", JSON.stringify(hrefs));
            console.log(`成功获取 ${hrefs.length} 个未读帖子链接`);

            // 如果没有获取到链接，提示用户
            if (hrefs.length === 0) {
                alert("未找到未读帖子，请确保您有未读内容");
                scriptState.isReading = false;
                localStorage.setItem("read", "false");
                updateButtonStates();
            }

            resolve(hrefs);
        });
    }

    // 平滑滚动页面
    function smoothScroll() {
        if (!scriptState.isReading || scriptState.isProcessingError) return;

        // 检查是否是错误页面
        if (isErrorPage()) {
            handleErrorPage();
            return;
        }

        const currentPosition = window.scrollY;
        const bottomThreshold = document.body.offsetHeight - window.innerHeight - 100;

        // 更新状态面板
        if (!scriptState.isScrolling) {
            scriptState.isScrolling = true;
            updateStatusPanel();
        }

        // 如果已经滚动到底部
        if (currentPosition >= bottomThreshold) {
            console.log("已滚动到底部，准备打开下一个帖子");
            stopScrolling();
            openNewTopic();
            return;
        }

        // 记录滚动位置
        scriptState.lastScrollPosition = currentPosition;

        // 继续向下滚动
        window.scrollBy(0, scrollSpeed);

        // 检查帖子状态
        checkPostsVisibility();
    }

    // 开始平滑滚动
    function startScrolling() {
        if (scriptState.scrollInterval) clearInterval(scriptState.scrollInterval);
        scriptState.isScrolling = true;
        scriptState.scrollInterval = setInterval(smoothScroll, 100);
        updateStatusPanel();
    }

    // 停止平滑滚动
    function stopScrolling() {
        if (scriptState.scrollInterval) {
            clearInterval(scriptState.scrollInterval);
            scriptState.scrollInterval = null;
        }
        if (scriptState.isScrolling) {
            scriptState.isScrolling = false;
            updateStatusPanel();
        }
    }

    // 检查帖子可见性
    function checkPostsVisibility() {
        if (!scriptState.isReading || !scriptState.isScrolling) return;

        const posts = document.querySelectorAll('article[data-post-id]');
        posts.forEach(post => {
            const rect = post.getBoundingClientRect();
            // 如果帖子在视口中
            if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
                // 标记为已读
                const readState = post.querySelector('.read-state');
                if (readState && !readState.classList.contains('read')) {
                    readState.classList.add('read');
                }
            }
        });
    }

    // 打开新话题
    function openNewTopic() {
        // 清除所有计时器
        stopScrolling();
        clearTimeout(scriptState.pageLoadTimer);
        scriptState.posts = [];
        scriptState.currentPostIndex = 0;

        // 检查是否是错误页面
        if (isErrorPage()) {
            handleErrorPage();
            return;
        }

        // 未读链接为空时加载新列表
        if (scriptState.unseenHrefs.length === 0) {
            console.log("未读链接列表为空，加载新列表...");
            navigateToUrl(`${BASE_URL}/unseen`); // 导航到未读页面
            return;
        }

        // 取出下一个链接
        const href = scriptState.unseenHrefs.shift();
        const topicUrl = `${BASE_URL}${href}`;

        console.log(`打开帖子: ${topicUrl}`);
        console.log(`剩余帖子: ${scriptState.unseenHrefs.length}`);

        // 更新本地存储
        localStorage.setItem("unseenHrefs", JSON.stringify(scriptState.unseenHrefs));

        // 导航到新帖子
        navigateToUrl(topicUrl);
    }

    // 安全导航到URL
    function navigateToUrl(url) {
        scriptState.currentTask = "navigating";
        scriptState.isScrolling = false;
        updateStatusPanel();

        clearTimeout(scriptState.pageLoadTimer);
        scriptState.pageLoadTimer = setTimeout(() => {
            console.log("页面加载超时，尝试下一个帖子");
            if (scriptState.isReading) openNewTopic();
        }, pageLoadTimeout);

        window.location.href = url;
    }

    // 页面加载完成处理
    window.addEventListener("load", async () => {
        initStorage();
        createControlButtons();

        // 处理未读页面加载
        if (window.location.pathname === '/unseen') {
            console.log("当前在未读页面，开始获取未读帖子链接");
            await fetchUnseenHrefs();

            // 如果获取到链接，开始阅读
            if (scriptState.unseenHrefs.length > 0) {
                console.log("获取到未读帖子链接，开始阅读流程");
                openNewTopic();
            }
            return;
        }

        // 如果处于阅读状态且不在未读页面
        if (scriptState.isReading) {
            if (isErrorPage()) {
                handleErrorPage();
            } else {
                // 开始处理帖子并滚动阅读
                processPosts();
                startScrolling();

                // 如果启用了自动点赞，开始点赞
                if (scriptState.isLiking) {
                    setTimeout(autoLike, 5000);
                }
            }
        }
    });

    // 检测是否是错误页面
    function isErrorPage() {
        const pageTitle = document.title || '';
        return pageTitle.includes('找不到页面 - LINUX DO');
    }

    // 处理错误页面
    function handleErrorPage() {
        if (scriptState.isProcessingError) return;

        scriptState.isProcessingError = true;
        console.log("检测到错误页面，开始处理...");

        // 增加重试计数
        scriptState.errorRetries++;
        localStorage.setItem("errorPageRetries", scriptState.errorRetries.toString());

        // 更新状态面板
        updateStatusPanel();

        // 如果达到最大重试次数，重置话题列表
        if (scriptState.errorRetries >= maxRetries) {
            console.log(`已达到最大重试次数(${maxRetries})，重置未读列表`);
            scriptState.errorRetries = 0;
            scriptState.unseenHrefs = [];
            localStorage.setItem("errorPageRetries", "0");
            localStorage.setItem("unseenHrefs", "[]");
        }

        // 延迟后跳转到下一个话题
        stopScrolling();
        clearTimeout(scriptState.pageLoadTimer);
        scriptState.pageLoadTimer = setTimeout(() => {
            openNewTopic();
            scriptState.isProcessingError = false;
        }, retryDelay);
    }

    // 处理帖子逻辑
    function processPosts() {
        if (!scriptState.isReading || scriptState.isProcessingError) return;

        // 检查是否是错误页面
        if (isErrorPage()) {
            handleErrorPage();
            return;
        }

        // 获取当前页面的帖子
        scriptState.posts = Array.from(document.querySelectorAll('article[data-post-id]'));
        scriptState.currentPostIndex = 0;

        console.log(`找到 ${scriptState.posts.length} 个帖子`);

        // 更新状态
        scriptState.currentTask = "scrolling";
        updateStatusPanel();
    }

    // 自动点赞功能
    function autoLike() {
        if (!scriptState.isReading || !scriptState.isLiking || scriptState.isProcessingError) return;

        // 检查是否是错误页面
        if (isErrorPage()) {
            handleErrorPage();
            return;
        }

        console.log("开始自动点赞...");

        // 获取当前点赞计数
        let clickCounter = parseInt(localStorage.getItem("clickCounter") || "0", 10);

        // 寻找可能的点赞按钮
        const selectors = [
            '.discourse-reactions-reaction-button:not(.liked)',
            'button.like-button:not(.liked)',
            'button[data-action="like"]:not([aria-pressed="true"])',
            'button.toggle-like:not(.liked)'
        ];

        let likeableButtons = [];
        selectors.forEach(selector => {
            const buttons = document.querySelectorAll(selector);
            likeableButtons = [...likeableButtons, ...buttons];
        });

        // 去重
        likeableButtons = Array.from(new Set(likeableButtons));

        if (likeableButtons.length === 0) {
            console.log("未找到可点赞的按钮");
            return;
        }

        console.log(`找到 ${likeableButtons.length} 个可点赞按钮`);

        // 限制点赞数量
        const buttonsToLike = likeableButtons.slice(0, likeLimit - clickCounter);

        // 逐个点击按钮
        buttonsToLike.forEach((button, index) => {
            setTimeout(() => {
                if (!scriptState.isReading || !scriptState.isLiking || scriptState.isProcessingError) return;

                // 再次检查是否是错误页面
                if (isErrorPage()) {
                    handleErrorPage();
                    return;
                }

                try {
                    button.click();
                    clickCounter++;
                    console.log(`已点赞按钮 ${index + 1}，总数: ${clickCounter}`);

                    // 更新存储
                    localStorage.setItem("clickCounter", clickCounter.toString());

                    // 更新状态面板
                    updateStatusPanel();

                    // 达到限制时停止
                    if (clickCounter >= likeLimit) {
                        console.log(`已达到点赞限制 ${likeLimit}`);
                        scriptState.isLiking = false;
                        localStorage.setItem("autoLikeEnabled", "false");
                        updateButtonStates();
                    }
                } catch (e) {
                    console.error("点赞失败:", e);
                }
            }, index * 3000); // 3秒间隔
        });
    }

    // 创建控制面板
    function createControlButtons() {
        // 主控制按钮
        const controlButton = document.createElement("button");
        controlButton.textContent = scriptState.isReading ? "停止阅读" : "开始阅读";
        controlButton.className = "fixed bottom-4 left-4 z-50 px-4 py-2 bg-blue-500 text-white rounded-lg shadow-lg hover:bg-blue-600 transition-all duration-300 transform hover:scale-105";
        document.body.appendChild(controlButton);

        controlButton.onclick = function() {
            scriptState.isReading = !scriptState.isReading;
            localStorage.setItem("read", scriptState.isReading.toString());
            controlButton.textContent = scriptState.isReading ? "停止阅读" : "开始阅读";

            if (scriptState.isReading) {
                // 开始阅读
                console.log("开始自动阅读");
                scriptState.errorRetries = 0;
                localStorage.setItem("errorPageRetries", "0");

                // 检查是否有未读链接
                if (scriptState.unseenHrefs.length === 0) {
                    navigateToUrl(`${BASE_URL}/unseen`);
                } else {
                    openNewTopic();
                }
            } else {
                // 停止阅读
                console.log("已停止自动阅读");
                stopScrolling();
                clearTimeout(scriptState.checkScrollTimeout);
                clearTimeout(scriptState.checkPostReadTimeout);
                clearTimeout(scriptState.pageLoadTimer);
                scriptState.currentTask = null;
            }

            updateStatusPanel();
        };

        // 自动点赞按钮
        const likeButton = document.createElement("button");
        likeButton.textContent = scriptState.isLiking ? "禁用自动点赞" : "启用自动点赞";
        likeButton.className = "fixed bottom-16 left-4 z-50 px-4 py-2 bg-green-500 text-white rounded-lg shadow-lg hover:bg-green-600 transition-all duration-300 transform hover:scale-105";
        document.body.appendChild(likeButton);

        likeButton.onclick = function() {
            scriptState.isLiking = !scriptState.isLiking;
            localStorage.setItem("autoLikeEnabled", scriptState.isLiking.toString());
            likeButton.textContent = scriptState.isLiking ? "禁用自动点赞" : "启用自动点赞";

            if (scriptState.isLiking && scriptState.isReading) {
                console.log("已启用自动点赞");
                autoLike();
            } else {
                console.log("已禁用自动点赞");
                clearInterval(scriptState.autoLikeInterval);
            }

            updateStatusPanel();
        };

        // 重置话题列表按钮
        const resetButton = document.createElement("button");
        resetButton.textContent = "重置未读列表";
        resetButton.className = "fixed bottom-28 left-4 z-50 px-4 py-2 bg-red-500 text-white rounded-lg shadow-lg hover:bg-red-600 transition-all duration-300 transform hover:scale-105";
        document.body.appendChild(resetButton);

        resetButton.onclick = function() {
            console.log("重置未读列表...");
            scriptState.unseenHrefs = [];
            localStorage.setItem("unseenHrefs", "[]");
            alert("未读列表已重置，下次加载时将获取新话题");
        };

        // 状态面板
        const statusPanel = document.createElement("div");
        statusPanel.className = "fixed top-4 left-4 z-50 bg-white/80 backdrop-blur-sm px-4 py-2 rounded-lg shadow-lg text-sm";
        statusPanel.id = "auto-read-status";
        document.body.appendChild(statusPanel);

        updateStatusPanel();
    }

    // 更新按钮状态
    function updateButtonStates() {
        const controlButton = document.querySelector("button.fixed.bottom-4.left-4");
        const likeButton = document.querySelector("button.fixed.bottom-16.left-4");

        if (controlButton) {
            controlButton.textContent = scriptState.isReading ? "停止阅读" : "开始阅读";
        }

        if (likeButton) {
            likeButton.textContent = scriptState.isLiking ? "禁用自动点赞" : "启用自动点赞";
        }
    }

    // 更新状态面板
    function updateStatusPanel() {
        const panel = document.getElementById("auto-read-status");
        if (!panel) return;

        const clickCounter = parseInt(localStorage.getItem("clickCounter") || "0", 10);
        const taskDescription = {
            "navigating": "正在导航到新帖子",
            "scrolling": "正在阅读帖子",
            null: "等待中"
        };

        panel.innerHTML = `
            <div class="font-bold">自动阅读状态</div>
            <div>阅读: <span class="font-semibold ${scriptState.isReading ? 'text-green-600' : 'text-red-600'}">${scriptState.isReading ? '运行中' : '已停止'}</span></div>
            <div>点赞: <span class="font-semibold ${scriptState.isLiking ? 'text-green-600' : 'text-red-600'}">${scriptState.isLiking ? '启用' : '禁用'}</span></div>
            <div>今日点赞: ${clickCounter}/${likeLimit}</div>
            <div>当前任务: ${taskDescription[scriptState.currentTask]}</div>
            <div>错误重试: ${scriptState.errorRetries}/${maxRetries}</div>
            <div>剩余帖子: ${scriptState.unseenHrefs.length}</div>
            <div>页面状态: ${isErrorPage() ? '<span class="text-red-600">错误</span>' : '<span class="text-green-600">正常</span>'}</div>
            <div>滚动状态: ${scriptState.isScrolling ? '<span class="text-green-600">滚动中</span>' : '<span class="text-red-600">已停止</span>'}</div>
        `;
    }
})();