<div align="center">

# 🧭 Auto Read

**Linux.do 自动阅读助手 · 一个单文件油猴脚本，把未读帖子自动读完**

[![Version](https://img.shields.io/badge/version-6.1.0-2f81f7?style=flat-square)](https://github.com/OuOumm/autoRead-linuxDo/releases)
[![License](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
[![Lines](https://img.shields.io/badge/code-764%20lines-8250df?style=flat-square)](#dev)
[![Tests](https://img.shields.io/badge/tests-108%2F108%20passed-3fb950?style=flat-square)](#dev)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Chrome%20%7C%20Firefox%20%7C%20Edge-ffd33d?style=flat-square)](#install)

[快速开始](#install) · [功能](#features) · [配置](#config) · [常见问题](#faq) · [开发](#dev)

</div>

---

<a id="intro"></a>

## 这是什么

Auto Read 是一个 **只有一个文件、660 行** 的 Tampermonkey 脚本。装好后页面右侧出现悬浮面板，点「开始阅读」就自动跳到未读列表、逐帖顺滑滚动、按 Discourse 楼层进度判定读完再切下一篇，可选自动点赞。

- ✅ **零构建、零依赖**：发布物就是 [`auto-read.js`](auto-read.js)
- ✅ **复用论坛配色**：直接引用 Discourse 的 CSS 变量（`--secondary` / `--primary` / `--tertiary` 等），深色模式自动跟随，不维护第二套主题
- ✅ **数据只留本地**：状态、配额全部存在浏览器本地，无任何外发请求
- ✅ **无人值守**：窗口失焦、切后台、被遮挡都继续读

<a id="install"></a>

## 🚀 安装

1. 安装 [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)（[Firefox 版](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)）
2. 在 Tampermonkey 控制台新建脚本，把 [`auto-read.js`](auto-read.js) 整份粘贴进去保存
3. 访问 `linux.do`，右侧出现控制面板即成功

<a id="usage"></a>

## 🎛 使用

| 操作 | 效果 |
| --- | --- |
| **开始阅读** | 跳到未读列表，逐帖滚动阅读，读完自动切下一篇 |
| **停止阅读** | 立即停表，随时可停 |
| **暂停 / 继续** | 临时挂起，不丢队列 |
| **启用点赞** | 独立开关，每日上限可调 |
| **设置** | 调点赞上限、重试次数、滚动步长与间隔 |
| **× / 手柄** | 收起为右缘竖条，收起状态会记住 |

<a id="features"></a>

## ✨ 功能

**📖 阅读流程**

- 自动识别并导航至未读帖子，读完全部后刷新未读列表
- 按进度条（`.timeline-replies` 的「当前楼层 / 总楼层」）判定读完，只有 `29/29` 这类追平状态才切下篇，懒加载骗不过它
- **窗口失焦也继续滚**：滚动用 `setTimeout` 递归驱动而非 `requestAnimationFrame`（rAF 与渲染帧绑定，失焦会被暂停）；后台降频时按真实经过时间补偿距离，速度不变慢
- **节奏随机化**：步长 ±50%、间隔 ±35% 每拍浮动，另有约 4% 概率插入 0.3~1.5 秒停顿，避免固定频率被识别；幅度设为 0 即回到恒定节奏
- **只有楼主的单楼帖也能过**：这类帖子不渲染进度条，读不到时给约 3 秒宽限，用完仍没有就当作读完跳下一篇
- **已读统计**：直接读论坛自己的 `.read-state.read` 楼层标记，按帖子 ID 去重，与滚动快慢无关

**👍 自动点赞**

- 只点尚未点赞的帖子，随机间隔，每日上限可调、跨天自动清零
- **点完等服务端确认**（出现 `has-like` / `aria-pressed="true"`）才计入配额；同一按钮每次进帖只试一次，不会误点成「取消赞」

**🛡 面板**

- 悬浮右侧不遮挡正文，收起为竖条手柄；状态点绿=运行中、橙=已暂停、灰=已停止
- 顶部显示当前登录用户名
- 识别错误页（404 / 找不到页面）自动重试，连续超限自动停止避免死循环

<a id="config"></a>

## ⚙️ 配置

面板「设置」里可调，保存在本地。配色直接引用论坛 CSS 变量，论坛切换浅色 / 深色时面板自动跟随。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `likeLimit` | `30` | 每日点赞上限 |
| `maxRetries` | `3` | 错误页最大重试次数 |
| `scrollSpeed` | `1` | 每帧滚动像素（1~200） |
| `scrollInterval` | `16` | 每帧间隔毫秒（8~10000），1px/16ms ≈ 60fps |
| `noProgressGraceMs` | `3000` | 读不到进度条时等多久才判读完 |
| `scrollJitter` | `0.35` | 滚动间隔随机幅度（±35%） |
| `speedJitter` | `0.5` | 滚动步长随机幅度（±50%） |
| `pauseChance` | `0.04` | 每拍插入停顿的概率 |
| `pauseMsMin` / `pauseMsMax` | `300` / `1500` | 停顿区间（毫秒） |
| `likeIntervalMin` / `likeIntervalMax` | `2000` / `5000` | 点赞随机间隔（毫秒） |
| `waitTimeout` | `8000` | 等待页面元素超时（毫秒） |
| `unseenLimit` | `300` | 单次抓取的未读帖上限 |

<a id="privacy"></a>

## 🔐 隐私

- 阅读状态、点赞计数、设置**全部只保存在本地**（优先 `GM_setValue`，无授权时回退 `localStorage`）
- **本版本不发起任何外部网络请求**

<a id="faq"></a>

## ❓ 常见问题

<details>
<summary><b>滚动卡顿 / 一帧一顿？</b></summary>

调小「滚动步长」、调小「滚动间隔」。默认 `1px / 16ms` 约 60fps 已是最顺滑；机器较弱可试 `1 / 24`（40fps）或 `1 / 33`（30fps），更省 CPU。
</details>

<details>
<summary><b>已读数不涨？</b></summary>

已读以论坛的 `.read-state.read` 标记为准，论坛判定读过后才会计入。滚动步长与间隔不影响统计。
</details>

<details>
<summary><b>为什么只有楼主的帖子直接跳过了？</b></summary>

单楼帖不渲染「当前楼层 / 总楼层」，读不到进度条时给约 3 秒宽限，之后视为读完切下一篇，避免无限空滚。
</details>

<details>
<summary><b>面板样式会影响论坛吗？</b></summary>

不会。面板挂在 Shadow Root 里，样式只写在内部；配色用论坛的 CSS 变量（带 fallback），并在面板作用域内做了排版归一，既不污染论坛也不会被论坛样式污染。
</details>

<a id="dev"></a>

## 🧪 开发

```
auto-read.js   整个脚本（唯一源文件，也是发布物）
test/run.js    jsdom 回归测试（不参与发布）
```

```bash
node --check auto-read.js   # 语法自检
npm install                 # 首次：只装 jsdom
npm test                    # node test/run.js
```

`test/run.js` 用 jsdom 造假帖子页、`eval` 脚本，覆盖 8 组场景：纯函数、Store 计数与跨天归零、已读标记统计、滚动（rAF 冻结/时间补偿/暂停停止）、点赞服务端确认、队列守卫、错误重试上限、面板与字段钳制。

当前 **108 项断言**，全绿为 `108/108 passed`。

<a id="license"></a>

## 📄 许可证

[MIT](LICENSE) © 2025 OuO_umm

<a id="disclaimer"></a>

## ⚖️ 免责声明

本脚本仅供学习和研究使用，请遵守 Linux.do 社区的使用条款。作者不对因使用本脚本而导致的任何问题负责。
