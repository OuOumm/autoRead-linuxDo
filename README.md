<div align="center">

# 🧭 Auto Read

**Linux.do 自动阅读助手 · 一个单文件油猴脚本，把未读帖子自动读完**

[![Version](https://img.shields.io/badge/version-4.4.2-2f81f7?style=flat-square)](https://github.com/OuOumm/autoRead-linuxDo/releases)
[![License](https://img.shields.io/badge/license-MIT-3fb950?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-166%2F166%20passed-3fb950?style=flat-square)](#dev)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Chrome%20%7C%20Firefox%20%7C%20Edge-ffd33d?style=flat-square)](#install)
[![GreasyFork](https://img.shields.io/badge/GreasyFork-Install-8250df?style=flat-square)](https://greasyfork.org/zh-CN/scripts/538431-auto-read-linux-do-only)

[快速开始](#install) · [功能亮点](#features) · [配置](#config) · [隐私](#privacy) · [常见问题](#faq) · [开发](#dev)

</div>

---

<a id="intro"></a>

## 这是什么

Auto Read 是一个 **只有一个文件** 的 Tampermonkey 脚本：装好之后，页面右侧会出现一个悬浮面板，点一下「开始阅读」，它就自动跳到未读列表、逐帖平滑滚动、按 Discourse 的楼层进度判定读完，然后切到下一篇。可选地帮你点赞、用你自己的 AI 接口生成短评论。

- ✅ **零构建、零依赖**：发布物就是仓库根目录的 [`auto-read.js`](auto-read.js)，直接安装即可
- ✅ **不碰论坛页面**：面板挂在 Shadow DOM 里，样式内联，不引外部 CDN
- ✅ **数据只留本地**：状态、配额、日志、API Key 全部存在浏览器本地
- ✅ **无人值守**：窗口失焦、切后台、被遮挡都继续读

> 当前版本 **4.4.2**。想直接安装，看下一节；想先看能力清单，跳到 [功能亮点](#features)。

<a id="install"></a>

## 🚀 安装

**方式一 · GreasyFork（推荐）**

1. 安装 [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)（[Firefox 版](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)）
2. 打开 [GreasyFork 脚本页](https://greasyfork.org/zh-CN/scripts/538431-auto-read-linux-do-only) → 点「安装此脚本」
3. 确认安装，访问 `linux.do`，右侧出现控制面板即成功

**方式二 · 从 Release 下载**

在本仓库 [Releases](https://github.com/OuOumm/autoRead-linuxDo/releases) 下载 `auto-read.js`，在 Tampermonkey 控制台新建脚本并把内容整份贴进去保存。

> 脚本头部是标准 UserScript 元数据：`@match https://linux.do/*`、`@run-at document-idle`、`@noframes`，以及 `GM_getValue` / `GM_setValue` / `GM_deleteValue` 三个 `@grant`。存储优先用油猴 GM 接口，没授权时自动回退 `localStorage`。

<a id="usage"></a>

## 🎛 使用

| 操作 | 效果 |
| --- | --- |
| **开始阅读** | 跳到未读列表，逐帖滚动阅读，读完自动切下一篇 |
| **停止阅读** | 立即停表，随时可停 |
| **暂停 / 继续** | 临时挂起，不丢队列 |
| **启用点赞 / 启用评论** | 两项自动化各自独立开关 |
| **设置** | 调每日上限、重试次数、AI 接口地址 / 模型 / API Key |
| **生成回复** | 抓当前帖标题 + 正文前 500 字请求一次 AI，仅预览结果、**不会发帖** |
| **查看日志** | 查看操作记录，可导出 CSV |
| **× / 手柄** | 收起为右缘竖条，收起状态会被记住 |

设置里改完建议先点「生成回复」验证接口可用，再点「保存」。`aiUrl` 与 `aiModel` 都可以在面板里改，不用动代码。

<a id="features"></a>

## ✨ 功能亮点

<a id="reading"></a>

### 📖 阅读流程

- 自动识别并导航至未读帖子，读完全部后自动刷新未读列表
- 按进度条（`.timeline-replies` 的「当前楼层 / 总楼层」）判定读完，**只有 `29/29` 这类追平状态才切下篇**，懒加载不会骗它提前跳走
- **窗口失焦也继续滚**：滚动循环用 `setTimeout` 递归驱动，而不是 `requestAnimationFrame`（rAF 与渲染帧绑定，失焦会被浏览器暂停，表现为「没盯着就不滚了」）。后台标签页最多降频到约 1 秒一拍，但不会停
- **只有楼主的单楼帖也能过**：这类帖子不渲染进度条，读不到时先给约 3 秒宽限（防异步渲染误判），用完仍没有就当作读完直接跳下一篇，不会无限空滚
- 自动标记已读，按帖子 ID 持久化去重；状态栏实时显示「今日已读 / 累计已读」，今日计数跨天自动归零

<a id="multinst"></a>

### 🧩 多实例并行

- 每个标签页启动时自动分配一个实例 id（面板顶部 `v4.4.2 · #a1b2` 里的短号，悬停看完整 id）
- 阅读队列、进度、点赞 / 评论配额**按实例分键存储**，各跑各的互不抢占；AI 接口地址、模型与 Key 全局共用
- 跨实例去重：读某篇之前先在本地「认领」（3 分钟超时），别的实例看到就跳过，避免两个标签页扑同一篇
- 设置面板可「新开一个实例」「清理失效实例」，状态栏显示当前并行数；异常退出的实例在 30 秒心跳超时后被回收

<a id="like"></a>

### 👍 自动点赞

- 只点尚未点赞的帖子，随机间隔避免过于机械，每日上限可调、跨天自动清零
- **点完等服务端确认**（按钮出现 `has-like` / `aria-pressed="true"`）才计入配额；没点上的不算数，同一按钮每次进帖只试一次，不会误点成「取消赞」

<a id="ai"></a>

### 🤖 AI 评论（可选）

- 用你自己的 API Key 调用 OpenAI 兼容接口生成短评论；`aiUrl` / `aiModel` 面板可改
- 设置面板内置「测试 AI 回复」：抓**当前帖子标题与正文前 500 字**发一次请求，直接展示生成结果，不发帖
- Key 粘贴时自动清洗全角空格、中文引号、零宽字符和多余的 `Bearer ` 前缀；仍有非法字符会精确提示「第 N 个字符」及码位
- 未设置 API Key 时功能完全不会触发 → 详见 [隐私说明](#privacy)

<a id="panel"></a>

### 🛡 面板与安全

- 悬浮右侧不遮挡正文，收起为竖条手柄；手柄状态点：绿点脉动 = 运行中，橙点 = 已暂停，灰点 = 已停止
- 顶部显示当前登录用户名；识别到本话题已有自己的回复时自动跳过评论
- 日志表格用 DOM + `textContent` 组装，帖子标题不会被当 HTML 执行；导出 CSV 时对 `=` `+` `-` `@` 开头的单元格加前缀，避免表格软件把它当公式
- 识别错误页（404 / 找不到页面）自动重试，连续超限自动停止避免死循环

<a id="config"></a>

## ⚙️ 配置

常用参数在面板「设置」里调整、保存在本地；其余默认值写在 [`auto-read.js`](auto-read.js) 顶部的 `DEFAULTS` 里。主题不用配置，面板自动跟随论坛浅色 / 深色（读 `html.dark` 或 `data-theme`）。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `likeLimit` | `30` | 每日点赞上限 |
| `commentLimit` | `20` | 每日评论上限 |
| `maxRetries` | `3` | 错误页最大重试次数 |
| `aiUrl` | `https://tbai.xin/v1/chat/completions` | OpenAI 兼容接口地址（面板可改） |
| `aiModel` | `gpt-4.1-mini` | 请求时使用的模型名（面板可改） |
| `scrollSpeed` | `50` | 每次滚动像素 |
| `scrollInterval` | `150` | 滚动间隔（毫秒） |
| `noProgressGraceTicks` | `15` | 读不到进度条时再多滚几拍才判读完（约 3 秒），给异步渲染留窗口 |
| `likeIntervalMin` / `likeIntervalMax` | `2000` / `5000` | 点赞随机间隔（毫秒） |
| `waitTimeout` | `8000` | 等待页面元素超时（毫秒） |
| `unseenLimit` | `300` | 单次抓取的未读帖上限 |
| `logLimit` | `300` | 日志最多保留条数 |
| `panelCollapsed` | `false` | 面板是否收起为右缘手柄 |

<a id="privacy"></a>

## 🔐 隐私说明

- 阅读状态、点赞计数、日志、设置、API Key **全部只保存在本地**（优先 `GM_setValue`，无授权时回退 `localStorage`），不上传任何服务器。
- **唯一的外发请求**：开启「自动评论」并设置了 API Key 后，脚本把**当前帖子的标题与正文前 500 字**发送到你在设置里填写的 AI 接口用于生成评论；点「测试 AI 回复」也会用同样内容发一次（只预览、不发帖）。接口由你自己指定，默认值是第三方地址 `https://tbai.xin/v1/chat/completions`，可以随时改成自己的。
- 未开启自动评论、或未设置 API Key 时，脚本**不产生任何外发请求**。
- API Key 不写入仓库、不随脚本分发；若旧版本里把 Key 写进了代码，请在服务商处吊销重建。

> ⚠️ 使用第三方 AI 接口意味着该帖标题与正文片段会离开浏览器。介意的话把 `aiUrl` 指向自己的服务，或干脆不填 Key。

<a id="dev"></a>

## 🧪 开发与测试

运行物只有一个文件，没有构建步骤；`test/` 与 `package.json` 只用于本地回归测试，发布时不需要。

```
auto-read.js   整个脚本（唯一源文件，也是发布物）
test/run.js    jsdom 回归测试（不参与发布）
package.json   仅声明 devDependency: jsdom 与两个 npm script
```

```bash
node --check auto-read.js   # 语法自检
npm install                 # 首次：只装 jsdom
npm test                    # node test/run.js
```

`test/run.js` 用 jsdom 造一个假的 Discourse 帖子页，把 `auto-read.js` 原样 `eval` 进去，并在进程内启动 HTTP mock 充当 AI 接口，覆盖 13 组场景：

<details>
<summary><b>展开测试覆盖清单</b></summary>

- **纯函数**：CSV 转义与公式注入前缀、`safeHref` 白名单、Key 清洗与非法字符定位、AI 配置校验、AI 回复解析、标题与 500 字正文抓取
- **面板**：AI 字段渲染与回填、保存校验、测试回复的成功 / 401 / 中文 Key 三条路径（含 `Authorization: Bearer` 与请求体断言）
- **安全**：日志表格不注入 HTML、`javascript:` 链接降级为 `—`
- **行为**：点赞必须等服务端确认才记账、实例锁所有权、停止 / 暂停后不再推进队列
- **滚动**：冻结 `requestAnimationFrame` 模拟失焦时计时器仍持续驱动；重复启动不叠加、停止 / 暂停 / 读完都会清表
- **单楼帖**：进度条文本为空 / 元素缺失时宽限拍数用完自动跳过；进度条异步出现（未追平）会重置计数、不误跳
- **多实例**：实例 id 刷新后保持、`window.open` 副本拿新 id、状态与锁按实例分键互不串写、过期实例被清理、跨实例认领让位与接管、`topicKey` 归一化（忽略域名 / 查询串 / 结尾斜杠）

</details>

当前 **166 项断言**，全绿为 `166/166 passed`。

<a id="faq"></a>

## ❓ 常见问题

<details>
<summary><b>脚本不工作怎么办？</b></summary>

确认 Tampermonkey 已启用、脚本为最新版本；刷新页面，若仍无面板，打开控制台查看报错。

</details>

<details>
<summary><b>如何调整滚动速度？</b></summary>

修改 `auto-read.js` 里 `DEFAULTS` 的 `scrollSpeed`（每次滚动像素）或 `scrollInterval`（间隔毫秒），保存后油猴会自动更新。

</details>

<details>
<summary><b>自动点赞有什么限制？</b></summary>

默认每日 30 次，可在设置中修改，跨天自动清零；到上限后只关掉点赞，阅读继续，第二天自动恢复。评论同理（默认 20 条，可自定义）。社区规则可能更严格，请合理使用。

</details>

<details>
<summary><b>多个标签页同时打开会怎样？</b></summary>

现在允许并行：每个标签页是独立实例，各有各的队列、进度与配额，互不影响。唯一会互相配合的是「帖子认领」——读某篇之前先登记，别的实例看到就跳过，避免同时刷同一篇；认领 3 分钟没刷新视为放弃，可被别的实例接手。面板顶部与状态栏显示实例短号与并行数，设置里可「新开一个实例」「清理失效实例」。同一实例 id 被重复注入时（例如手动把脚本粘贴两次）仍会互斥并提示「这个实例已在别处运行」。

</details>

<details>
<summary><b>脚本会记录我的个人信息吗？</b></summary>

不会上传任何数据，详见 [隐私说明](#privacy)。

</details>

<details>
<summary><b>面板样式会影响论坛吗？</b></summary>

不会。面板挂在一个开放的 Shadow Root 里，样式只写在 Shadow 内部（`:host { all: initial }` + 内联 `<style>`），既不引入 Tailwind CDN 之类的全局重置，也不会覆盖论坛的 SVG 图标样式。

</details>

<details>
<summary><b>报错 <code>String contains non ISO-8859-1 code point</code> 是什么原因？</b></summary>

API Key 里混进了非 ASCII 字符。HTTP 请求头只接受 ISO-8859-1 单字节，浏览器在发请求之前就会拒绝，跟网络、接口地址都没关系。

典型来源：从聊天工具复制 Key 时带上了**全角空格**、中文引号 `“”`、零宽字符 `U+200B`，或者对着中文文档手抄把某个字母打成了形近汉字。现在脚本会自动清洗首尾空白、`Bearer ` 前缀、中英文引号、零宽字符；洗不掉时会直接提示「第 N 个字符」的位置和码位。

排查：设置面板清空 API Key → 从服务商后台重新复制 → 粘贴后不要手动补空格。

</details>

<details>
<summary><b>点「生成回复」提示「未取到帖子正文」？</b></summary>

该按钮读取当前页面的帖子标题与 `.cooked` 正文，需要先打开任意帖子（`/t/...`）再进设置面板测试。在首页或 `/unseen` 列表页点击自然取不到，返回一个帖子后重试即可。

</details>

<details>
<summary><b>切到别的窗口 / 标签页后，脚本是不是就不滚了？</b></summary>

4.4.1 已修复。旧版滚动循环用 `requestAnimationFrame` 驱动，浏览器失焦或切后台会把 rAF 连同渲染帧一起暂停，看起来像「没盯着就停住」。现在改为 `setTimeout` 递归驱动，计时器与焦点、可见性解耦；后台标签页可能被降频（约 1 秒一拍），但滚动不停，读完判定与切下篇照常触发。手动暂停 / 停止、以及进度条追平（读完）仍会立即停表。

</details>

<details>
<summary><b>为什么点了「开始阅读」按钮是灰色的？</b></summary>

说明这个实例 id 正在别处运行（按钮 tooltip 会写明）。正常开新标签页会拿到新 id，不会出现这种情况。常见来源：手动把脚本在同一页面粘贴执行了两次，或复制了整个标签页导致 id 相同 —— 关掉多余页面即可，锁会在 30 秒心跳超时后自动失效。想并行跑更多，直接在设置面板点「新开一个实例」。

</details>

<details>
<summary><b>遇到只有楼主、没有任何回复的帖子，脚本会不会卡住？</b></summary>

4.4.2 已修复。单楼帖不渲染 `.timeline-replies` 里的「当前楼层 / 总楼层」，旧版只在进度条追平（`29/29`）时才切下篇，读不到进度条就会一直空滚不前进。

现在读不到进度条会先给 `noProgressGraceTicks`（默认 15 拍 ≈ 3 秒）宽限，避免刚进帖、进度条还没异步渲染出来就误跳；宽限用完仍没有就当作读完，直接走切下篇流程。宽限期内进度条若出现且还没追平，计数清零照常继续滚，不会提前跳走；可在 `DEFAULTS` 里调 `noProgressGraceTicks` 改等待时间。

</details>

<a id="contributing"></a>

## 🤝 贡献与反馈

发现 bug 或有改进建议，欢迎在 [GitHub Issues](https://github.com/OuOumm/autoRead-linuxDo/issues) 提交，或直接发 Pull Request。提 PR 前请先跑一遍 `npm test`。

<a id="license"></a>

## 📄 许可证

[MIT](LICENSE) © 2025 OuO_umm

<a id="disclaimer"></a>

## ⚖️ 免责声明

本脚本仅供学习和研究使用，请遵守 Linux.do 社区的使用条款。作者不对因使用本脚本而导致的任何问题负责。请合理使用自动化工具，尊重社区规则。
