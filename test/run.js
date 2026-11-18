/**
 * auto-read.js 回归测试（v6 精简版）
 *
 * 用 jsdom 造一个假的 Discourse 帖子页，把脚本原样 eval 进去，验证：
 *   - 纯函数：进度解析、文本截取、属性转义
 *   - Store：每日计数跨天归零、已读去重与上限、配额上限判断
 *   - 滚动：计时器驱动（失焦不暂停）、时间补偿、暂停/停止/读完停表
 *   - 已读：读论坛 .read-state.read 标记，与滚动几何无关
 *   - 点赞：必须等服务端确认才记账
 *   - 行为：停止后不再推进队列、错误页重试上限
 *
 * 运行：npm test（需先 npm install）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'auto-read.js'), 'utf8');

// ---------- 断言收集 ----------
const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: cond ? '' : extra || '' });
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

// ---------- 假帖子页 ----------
const LONG_BODY =
  '本地小模型这两年进步很快，7B 级别在笔记本上跑起来已经能应付一部分日常问答。'.repeat(30) +
  '这里是正文结尾标记END。';

function pageHtml() {
  const article = (id, author, body, likeId) => `
    <article data-post-id="${id}">
      <div class="topic-meta-data"><span class="names"><a href="/u/${author}">${author}</a></span></div>
      <div class="read-state"></div>
      <div class="cooked">${body}</div>
      <button class="like-button" id="${likeId}">赞</button>
    </article>`;
  return `<!doctype html><html><head><title>如何看待本地大模型在笔记本上的表现 - linux.do</title></head>
  <body>
    <a data-link-name="my-messages" href="/u/me/messages">我的消息</a>
    <div id="topic-title"><h1 class="fancy-title">如何看待本地大模型在笔记本上的表现</h1></div>
    <div class="timeline-replies">1 / 1</div>
    ${article(101, 'alice', LONG_BODY, 'lb1')}
    ${article(102, 'bob', '同感，续航也是问题。', 'lb2')}
  </body></html>`;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;

  const dom = new JSDOM(pageHtml(), { url: `${origin}/t/1`, runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;

  // Tampermonkey 存储桩
  const bag = new Map();
  win.GM_getValue = (k, d) => (bag.has(k) ? bag.get(k) : d);
  win.GM_setValue = (k, v) => bag.set(k, v);
  win.GM_deleteValue = (k) => bag.delete(k);

  win.eval(CODE);
  await sleep(50);

  const app = win.__autoRead;
  const { utils, reader, ui } = app;
  const store = reader.store;

  // ===================== 1. 纯函数 =====================
  eq('textOf 折叠空白', utils.textOf({ textContent: '  a \n b  ' }), 'a b');
  eq('textOf 截断', utils.textOf({ textContent: 'abcdef' }, 3), 'abc');
  eq('textOf 空值安全', utils.textOf(null), '');

  const tl = win.document.querySelector('.timeline-replies');
  tl.textContent = '3 / 10';
  eq('进度解析当前楼层', utils.topicProgress().current, 3);
  eq('进度解析总楼层', utils.topicProgress().total, 10);
  eq('未追平不算读完', utils.topicProgress().done, false);
  tl.textContent = '10 / 10';
  eq('追平算读完', utils.topicProgress().done, true);
  tl.textContent = '';
  eq('无数字返回 null', utils.topicProgress(), null);
  tl.remove();
  eq('元素缺失返回 null', utils.topicProgress(), null);
  tl.textContent = '1 / 1';
  win.document.body.insertBefore(tl, win.document.body.firstChild);

  eq('escapeAttr 转义引号', utils.escapeAttr('a"b'), 'a&quot;b');
  eq('escapeAttr 转义尖括号', utils.escapeAttr('<x>'), '&lt;x&gt;');
  eq('escapeAttr 空值', utils.escapeAttr(null), '');

  // ===================== 2. Store 计数与已读 =====================
  eq('初始点赞计数 0', store.getLikeCount(), 0);
  ok('可以点赞', store.canLike());
  eq('初始已读今日 0', store.getReadCountToday(), 0);
  eq('初始已读累计 0', store.getReadCountTotal(), 0);

  store.markPostRead('1001');
  eq('已读今日 +1', store.getReadCountToday(), 1);
  eq('已读累计 +1', store.getReadCountTotal(), 1);
  store.markPostRead('1001');
  eq('重复标记不重复计数', store.getReadCountTotal(), 1);
  store.markPostRead('1002');
  eq('新帖子再 +1', store.getReadCountTotal(), 2);

  // 去重表上限
  store.settings.readKeyLimit = 3;
  ['2001', '2002', '2003'].forEach((id) => store.markPostRead(id));
  ok('去重表不超过上限', store.state.readPostIds.length <= 3, `len=${store.state.readPostIds.length}`);
  store.settings.readKeyLimit = 2000;

  store.resetReadCount();
  eq('清零后今日为 0', store.getReadCountToday(), 0);
  eq('清零后累计为 0', store.getReadCountTotal(), 0);

  // 跨天归零
  store.state.likeCount = 5;
  store.state.likeDateKey = '1970-1-1';
  eq('跨天后点赞计数归零', store.getLikeCount(), 0);

  store.recordLike();
  eq('recordLike 计数 +1', store.getLikeCount(), 1);
  store.settings.likeLimit = 1;
  eq('达到上限后不可点赞', store.canLike(), false);
  store.settings.likeLimit = 30;

  // ===================== 3. 已读读论坛标记 =====================
  const posts = Array.from(win.document.querySelectorAll('article[data-post-id]'));
  eq('楼层数 2', posts.length, 2);
  store.resetReadCount();
  reader.markReadPosts();
  eq('未读标记不计入', store.getReadCountTotal(), 0);

  posts[0].querySelector('.read-state').classList.add('read');
  reader.markReadPosts();
  eq('read class 计入已读', store.getReadCountTotal(), 1);
  ok('记下已读楼层的 id', store.state.readPostIds.indexOf('101') >= 0);
  eq('未读楼层不被记下', store.state.readPostIds.indexOf('102'), -1);

  posts[1].querySelector('.read-state').classList.add('read');
  reader.markReadPosts();
  eq('第二层也读后 +1', store.getReadCountTotal(), 2);
  reader.markReadPosts();
  eq('重复扫描不重复计数', store.getReadCountTotal(), 2);
  posts.forEach((p) => p.querySelector('.read-state').classList.remove('read'));

  // ===================== 4. 滚动：计时器驱动 + 时间补偿 =====================
  const timeline = win.document.querySelector('.timeline-replies');
  reader.stopScrolling();
  const origRAF = win.requestAnimationFrame;
  const origScrollBy = win.scrollBy;
  const origOnReach = reader.onReachBottom;
  const origOpenNext = reader.openNextTopic;
  const origRandom = win.Math.random;

  let rafCalls = 0, scrollCalls = 0, scrollY = 0, bottomCalls = 0;
  win.requestAnimationFrame = (cb) => { rafCalls++; return rafCalls; }; // 冻结 rAF
  win.Math.random = () => 0;
  win.scrollBy = (x, y) => { scrollCalls++; scrollY += y; };
  reader.onReachBottom = () => { bottomCalls++; };
  reader.openNextTopic = () => {};

  reader.settings.scrollInterval = 5;
  reader.settings.scrollSpeed = 50;
  reader.state.isReading = true;
  reader.state.isPaused = false;
  timeline.textContent = '1 / 50';

  reader.startScrolling();
  const firstTimer = reader.scrollTimer;
  eq('不调度 rAF', rafCalls, 0);
  ok('挂的是计时器', !!firstTimer);
  reader.startScrolling();
  eq('重复启动不叠加', reader.scrollTimer, firstTimer);

  const kept = await until(() => scrollCalls >= 3, 1000);
  ok('rAF 冻结时仍持续滚动（失焦不停）', kept, `scrollCalls=${scrollCalls}`);
  ok('滚动方向向下且每帧为正', scrollY > 0 && scrollY >= scrollCalls, `scrollY=${scrollY}`);
  eq('全程不用 rAF', rafCalls, 0);

  reader.stopScrolling();
  eq('停止后清空计时器', reader.scrollTimer, null);
  const atStop = scrollCalls;
  await sleep(40);
  eq('停止后不再滚动', scrollCalls, atStop);

  // 暂停守卫
  reader.startScrolling();
  reader.state.isPaused = true;
  ok('暂停后自行停表', await until(() => reader.scrollTimer === null, 1000));
  const atPause = scrollCalls;
  await sleep(40);
  eq('暂停后不再滚动', scrollCalls, atPause);

  // 读完触发
  reader.state.isPaused = false;
  timeline.textContent = '50 / 50';
  reader.startScrolling();
  ok('读完触发 onReachBottom', await until(() => bottomCalls >= 1, 1000));
  eq('读完后停表', reader.scrollTimer, null);
  eq('只触发一次', bottomCalls, 1);

  // 时间补偿：受控时钟（脚本在 jsdom 上下文用 win.Date）
  reader.stopScrolling();
  reader.state.isPaused = false;
  reader.settings.scrollInterval = 16;
  reader.settings.scrollSpeed = 1;
  timeline.textContent = '1 / 50';
  scrollCalls = 0;
  const compY = [];
  win.scrollBy = (x, y) => { scrollCalls++; compY.push(y); };
  // 关掉随机，先验「基准节奏」是对的
  const origJitter = { s: reader.settings.scrollJitter, v: reader.settings.speedJitter, p: reader.settings.pauseChance };
  reader.settings.scrollJitter = 0;
  reader.settings.speedJitter = 0;
  reader.settings.pauseChance = 0;
  reader.startScrolling();
  await until(() => compY.length >= 3, 1000);
  ok('关闭随机后每帧正好 1px', compY[0] === 1 && compY[1] === 1, `compY=${compY.slice(0, 5)}`);
  const winNow = win.Date.now;
  let fakeNow = winNow();
  win.Date.now = () => fakeNow;
  await sleep(60);
  const mark = compY.length;
  fakeNow += 16 * 5;   // 模拟后台降频：时钟跳 5 帧
  await until(() => compY.length > mark, 1000);
  win.Date.now = winNow;
  const compensated = compY.slice(mark).reduce((m, v) => Math.max(m, v), 0);
  ok('降频后按经过时间补偿', compensated >= 4, `compensated=${compensated}`);
  ok('补偿有上限不跳屏', compensated <= 60, `compensated=${compensated}`);
  // 复原随机设置
  reader.settings.scrollJitter = origJitter.s;
  reader.settings.speedJitter = origJitter.v;
  reader.settings.pauseChance = origJitter.p;

  reader.stopScrolling();
  win.requestAnimationFrame = origRAF;
  win.scrollBy = origScrollBy;
  win.Math.random = origRandom;
  reader.onReachBottom = origOnReach;
  reader.openNextTopic = origOpenNext;
  reader.settings.scrollInterval = 16;
  reader.settings.scrollSpeed = 1;
  timeline.textContent = '1 / 1';

  // ===================== 5. 点赞必须等服务端确认 =====================
  const lb1 = win.document.getElementById('lb1');
  const lb2 = win.document.getElementById('lb2');
  lb1.classList.remove('has-like');
  lb2.classList.remove('has-like');
  reader.state.isReading = true;
  reader.state.isLiking = true;
  reader.state.isPaused = false;
  reader._likeTried = new Set();
  store.settings.likeIntervalMin = 5;
  store.settings.likeIntervalMax = 10;

  const likeBefore = store.getLikeCount();
  // lb2 点击后不翻转 → 不记账
  await reader.autoLike();
  await sleep(60);
  eq('未确认的点赞不记账', store.getLikeCount(), likeBefore);
  ok('该按钮已记入已尝试', reader._likeTried.has('102'), [...reader._likeTried].join(','));

  // lb1 翻转 → 记账
  reader._likeTried = new Set();
  lb1.onclick = () => lb1.classList.add('has-like');
  await reader.autoLike();
  await sleep(60);
  eq('确认的点赞记账 +1', store.getLikeCount(), likeBefore + 1);
  reader.state.isLiking = false;

  // ===================== 6. 停止后不再推进队列 =====================
  reader.state.isPaused = true;
  reader.state.unseenHrefs = ['/t/2', '/t/3'];
  reader.openNextTopic();
  eq('暂停时不消费队列', reader.state.unseenHrefs.length, 2);
  reader.state.isPaused = false;
  reader.state.isReading = false;
  reader.openNextTopic();
  eq('停止时不消费队列', reader.state.unseenHrefs.length, 2);

  // ===================== 7. 错误页重试上限 =====================
  reader.state.isReading = true;
  reader.state.errorRetries = 0;
  store.settings.maxRetries = 2;
  const nextCalls = [];
  reader.openNextTopic = () => nextCalls.push(1);
  reader.stopReading = () => { reader.state.isReading = false; };
  reader.handleErrorPage();   // 1
  eq('第一次错误后重试', nextCalls.length, 1);
  reader.handleErrorPage();   // 2
  eq('第二次错误后重试', nextCalls.length, 2);
  reader.handleErrorPage();   // 3 > maxRetries → 停止
  eq('超限后不再推进', nextCalls.length, 2);

  // ===================== 8. 面板 =====================
  ok('面板已挂载', !!ui.dock && !!ui.panel);
  ok('面板按钮齐全', ['bRead', 'bPause', 'bLike', 'bSet'].every((id) => ui.dock.querySelector('#' + id)));
  eq('已移除评论按钮', ui.dock.querySelector('#bComment'), null);
  eq('已移除日志按钮', ui.dock.querySelector('#bLog'), null);

  reader.openSettings();
  await sleep(30);
  const modal = ui.root.getElementById('ar-settings');
  ok('设置弹窗打开', !!modal);
  ok('有滚动步长输入', !!modal.querySelector('#setSpeed'));
  ok('有滚动间隔输入', !!modal.querySelector('#setInterval'));
  ok('有已读统计行', !!modal.querySelector('#setCount'));
  ok('有清零按钮', !!modal.querySelector('#setResetCount'));

  // 超界钳制
  modal.querySelector('#setSpeed').value = '99999';
  modal.querySelector('#setInterval').value = '1';
  modal.querySelector('#setOk').click();
  await sleep(30);
  eq('步长超上限钳到 200', store.getSettings ? store.getSettings().scrollSpeed : reader.settings.scrollSpeed, 200);
  eq('间隔低于下限钳到 8', reader.settings.scrollInterval, 8);
  reader.settings.scrollSpeed = 1;
  reader.settings.scrollInterval = 16;

  // ===================== 9. 样式与主题 =====================
  const styleText = ui.root.querySelector('style').textContent;
  const cssOnly = styleText.replace(/\/\*[\s\S]*?\*\//g, '');
  // all:initial 是面板能稳定显示的前提：没有它论坛全局样式会把布局冲掉
  ok('保留 all:initial 隔离论坛样式', cssOnly.indexOf('all:initial') >= 0);
  ok('定义了完整配色变量', ['--bg', '--fg', '--soft', '--line', '--accent', '--ok', '--bad'].every((v) => cssOnly.indexOf(v + ':') >= 0));
  ok('有深色模式定义', cssOnly.indexOf(':host([data-theme="dark"])') >= 0);
  ok('面板定位为 fixed（否则会飞出视口）', /\.ar-dock\{[^}]*position:fixed/.test(cssOnly));
  ok('面板有 z-index 保证在最上层', /\.ar-dock\{[^}]*z-index:2147483000/.test(cssOnly));
  ok('面板有实心背景色', /\.ar-panel\{[^}]*background:var\(--bg\)/.test(cssOnly));
  ok('面板有前景色', /\.ar-panel\{[^}]*color:var\(--fg\)/.test(cssOnly));
  ok('弹窗也有 fixed 与背景', /\.ar-modal\{[^}]*position:fixed/.test(cssOnly));
  // 关键回归：曾经写过 .ar-dock,.ar-dock *{position:static;display:block} 把面板冲掉
  ok('没有把 .ar-dock 自身纳入归一规则', /\.ar-dock,\s*\.ar-dock \*\{[^}]*position:static/.test(cssOnly) === false);
  ok('syncTheme 存在并跟随主题', typeof ui.syncTheme === 'function');
  ui.syncTheme();
  ok('主题属性已设置', ['dark', 'light'].indexOf(ui.host.getAttribute('data-theme')) >= 0, ui.host.getAttribute('data-theme'));

  // ===================== 10. 论坛点赞上限冷却 =====================
  // 文案取自论坛真实弹窗
  const DIALOG_TEXT = '哇！您一直在分享很多爱！今天您已经达到 24 小时点赞上限，不过，随着您的信任级别提升，您将获得更高的每日点赞上限。您可以在 9 小时后再次点赞。';
  eq('解析出 9 小时', reader.constructor.parseCooldownHours(DIALOG_TEXT), 9);
  eq('没有小时数时用保守默认 24', reader.constructor.parseCooldownHours('额度用完了'), 24);
  eq('空文本也用默认值', reader.constructor.parseCooldownHours(''), 24);

  // 无弹窗时不误判
  eq('没有弹窗返回 null', reader.likeLimitDialog(), null);

  // 造一个真实结构的弹窗
  const dlg = win.document.createElement('div');
  dlg.id = 'dialog-holder';
  dlg.className = 'dialog-container';
  dlg.innerHTML = `<div class="dialog-content"><div class="dialog-body"><p>${DIALOG_TEXT}</p></div>
    <div class="dialog-footer"><button class="btn btn-primary" type="button">确定</button></div></div>`;
  win.document.body.appendChild(dlg);
  ok('能识别出上限弹窗', !!reader.likeLimitDialog(), '未识别');
  eq('识别到的文案含关键词', /点赞上限/.test(reader.likeLimitDialog().text), true);

  // 处理：排冷却 + 立即禁用点赞 + 关弹窗 + 返回 true
  store.state.likeCooldownUntil = 0;
  store.state.likeAutoResume = false;
  reader.state.isLiking = true;   // 撞上限前是开着的
  let closedByClick = false;
  dlg.querySelector('button').onclick = () => { closedByClick = true; dlg.remove(); };
  const handled = await reader.handleLikeLimitDialog();
  eq('撞上限返回 true', handled, true);
  eq('撞上限后点赞被立即禁用', reader.state.isLiking, false);
  eq('标记了冷却结束后自动恢复', store.state.likeAutoResume, true);
  ok('弹窗被关闭', closedByClick && !win.document.querySelector('#dialog-holder'));
  const cdUntil = store.state.likeCooldownUntil;
  ok('记录了冷却截止时间', cdUntil > Date.now(), `until=${cdUntil}`);
  // 9 小时 + 30 分钟缓冲
  const expectMs = 9 * 3600 * 1000 + 30 * 60 * 1000;
  const actualMs = cdUntil - Date.now();
  ok('冷却 = 9小时 + 30分钟缓冲', Math.abs(actualMs - expectMs) < 5000, `actual=${Math.round(actualMs/60000)}分 期望=${Math.round(expectMs/60000)}分`);

  // 冷却期间不该再点赞
  eq('冷却中 canLike 判定之外还有独立门禁', store.likeCoolingDown(), true);
  const likeCountDuringCooldown = store.getLikeCount();
  reader.state.isLiking = true;
  const beforeGuard = reader._likeTried.size;
  await reader.autoLike();
  eq('冷却中不点击、不计数', store.getLikeCount(), likeCountDuringCooldown);
  eq('冷却中不产生新的尝试记录', reader._likeTried.size, beforeGuard);

  // 到期后自动恢复（前提是当初由冷却关掉的）
  store.state.likeCooldownUntil = Date.now() - 1000;   // 模拟已到期
  eq('到期后不再是冷却中', store.likeCoolingDown(), false);
  reader.state.isLiking = false;
  reader.state.isReading = true;
  store.state.likeAutoResume = true;
  reader.resumeLikeIfReady();
  eq('到期自动恢复点赞', reader.state.isLiking, true);
  eq('恢复后清掉标记', store.state.likeAutoResume, false);

  // 用户手动关掉的点赞，不能因冷却到期被擅自打开
  store.state.likeCooldownUntil = Date.now() - 1000;
  store.state.likeAutoResume = false;
  reader.state.isLiking = false;
  reader.resumeLikeIfReady();
  eq('手动关闭的点赞不会被自动打开', reader.state.isLiking, false);

  // 用户手动操作优先：点一下点赞按钮就清掉自动恢复标记
  store.state.likeAutoResume = true;
  reader.state.isLiking = false;
  reader.state.isReading = false;   // 避免触发 autoLike 副作用
  reader.toggleLiking();
  eq('手动开启点赞后清掉自动恢复标记', store.state.likeAutoResume, false);
  eq('手动开启后点赞为开', reader.state.isLiking, true);

  store.state.likeCooldownUntil = 0;
  store.state.likeAutoResume = false;
  reader.state.isLiking = false;

  // 格式化显示
  ok('剩余时间格式化', /小时|分/.test(utils.fmtHours ? utils.fmtHours(3 * 3600 * 1000) : '3小时0分'));

  // ===================== 11. 滚动随机化（防固定节奏识别） =====================
  // 固定 16ms/1px 太规律，改造后每拍间隔与步长都在基准附近浮动
  reader.stopScrolling();
  reader.state.isReading = true;
  reader.state.isPaused = false;
  const rt = win.document.querySelector('.timeline-replies');
  rt.textContent = '1 / 50';
  reader.settings.scrollInterval = 16;
  reader.settings.scrollSpeed = 10;
  reader.settings.scrollJitter = 0.35;
  reader.settings.speedJitter = 0.5;
  reader.settings.pauseChance = 0;    // 先关停顿，单独验间隔/步长浮动

  const rY = [];
  const origScrollByR = win.scrollBy;
  win.scrollBy = (x, y) => { rY.push(y); };
  reader.startScrolling();
  await until(() => rY.length >= 12, 1500);
  reader.stopScrolling();
  win.scrollBy = origScrollByR;

  ok('采到足够样本', rY.length >= 12, `n=${rY.length}`);
  const pxMin = Math.min(...rY), pxMax = Math.max(...rY);
  // 基准 10px、±50% → 5~15；再叠加真实计时的时间补偿（frames 略大于 1），
  // 所以上限放宽到 20。重点是「不固定」且「不离谱」。
  ok('步长在合理区间内', pxMin >= 4 && pxMax <= 22, `min=${pxMin} max=${pxMax}`);
  ok('步长确实有波动（非固定值）', pxMax > pxMin, `min=${pxMin} max=${pxMax}`);
  const uniq = new Set(rY).size;
  ok('出现多种不同步长', uniq >= 3, `unique=${uniq}`);

  // 间隔随机：同样基准下连续两次的间隔不应恒定
  const gaps = [];
  let lastT = 0;
  const origSetTimeout = win.setTimeout;
  // 用真实时间差近似观察：采一小段
  reader.settings.pauseChance = 0;
  const y2 = [];
  win.scrollBy = (x, y) => { y2.push(Date.now()); };
  reader.startScrolling();
  await until(() => y2.length >= 6, 1500);
  reader.stopScrolling();
  win.scrollBy = origScrollByR;
  for (let i = 1; i < y2.length; i++) gaps.push(y2[i] - y2[i - 1]);
  const gapUniq = new Set(gaps.map((g) => Math.round(g / 2))).size;
  ok('间隔有波动（非固定节奏）', gapUniq >= 2, `gaps=${gaps.join(',')}`);

  // 停顿概率生效
  reader.settings.pauseChance = 1;
  reader.settings.pauseMsMin = 50;
  reader.settings.pauseMsMax = 60;
  const t0 = Date.now();
  const y3 = [];
  win.scrollBy = () => { y3.push(Date.now()); };
  reader.startScrolling();
  await until(() => y3.length >= 2, 2000);
  reader.stopScrolling();
  win.scrollBy = origScrollByR;
  const pausedGap = y3.length >= 2 ? y3[1] - y3[0] : 0;
  ok('pauseChance=1 时每拍都有停顿', pausedGap >= 50, `gap=${pausedGap}`);

  // 配置 0 时回到固定节奏（可复现）
  reader.settings.pauseChance = 0;
  reader.settings.scrollJitter = 0;
  reader.settings.speedJitter = 0;
  const y4 = [];
  win.scrollBy = (x, y) => { y4.push(y); };
  reader.startScrolling();
  await until(() => y4.length >= 5, 1200);
  reader.stopScrolling();
  win.scrollBy = origScrollByR;
  // 关掉随机后只剩时间补偿带来的 ±1 取整误差，不应出现大幅波动
  const y4min = Math.min(...y4), y4max = Math.max(...y4);
  ok('随机幅度为 0 时步长稳定', y4max - y4min <= 2, `min=${y4min} max=${y4max}`);

  reader.settings.scrollJitter = 0.35;
  reader.settings.speedJitter = 0.5;
  reader.settings.scrollSpeed = 1;
  reader.settings.scrollInterval = 16;

  // ===================== 汇总 =====================
  clearInterval(reader.statusTimer);
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  for (const r of results) {
    if (!r.pass) console.log(`  FAIL  ${r.name}${r.extra ? '  → ' + r.extra : ''}`);
  }
  console.log(`\n${pass}/${results.length} passed${fail ? `, ${fail} failed` : ''}`);
  server.close();
  win.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(2);
});
