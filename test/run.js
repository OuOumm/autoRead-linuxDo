/**
 * auto-read.js 回归测试
 *
 * 用 jsdom 造一个假的 Discourse 帖子页，把脚本原样 eval 进去，
 * 配一个本地 HTTP mock 充当 AI 接口，验证：
 *   - 纯函数（CSV 转义、href 白名单、Key 清洗/定位、AI 配置校验、回复解析）
 *   - 面板：AI 字段渲染与回填、设置保存、测试回复的成功 / 失败两条路径
 *   - 配额：点赞/评论成功后计数 +1，日志功能已移除
 *   - 行为：点赞必须等服务端确认才记账、锁所有权、停止后不再前进
 *   - 滚动：rAF 冻结（模拟窗口失焦）时计时器仍持续驱动滚动，暂停/停止/读完都停表
 *   - 单楼帖：没有「当前楼层 / 总楼层」进度条时宽限几拍后自动跳过，进度条异步出现不会误跳
 *   - 已读判定：读论坛的 .read-state.read 标记统计；滚动参数可钳制；各实例可独立启停
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
async function throwsAsync(name, fn, matcher) {
  try {
    await fn();
    ok(name, false, '预期抛错，但正常返回了');
  } catch (e) {
    const msg = String((e && e.message) || e);
    ok(name, matcher ? matcher.test(msg) : true, `错误文案=${msg}`);
  }
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
  '本地小模型这两年进步很快，7B 级别在笔记本上跑起来已经能应付一部分日常问答。' .repeat(30) +
  '这里是正文结尾标记END。';

function pageHtml() {
  const article = (id, author, body, likeId) => `
    <article data-post-id="${id}">
      <div class="topic-meta-data"><span class="names"><a href="/u/${author}">${author}</a></span></div>
      <div class="post-infos"><div class="read-state" title="帖子未读"></div></div>
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
    <div id="reply-control">
      <textarea class="d-editor-input"></textarea>
      <button class="btn-primary">回复</button>
    </div>
  </body></html>`;
}

// ---------- AI 接口 mock ----------
const requests = [];
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.url === '/v1/chat/completions') {
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch (e) {
            /* ignore */
          }
          requests.push({ url: req.url, headers: req.headers, body });
          if (body.model === 'model-bad') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'textarea[沙发！这配置确实够用了]' } }],
            })
          );
          return;
        }
        res.writeHead(404);
        res.end('nope');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const aiUrl = `${origin}/v1/chat/completions`;

  const dom = new JSDOM(pageHtml(), {
    url: `${origin}/t/1`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // Tampermonkey 存储桩：脚本优先走 GM_*
  const bag = new Map();
  win.GM_getValue = (k, d) => (bag.has(k) ? bag.get(k) : d);
  win.GM_setValue = (k, v) => bag.set(k, v);
  win.GM_deleteValue = (k) => bag.delete(k);

  // jsdom 没有 fetch / Blob URL：补上，并去掉 signal（jsdom 与 undici 的 AbortSignal 不互认）
  win.fetch = (url, init) => {
    const opts = Object.assign({}, init);
    delete opts.signal;
    return globalThis.fetch(url, opts);
  };
  win.URL.createObjectURL = () => 'blob:mock';
  win.URL.revokeObjectURL = () => {};

  win.eval(CODE);
  await sleep(50);

  const app = win.__autoRead;
  const { utils, reader, ui } = app;
  const store = reader.store;

  // ===================== 1. 纯函数 =====================
  eq('csvCell 已随日志功能移除', utils.csvCell, undefined);

  eq('safeHref 放行 https', utils.safeHref('https://linux.do/t/1'), 'https://linux.do/t/1');
  eq('safeHref 拒绝 javascript:', utils.safeHref('javascript:alert(1)'), '');
  eq('safeHref 拒绝 data:', utils.safeHref('data:text/html,<script>1</script>'), '');
  eq('safeHref 空值', utils.safeHref(''), '');
  eq('safeHref 相对路径补全', utils.safeHref('/t/2'), `${origin}/t/2`);

  eq('normalizeSecret 去零宽字符', utils.normalizeSecret('sk\u200B-1'), 'sk-1');
  eq('normalizeSecret 去 Bearer 前缀', utils.normalizeSecret('Bearer sk-1'), 'sk-1');
  eq('normalizeSecret 去全角空格', utils.normalizeSecret('\u3000sk-1\u3000'), 'sk-1');
  eq('normalizeSecret 去中文引号', utils.normalizeSecret('“sk-1”'), 'sk-1');
  eq('normalizeSecret 去反引号', utils.normalizeSecret('`sk-1`'), 'sk-1');

  eq('findNonLatin1 干净串', utils.findNonLatin1('sk-abc'), null);
  const bad = utils.findNonLatin1('sk-测');
  eq('findNonLatin1 定位下标', bad && bad.index, 3);
  eq('findNonLatin1 报出字符', bad && bad.ch, '测');
  await throwsAsync(
    'assertHeaderSafe 中文报位置',
    () => utils.assertHeaderSafe('sk-测', 'API Key'),
    /第 4 个字符.*U\+6D4B/
  );
  await throwsAsync('assertHeaderSafe 换行报控制字符', () => utils.assertHeaderSafe('sk\n1', 'API Key'), /控制字符 U\+0A/);
  eq('assertHeaderSafe 放行正常 Key', utils.assertHeaderSafe('sk-ok', 'API Key'), 'sk-ok');

  eq('validateAiSettings 默认地址', utils.validateAiSettings({}).aiUrl, 'https://tbai.xin/v1/chat/completions');
  eq('validateAiSettings 默认模型', utils.validateAiSettings({}).aiModel, 'gpt-4.1-mini');
  eq('validateAiSettings 采纳用户输入', utils.validateAiSettings({ aiUrl, aiModel: 'm1' }).aiModel, 'm1');
  await throwsAsync(
    'validateAiSettings 拦非 http 地址',
    () => utils.validateAiSettings({ aiUrl: 'ftp://x/y' }),
    /http:\/\/ 或 https:\/\//
  );
  await throwsAsync(
    'validateAiSettings 拦缺域名地址',
    () => utils.validateAiSettings({ aiUrl: 'https:///v1' }),
    /缺少有效域名/
  );

  eq('parseComment 抽 textarea[]', utils.parseComment('textarea[沙发！]'), '沙发！');
  eq('parseComment 去引号', utils.parseComment('textarea[“沙发”]'), '沙发');
  eq('parseComment 兜底取首行', utils.parseComment('沙发！\n解释'), '沙发！');
  eq('parseComment 空输入', utils.parseComment(''), '');

  const ctx = utils.currentTopicContext();
  eq('currentTopicContext 取标题', ctx.title, '如何看待本地大模型在笔记本上的表现');
  eq('currentTopicContext 正文截断 500', ctx.context.length, 500);
  ok('currentTopicContext 正文是前缀', LONG_BODY.startsWith(ctx.context));

  const lb1 = win.document.getElementById('lb1');
  eq('isLiked 未赞', utils.isLiked(lb1), false);
  lb1.classList.add('has-like');
  eq('isLiked 已赞 by class', utils.isLiked(lb1), true);
  lb1.classList.remove('has-like');
  lb1.setAttribute('aria-pressed', 'true');
  eq('isLiked 已赞 by aria', utils.isLiked(lb1), true);
  lb1.removeAttribute('aria-pressed');

  // ===================== 2. Key 存储 =====================
  store.setApiKey('  “sk-abc” ');
  eq('setApiKey 清洗后落盘', store.getApiKey(), 'sk-abc');
  bag.set('autoReadApiKeyV4', '\u3000sk-old-789\u3000');
  eq('getApiKey 读时清洗老数据', store.getApiKey(), 'sk-old-789');
  let threw = false;
  try {
    store.setApiKey('sk-中文');
  } catch (e) {
    threw = true;
  }
  ok('setApiKey 拒绝中文 Key', threw);
  eq('拒绝后未覆盖原 Key', store.getApiKey(), 'sk-old-789');
  const masked = app.store.apiKeyMasked();
  eq('apiKeyMasked 格式', masked, 'sk-***89');
  ok('apiKeyMasked 不含完整 Key', !masked.includes('old-7'), masked);
  bag.set('autoReadApiKeyV4', 'sk-1');
  eq('短 Key 整体打码', app.store.apiKeyMasked(), '***');
  bag.set('autoReadApiKeyV4', 'sk-old-789');

  // ===================== 3. 面板与设置 =====================
  ok('面板已挂载', !!ui.dock && !!ui.panel);
  ok('面板按钮齐全', ['bRead', 'bPause', 'bLike', 'bComment', 'bSet'].every((id) => ui.dock.querySelector('#' + id)));
  eq('日志按钮已移除', ui.dock.querySelector('#bLog'), null);

  store.updateSettings({ aiUrl, aiModel: 'model-x' });
  reader.openSettings();
  let modal = ui.root.getElementById('ar-settings');
  ok('设置弹窗打开', !!modal);
  eq('回填 aiUrl', modal.querySelector('#setAiUrl').value, aiUrl);
  eq('回填 aiModel', modal.querySelector('#setAiModel').value, 'model-x');
  ok('测试回复区块存在', !!modal.querySelector('#setTest') && !!modal.querySelector('#setOut'));
  eq('测试按钮初始文案', modal.querySelector('#setTest').textContent, '生成回复');

  // 保存：合法配置写盘
  modal.querySelector('#setAiUrl').value = `${origin}/v1/chat/completions`;
  modal.querySelector('#setAiModel').value = 'model-y';
  modal.querySelector('#setKey').value = '';
  modal.querySelector('#setOk').click();
  await sleep(30);
  eq('保存后 aiModel 落盘', app.store.getSettings().aiModel, 'model-y');
  eq('保存后关闭弹窗', ui.root.getElementById('ar-settings'), null);

  // 保存：非法地址被拦，且不写盘
  reader.openSettings();
  modal = ui.root.getElementById('ar-settings');
  modal.querySelector('#setAiUrl').value = 'not-a-url';
  modal.querySelector('#setOk').click();
  await sleep(30);
  eq('非法地址不写盘', app.store.getSettings().aiModel, 'model-y');
  ok('非法地址仍显示弹窗', !!ui.root.getElementById('ar-settings'));
  ok('非法地址有 toast', /http/.test(ui.toasts.textContent), ui.toasts.textContent);
  ui.closeSettings();

  // ===================== 4. 测试 AI 回复（走完整 UI 路径） =====================
  bag.set('autoReadApiKeyV4', 'sk-test-123');
  reader.openSettings();
  modal = ui.root.getElementById('ar-settings');
  modal.querySelector('#setAiModel').value = 'model-x';
  modal.querySelector('#setTest').click();
  ok('生成中按钮锁定', modal.querySelector('#setTest').disabled);
  await until(() => modal.querySelector('#setTest').textContent === '生成回复');
  modal = ui.root.getElementById('ar-settings');
  eq('成功展示回复内容', modal.querySelector('#setOut').textContent, '沙发！这配置确实够用了');
  eq('成功样式 ok', modal.querySelector('#setOut').className, 'ar-out ok');
  ok('meta 带标题/字数/模型', /标题：如何看待.*正文 500 字.*模型：model-x/.test(modal.querySelector('#setMeta').textContent),
    modal.querySelector('#setMeta').textContent);

  const last = requests[requests.length - 1];
  eq('服务端收到 Bearer', last.headers.authorization, 'Bearer sk-test-123');
  eq('服务端收到模型名', last.body.model, 'model-x');
  ok('system prompt 已发送', /水贴狂魔/.test(last.body.messages[0].content));
  ok('user 消息含标题', last.body.messages[1].content.includes('如何看待本地大模型'));
  eq('user 消息正文 500 字', last.body.messages[1].content.split('正文片段：')[1].length, 500);

  // 失败路径：服务端 401
  modal.querySelector('#setAiModel').value = 'model-bad';
  modal.querySelector('#setTest').click();
  await until(() => ui.root.getElementById('ar-settings').querySelector('#setTest').textContent === '生成回复');
  modal = ui.root.getElementById('ar-settings');
  eq('401 样式 bad', modal.querySelector('#setOut').className, 'ar-out bad');
  ok('401 带服务端原因', /401.*invalid api key/.test(modal.querySelector('#setOut').textContent),
    modal.querySelector('#setOut').textContent);
  eq('失败时 meta', modal.querySelector('#setMeta').textContent, '生成失败');

  // 失败路径：填了中文 Key
  modal.querySelector('#setKey').value = 'sk-中文';
  modal.querySelector('#setTest').click();
  await until(() => ui.root.getElementById('ar-settings').querySelector('#setTest').textContent === '生成回复');
  modal = ui.root.getElementById('ar-settings');
  ok('中文 Key 定位报错', /第 4 个字符/.test(modal.querySelector('#setOut').textContent),
    modal.querySelector('#setOut').textContent);
  modal.querySelector('#setKey').value = '';
  ui.closeSettings();

  // 失败路径：接口地址写成内网不可达（网络层 TypeError）
  await throwsAsync(
    '不可达地址给出网络提示',
    () =>
      utils.generateComment({
        title: 't',
        context: 'c',
        settings: { aiUrl: 'http://127.0.0.1:1/v1', aiModel: 'm', aiSystemPrompt: 'x' },
        apiKey: 'sk-ok',
      }),
    /网络请求失败|请求 AI 接口失败/
  );

  // ===================== 5. 配额计数（日志功能已移除） =====================
  eq('日志面板方法已移除', reader.openLog, undefined);
  eq('日志写入方法已移除', store.recordAction, undefined);
  eq('日志清空方法已移除', store.clearActionLog, undefined);
  eq('状态里没有 actionLog 字段', store.state.actionLog, undefined);

  // countAction 仍要正确驱动每日配额
  const likeBefore = app.store.getState().likeCount;
  const commentBefore = app.store.getState().commentCount;
  store.countAction({ liked: true });
  eq('点赞计数 +1', app.store.getState().likeCount, likeBefore + 1);
  store.countAction({ commented: true });
  eq('评论计数 +1', app.store.getState().commentCount, commentBefore + 1);
  const likeBefore2 = app.store.getState().likeCount;
  store.countAction({});
  eq('空动作不计数', app.store.getState().likeCount, likeBefore2);
  ok('配额上限判断仍可用', typeof store.canLike() === 'boolean' && typeof store.canComment() === 'boolean');

  // ===================== 6. 点赞必须等服务端确认 =====================
  store.updateSettings({ likeIntervalMin: 5, likeIntervalMax: 10, likeLimit: 30 });
  reader.state.isReading = true;
  reader.state.isLiking = true;
  reader.state.isPaused = false;
  reader._likeTried = new Set();

  // lb2 点击后不翻转状态：不应该记账
  const before = app.store.getState().likeCount;
  await reader.autoLike();
  await sleep(60);
  eq('未确认的点赞不记账', app.store.getState().likeCount, before);
  ok('未确认的按钮已记入 tried', reader._likeTried.has('102'), [...reader._likeTried].join(','));

  // lb1 点击后翻转 has-like：应该记账
  reader._likeTried = new Set();
  lb1.onclick = () => lb1.classList.add('has-like');
  await reader.autoLike();
  await sleep(60);
  eq('确认的点赞记账 +1', app.store.getState().likeCount, before + 1);
  reader.state.isLiking = false;

  // ===================== 7. 锁所有权 =====================
  eq('自己持锁 lockedByOther=false', reader.lockedByOther(), false);
  bag.set(store.lockKey, { token: 'other-tab', ts: Date.now() });
  eq('他人持锁 lockedByOther=true', reader.lockedByOther(), true);
  eq('他人持锁 beginReading 失败', reader.beginReading(), false);
  ui.renderStatus({ locked: true, isReading: false, selfName: 'me' });
  ok('他人持锁时开始按钮禁用', ui.btnRead.disabled);
  ok('禁用原因有 title', /这个实例已在别处运行/.test(ui.btnRead.title));

  // 锁已过期（对方崩溃没交还）：不该继续拦住本页
  bag.set(store.lockKey, { token: 'dead-tab', ts: Date.now() - 60000 });
  eq('过期锁不算被占用', reader.lockedByOther(), false);
  bag.delete(store.lockKey);
  ui.renderStatus({ locked: false, isReading: false });
  ok('无锁时开始按钮可用', !ui.btnRead.disabled);
  eq('无锁时清空禁用原因', ui.btnRead.title, '');

  // ===================== 8. 停止后不再推进 =====================
  reader.state.isPaused = true;
  reader.state.unseenHrefs = ['/t/2', '/t/3'];
  reader.openNextTopic();
  eq('暂停时不消费队列', reader.state.unseenHrefs.length, 2);
  reader.state.isPaused = false;
  reader.state.isReading = false;
  reader.openNextTopic();
  eq('停止时不消费队列', reader.state.unseenHrefs.length, 2);

  // ===================== 9. 多实例隔离 =====================
  eq('实例已分配 id', typeof app.instanceId, 'string');
  ok('实例 id 非空', app.instanceId.length >= 8);
  eq('shortId 取后 4 位', utils.shortId('abcdef1234'), '1234');
  ok('新 id 与当前不同', utils.newInstanceId() !== app.instanceId);
  ok('状态键带实例后缀', store.stateKey === `autoReadStateV4:${app.instanceId}`);
  ok('锁键带实例后缀', store.lockKey === `autoReadLockV4:${app.instanceId}`);

  // 另一个实例（模拟另一个标签页）持有自己的锁、写自己的进度：互不干扰
  const otherId = 'zzzz9999';
  bag.set(`autoReadLockV4:${otherId}`, { token: 'other-inst', ts: Date.now() });
  bag.set(`autoReadStateV4:${otherId}`, { readCountToday: 7, readDateKey: '2026-01-01' });
  bag.set('autoReadInstancesV4', { [otherId]: { ts: Date.now() } });
  eq('别实例持锁不影响本实例开始', reader.lockedByOther(), false);
  ok('别实例持锁时本实例可拿锁', store.acquireLock(reader.lockToken));
  eq('别实例的进度不被本实例读写', bag.get(`autoReadStateV4:${otherId}`).readCountToday, 7);
  ok('本实例进度写在独立键', store.stateKey !== `autoReadStateV4:${otherId}`);

  // 实例表：登记自己 + 回收心跳停够久的实例
  const ids = store.pruneInstances();
  ok('实例表包含自己', ids.indexOf(app.instanceId) >= 0);
  eq('存活实例留在表里', ids.indexOf(otherId) >= 0, true);
  const stale = 'stale0001';
  const table = bag.get('autoReadInstancesV4');
  table[stale] = { ts: Date.now() - 60000 };
  bag.set('autoReadInstancesV4', table);
  bag.set(`autoReadStateV4:${stale}`, { readCountToday: 3 });
  bag.set(`autoReadLockV4:${stale}`, { token: 'ghost', ts: Date.now() - 60000 });
  const ids2 = store.pruneInstances();
  eq('过期实例被移出表', ids2.indexOf(stale), -1);
  eq('过期实例的进度被回收', bag.has(`autoReadStateV4:${stale}`), false);
  eq('过期实例的锁被回收', bag.has(`autoReadLockV4:${stale}`), false);
  ok('并行计数 >= 2', store.instanceCount() >= 1);

  // UI：面板头显示实例号，状态栏显示并行数
  ok('面板版本标签含实例号', ui.root.querySelector('.ar-ver').textContent.indexOf('#' + app.shortId(app.instanceId)) >= 0);
  reader.renderStatus();
  ok('状态栏显示实例行', ui.status.textContent.indexOf('并行') >= 0);

  // 设置面板：多实例区块存在
  reader.openSettings();
  await sleep(30);
  const sect = ui.root.getElementById('ar-settings');
  ok('设置面板有多实例区块', !!sect.querySelector('#setNewInst'));
  ok(
    '设置面板显示当前实例',
    sect.querySelector('#setInstInfo').parentNode.parentNode.textContent.indexOf('#' + app.shortId(app.instanceId)) >= 0
  );
  ui.closeSettings();

  // ===================== 10. 跨实例帖子认领 =====================
  bag.delete('autoReadClaimsV4');
  const kA = '/t/aaa/1';
  ok('首次认领成功', store.claim(kA));
  eq('自己的认领可重复认领', store.claim(kA), true);
  eq('认领写进认领表', (bag.get('autoReadClaimsV4') || {})[kA].id, app.instanceId);

  // 另一个实例抢先认领同一篇：本实例让出
  const table2 = bag.get('autoReadClaimsV4');
  table2['/t/aaa/2'] = { id: 'another-inst', ts: Date.now() };
  bag.set('autoReadClaimsV4', table2);
  eq('别实例已认领则认领失败', store.claim('/t/aaa/2'), false);
  eq('unclaimed 过滤别实例的条目', store.unclaimed(['/t/aaa/1', '/t/aaa/2']).join(','), '/t/aaa/1');
  eq('unclaimed 保留自己的与空白的', store.unclaimed(['/t/aaa/1', '/t/aaa/3']).length, 2);

  // 只释放自己的
  store.releaseClaim('/t/aaa/2');
  eq('不释放别实例的认领', (bag.get('autoReadClaimsV4') || {})['/t/aaa/2'].id, 'another-inst');
  store.releaseClaim('/t/aaa/1');
  eq('释放自己的认领', bag.get('autoReadClaimsV4')['/t/aaa/1'], undefined);

  // 过期认领自动失效
  const table3 = bag.get('autoReadClaimsV4');
  table3['/t/old/9'] = { id: 'dead-inst', ts: Date.now() - 600000 };
  bag.set('autoReadClaimsV4', table3);
  eq('过期认领可被接手', store.claim('/t/old/9'), true);

  // topicKey 归一化：slug、查询串、结尾斜杠都指向同一个键
  eq('topicKey 忽略域名', utils.topicKey('https://linux.do/t/abc/12'), '/t/abc/12');
  eq('topicKey 忽略查询串', utils.topicKey('/t/abc/12?page=2'), '/t/abc/12');
  eq('topicKey 去结尾斜杠', utils.topicKey('/t/abc/12/'), '/t/abc/12');
  eq('topicKey 空值安全', utils.topicKey(''), '/');

  // 队列推进时跳过被别实例认领的条目
  bag.set('autoReadClaimsV4', { '/t/skip/1': { id: 'other', ts: Date.now() } });
  reader.state.isReading = true;
  reader.state.isPaused = false;
  reader.state.unseenHrefs = ['/t/skip/1'];
  const beforeHref = win.location.href;
  reader.openNextTopic();
  eq('队列全被别人认领时不再跳转', win.location.href, beforeHref);
  eq('队列已消费完', reader.state.unseenHrefs.length, 0);
  reader.state.isReading = false;

  // ===================== 11. 实例 id 的分配与复用 =====================
  // 刷新（window.name 与 sessionStorage 一致）要复用同一个 id，
  // 否则每刷新一次就多出一个「死实例」，状态也接不回来。
  eq('刷新后复用同一实例 id', utils.resolveInstanceId(), app.instanceId);
  eq('window.name 打上了实例标记', win.name, `ar:${app.instanceId}`);
  eq('sessionStorage 存了实例记录', JSON.parse(win.sessionStorage.getItem('autoReadInstanceV4')).id, app.instanceId);

  // window.open 会连 sessionStorage 一起复制过去，但 window.name 也会被复制；
  // 只要标记对不上就说明是复制出来的页面，必须发新号。
  win.name = 'ar:someone-else';
  const copied = utils.resolveInstanceId();
  ok('复制出来的页面拿到新 id', copied !== app.instanceId, copied);
  eq('新 id 会写回 sessionStorage', JSON.parse(win.sessionStorage.getItem('autoReadInstanceV4')).id, copied);
  eq('新 id 也写回 window.name', win.name, `ar:${copied}`);
  // 只改 window.name 不够：id 要以 window.name 与 sessionStorage 两边一致为准，
  // 这一条同时验证了「一侧被改就走新号」的防串号逻辑。
  win.name = `ar:${app.instanceId}`;
  ok('只回改 window.name 不算恢复', utils.resolveInstanceId() !== app.instanceId);
  // 两边都恢复，才回到原实例
  win.name = `ar:${app.instanceId}`;
  win.sessionStorage.setItem('autoReadInstanceV4', JSON.stringify({ id: app.instanceId, ts: Date.now() }));
  eq('两边一致时解析回原 id', utils.resolveInstanceId(), app.instanceId);

  // 面板 host 的 id 带实例后缀，同页注入两次不会撞 id
  ok('面板 host id 含实例短号', ui.host.id === `auto-read-ui-root-${utils.shortId(app.instanceId)}`, ui.host.id);
  eq('面板 host 带实例属性', ui.host.getAttribute('data-auto-read-instance'), app.instanceId);

  // ===================== 12. 滚动循环：失焦（rAF 冻结）仍继续 =====================
  // 复现用户报告的「浏览器没焦点就暂停滑动」：把 rAF 冻结（注册但永不回调）。
  // 旧实现用 requestAnimationFrame 驱动滚动会直接停摆；新实现走 setTimeout，照滚不误。
  const timeline = win.document.querySelector('.timeline-replies');
  reader.stopScrolling();
  reader.scrollTimer = null;
  const origSpeed = reader.settings.scrollSpeed;
  const origInterval = reader.settings.scrollInterval;

  let rafCalls = 0;
  let scrollCalls = 0;
  let scrollY = 0;
  let bottomCalls = 0;
  const origRAF = win.requestAnimationFrame;
  const origScrollBy = win.scrollBy;
  const origRandom = win.Math.random;
  const origOnReachBottom = reader.onReachBottom;
  const origOpenNextTopic = reader.openNextTopic;
  win.requestAnimationFrame = (cb) => { rafCalls++; return rafCalls; }; // 冻结：永不回调
  win.Math.random = () => 0;                        // 去掉随机抖动，节奏确定
  win.scrollBy = (x, y) => { scrollCalls++; scrollY += y; };
  reader.onReachBottom = () => { bottomCalls++; }; // 避免真的跳转 / 发评论
  reader.openNextTopic = () => {};                  // 屏蔽 boot 里残留的异步读完回调

  reader.settings.scrollInterval = 5;
  reader.settings.scrollSpeed = 50;
  reader.state.isReading = true;
  reader.state.isPaused = false;
  reader.state.autoCommentEnabled = false;
  timeline.textContent = '1 / 50'; // 未追平：不会触发 onReachBottom

  reader.startScrolling();
  const firstTimer = reader.scrollTimer;
  eq('startScrolling 不调度 rAF', rafCalls, 0);
  ok('startScrolling 挂的是计时器', !!firstTimer);
  reader.startScrolling();
  eq('重复 startScrolling 不叠加计时器', reader.scrollTimer, firstTimer);

  const keptScrolling = await until(() => scrollCalls >= 3, 1000);
  ok('rAF 冻结时仍持续滚动（失焦不停）', keptScrolling, `scrollCalls=${scrollCalls}`);
  ok('滚动方向向下且每帧为正', scrollY > 0 && scrollY >= scrollCalls, `scrollY=${scrollY}, calls=${scrollCalls}`);
  eq('失焦滚动全程不用 rAF', rafCalls, 0);

  // stopScrolling 清掉计时器，之后不再滚
  reader.stopScrolling();
  eq('stopScrolling 清空 scrollTimer', reader.scrollTimer, null);
  const callsAtStop = scrollCalls;
  await sleep(40);
  eq('停止后不再产生滚动', scrollCalls, callsAtStop);

  // 暂停守卫：下一拍 tick 自己停掉，不再滚
  reader.startScrolling();
  ok('暂停前计时器已挂', !!reader.scrollTimer);
  reader.state.isPaused = true;
  const stoppedOnPause = await until(() => reader.scrollTimer === null, 1000);
  ok('暂停后 tick 自行停表', stoppedOnPause);
  const callsAtPause = scrollCalls;
  await sleep(40);
  eq('暂停后不再产生滚动', scrollCalls, callsAtPause);

  // 读完（进度追平）触发 onReachBottom 并停表
  reader.state.isPaused = false;
  timeline.textContent = '50 / 50';
  reader.startScrolling();
  const reached = await until(() => bottomCalls >= 1, 1000);
  ok('读完触发 onReachBottom', reached, `bottomCalls=${bottomCalls}`);
  eq('读完后停表', reader.scrollTimer, null);
  eq('onReachBottom 只触发一次', bottomCalls, 1);

  // 复原
  win.requestAnimationFrame = origRAF;
  win.Math.random = origRandom;
  win.scrollBy = origScrollBy;
  reader.onReachBottom = origOnReachBottom;
  reader.openNextTopic = origOpenNextTopic;
  reader.settings.scrollInterval = origInterval;
  reader.settings.scrollSpeed = origSpeed;
  timeline.textContent = '1 / 1';
  reader.stopScrolling();
  reader.state.isReading = false;
  reader.state.isPaused = false;

  // ===================== 13. 单楼帖无进度条：宽限后跳过 =====================
  // 只有楼主、没有任何回复的帖子不会渲染 .timeline-replies 的「当前楼层 / 总楼层」，
  // topicProgress() 返回 null。旧实现只在 progress && done 时切下篇，会永远空滚不前进。
  const timeline2 = win.document.querySelector('.timeline-replies');
  const origRandom2 = win.Math.random;
  const origScrollBy2 = win.scrollBy;
  const origOnReachBottom2 = reader.onReachBottom;
  const origOpenNextTopic2 = reader.openNextTopic;
  const origGrace = reader.settings.noProgressGraceMs;
  const origInterval2 = reader.settings.scrollInterval;
  eq('DEFAULTS.noProgressGraceMs 默认 3000 毫秒', origGrace, 3000);

  let scrollCalls2 = 0;
  let bottomCalls2 = 0;
  win.Math.random = () => 0;                        // 去掉抖动，时间可精确断言
  win.scrollBy = () => { scrollCalls2++; };
  reader.onReachBottom = () => { bottomCalls2++; }; // 避免真的跳转 / 发评论
  reader.openNextTopic = () => {};

  reader.settings.scrollInterval = 20;
  reader.settings.noProgressGraceMs = 60;           // 测试里缩到 60ms（约 3 拍），跑得快
  reader.state.isReading = true;
  reader.state.isPaused = false;
  reader.state.autoCommentEnabled = false;
  reader.stopScrolling();
  reader.scrollTimer = null;

  // 场景 A：进度条元素在，但没有楼层数字（比如只有楼主、进度条是空的）
  timeline2.textContent = '';
  eq('进度条无楼层数字时 topicProgress 返回 null', utils.topicProgress(), null);
  reader._noProgressSince = 1;                     // 故意留个上一帖的残留（很早的时间戳）
  reader.startScrolling();
  eq('startScrolling 重置上一帖残留的宽限计时', reader._noProgressSince, 0);
  const skippedA = await until(() => bottomCalls2 >= 1, 3000);
  ok('无进度条（空文本）宽限后切下篇', skippedA, `bottomCalls=${bottomCalls2}`);
  ok('跳过时至少滚了几拍', scrollCalls2 >= 2, `scrollCalls=${scrollCalls2}`);
  eq('跳过后停表', reader.scrollTimer, null);
  eq('onReachBottom 只触发一次', bottomCalls2, 1);
  const callsAfterSkip = scrollCalls2;
  await sleep(60);
  eq('跳过后不再空滚', scrollCalls2, callsAfterSkip);

  // 场景 B：进度条元素整个不存在（Discourse 单楼帖通常压根不渲染它）
  bottomCalls2 = 0;
  scrollCalls2 = 0;
  timeline2.remove();
  eq('进度条元素不存在时 topicProgress 返回 null', utils.topicProgress(), null);
  reader.stopScrolling();
  reader.scrollTimer = null;
  reader._noProgressSince = 0;
  reader.startScrolling();
  const skippedB = await until(() => bottomCalls2 >= 1, 3000);
  ok('无进度条（元素缺失）宽限后切下篇', skippedB, `bottomCalls=${bottomCalls2}`);
  ok('元素缺失时也滚满宽限时间', scrollCalls2 >= 2, `scrollCalls=${scrollCalls2}`);

  // 场景 C：宽限期内进度条异步渲染出来（未追平）→ 计数归零，继续滚，不误跳
  bottomCalls2 = 0;
  scrollCalls2 = 0;
  reader.settings.scrollInterval = 20;
  reader.settings.noProgressGraceMs = 400;
  reader.stopScrolling();
  reader.scrollTimer = null;
  reader._noProgressSince = 0;
  reader.startScrolling();
  const gotFirstTick = await until(() => scrollCalls2 >= 1, 1000);
  ok('宽限期内先滚了一拍', gotFirstTick, `scrollCalls=${scrollCalls2}`);
  timeline2.textContent = '1 / 50';
  win.document.body.appendChild(timeline2);
  ok('进度条异步出现后 topicProgress 不再是 null', utils.topicProgress() !== null);
  await sleep(100);
  ok('进度条出现后不会误跳', bottomCalls2 === 0, `bottomCalls=${bottomCalls2}`);
  ok('进度条出现后继续滚动', scrollCalls2 >= 2, `scrollCalls=${scrollCalls2}`);
  eq('读到进度条后宽限计时归零', reader._noProgressSince, 0);

  // 复原
  reader.stopScrolling();
  win.Math.random = origRandom2;
  win.scrollBy = origScrollBy2;
  reader.onReachBottom = origOnReachBottom2;
  reader.openNextTopic = origOpenNextTopic2;
  reader.settings.scrollInterval = origInterval2;
  reader.settings.noProgressGraceMs = origGrace;
  timeline2.textContent = '1 / 1';
  reader.state.isReading = false;
  reader.state.isPaused = false;
  reader._noProgressSince = 0;

  // ===================== 14. 已读统计（读论坛 .read-state.read） =====================
  const posts = Array.from(win.document.querySelectorAll('article[data-post-id]'));
  eq('默认滚动步长 1px/帧', reader.settings.scrollSpeed, 1);
  eq('默认滚动间隔 16ms/帧', reader.settings.scrollInterval, 16);
  eq('楼层数 2', posts.length, 2);

  // 无 read class → 不计入
  store.state.readPostIds = [];
  const totalBefore = app.store.getState().postsReadCount;
  reader.markReadPosts();
  eq('未读标记不计入已读', app.store.getState().postsReadCount - totalBefore, 0);

  // 第一层加 read class → 计入
  posts[0].querySelector('.read-state').classList.add('read');
  const totalBefore2 = app.store.getState().postsReadCount;
  reader.markReadPosts();
  eq('read-state.read 计入已读', app.store.getState().postsReadCount - totalBefore2, 1);
  ok('只记下已读楼层的 postId', store.state.readPostIds.indexOf('101') >= 0);
  eq('未读楼层不被记下', store.state.readPostIds.indexOf('102'), -1);

  // 两层都读 → 再 +1；重复扫描不重复计
  posts[1].querySelector('.read-state').classList.add('read');
  const totalBefore3 = app.store.getState().postsReadCount;
  reader.markReadPosts();
  eq('第二层也读后累计 +1', app.store.getState().postsReadCount - totalBefore3, 1);
  const totalBefore4 = app.store.getState().postsReadCount;
  reader.markReadPosts();
  eq('重复扫描不重复计数（去重）', app.store.getState().postsReadCount - totalBefore4, 0);

  // 缺 .read-state 节点时不误计
  posts[0].querySelector('.read-state').remove();
  store.state.readPostIds = [];
  const totalBefore5 = app.store.getState().postsReadCount;
  reader.markReadPosts();
  eq('缺少读状态节点时不计入该层', app.store.getState().postsReadCount - totalBefore5, 1);

  // 统计 API 与清零
  ok('getReadCountToday 可用', typeof store.getReadCountToday() === 'number');
  ok('getReadCountTotal 可用', typeof store.getReadCountTotal() === 'number');
  store.resetReadCount();
  eq('清零后累计为 0', store.getReadCountTotal(), 0);

  // 面板：滚动两项 + 统计行 + 清零按钮
  reader.openSettings();
  await sleep(30);
  const scrollModal = ui.root.getElementById('ar-settings');
  ok('设置面板有滚动步长输入框', !!scrollModal.querySelector('#setScrollSpeed'));
  ok('设置面板有滚动间隔输入框', !!scrollModal.querySelector('#setScrollInterval'));
  ok('设置面板有已读统计行', !!scrollModal.querySelector('#setCount'));
  ok('设置面板有清零按钮', !!scrollModal.querySelector('#setResetCount'));
  eq('步长回填默认值', scrollModal.querySelector('#setScrollSpeed').value, '1');
  eq('间隔回填默认值', scrollModal.querySelector('#setScrollInterval').value, '16');

  // 超界钳制
  scrollModal.querySelector('#setScrollSpeed').value = '99999';
  scrollModal.querySelector('#setScrollInterval').value = '1';
  scrollModal.querySelector('#setOk').click();
  await sleep(30);
  eq('步长超上限被钳到 200', app.store.getSettings().scrollSpeed, 200);
  eq('间隔低于下限被钳到 8', app.store.getSettings().scrollInterval, 8);
  reader.settings.scrollSpeed = 1;
  reader.settings.scrollInterval = 16;
  ui.closeSettings();

  // 状态栏显示已读统计
  reader.renderStatus();
  ok('状态栏显示已读统计', ui.status.textContent.indexOf('已读帖子') >= 0);

  // ---------- 多实例：各自独立启停 ----------
  const StoreClass = reader.store.constructor;
  const instA = new StoreClass({ instanceId: 'inst-A' });
  const instB = new StoreClass({ instanceId: 'inst-B' });
  ok('两实例状态键不同', instA.stateKey !== instB.stateKey, `${instA.stateKey} vs ${instB.stateKey}`);
  ok('两实例锁键不同', instA.lockKey !== instB.lockKey);
  ok('两实例状态对象独立', instA.state !== instB.state);
  instA.state.isReading = true;
  instA.state.isPaused = false;
  eq('A 开启不影响 B', instB.state.isReading, false);
  instB.state.isReading = true;
  instB.state.isPaused = true;
  eq('A 仍在运行未被 B 暂停', instA.state.isPaused, false);
  eq('B 可独立暂停', instB.state.isPaused, true);
  // 统计也按实例独立
  instA.markPostRead('9001');
  eq('A 的已读不被 B 计入', instB.getReadCountTotal(), 0);
  ok('A 自己计入', instA.getReadCountTotal() >= 1);

  // ===================== 15. 顺滑滚动：时间补偿与降频兜底 =====================
  // 高频小步模式下按真实经过时间补偿距离：后台被降频也不变慢，超长间隔有上限不跳屏。
  const compPosts = win.document.querySelector('.timeline-replies');
  const origCompRAF = win.requestAnimationFrame;
  const origCompScrollBy = win.scrollBy;
  const origCompOnReach = reader.onReachBottom;
  const origCompNext = reader.openNextTopic;
  const origCompSpeed = reader.settings.scrollSpeed;
  const origCompInterval = reader.settings.scrollInterval;
  const origCompRandom = win.Math.random;

  win.requestAnimationFrame = () => 1; // 冻结 rAF，确认顺滑滚动不依赖它
  win.Math.random = () => 0;
  const compY = [];
  win.scrollBy = (x, y) => { compY.push(y); };
  reader.onReachBottom = () => {};
  reader.openNextTopic = () => {};
  reader.settings.scrollSpeed = 1;
  reader.settings.scrollInterval = 16;   // 正常帧 16ms → 每帧 1px
  compPosts.textContent = '1 / 50';       // 未读完，避免提前停表
  reader.state.isReading = true;
  reader.state.isPaused = false;
  reader.stopScrolling();
  reader.scrollTimer = null;

  reader.startScrolling();
  await until(() => compY.length >= 2, 1000);
  ok('正常帧每帧滚动 1px（顺滑小步）', compY.length >= 2 && compY[0] === 1 && compY[1] === 1, `compY=${compY.slice(0, 5)}`);

  // 用受控时钟验时间补偿。注意：脚本跑在 jsdom 的 window 上下文里，
  // 内部用的是 window.Date，所以要打 win.Date.now，改 Node 的 Date.now 不生效。
  const winDateNow = win.Date.now;
  let fakeNow = winDateNow();
  win.Date.now = () => fakeNow;
  await sleep(60);                      // 让一拍跑在受控时钟上，lastTs 落到 fakeNow
  const mark = compY.length;
  fakeNow += 16 * 5;                    // 模拟后台降频：时钟一次跳 5 帧（80ms）
  await until(() => compY.length > mark, 1000);
  win.Date.now = winDateNow;
  const compensated = compY.slice(mark).reduce((m, v) => Math.max(m, v), 0);
  ok('降频后按经过时间补偿距离（5 帧补约 5px）', compensated >= 4, `compensated=${compensated}, new=${compY.slice(mark)}`);
  ok('补偿有上限不会跳屏', compensated <= 60, `compensated=${compensated}`);

  // 复原
  reader.stopScrolling();
  win.requestAnimationFrame = origCompRAF;
  win.scrollBy = origCompScrollBy;
  reader.onReachBottom = origCompOnReach;
  reader.openNextTopic = origCompNext;
  reader.settings.scrollSpeed = origCompSpeed;
  reader.settings.scrollInterval = origCompInterval;
  win.Math.random = origCompRandom;
  compPosts.textContent = '1 / 1';
  reader.state.isReading = false;
  reader.state.isPaused = false;

  // ===================== 16. 设置迁移：老存档的旧滚动参数会被新默认覆盖 =====================
  // 复现「代码改了但用户没感觉」：saved 里的旧值会盖掉 DEFAULTS，
  // 必须靠 SETTINGS_VERSION 迁移把新默认推下去。
  const OrigStore = reader.store.constructor;

  // 模拟老存档：旧版本号 + 旧的 8/500
  bag.set('autoReadSettingsV4', { likeLimit: 7, scrollSpeed: 8, scrollInterval: 500 });
  bag.set('autoReadSettingsVersionV4', 0);
  const migratedStore = new OrigStore({ instanceId: 'mig-1' });
  eq('老存档步长被迁移为 1', migratedStore.settings.scrollSpeed, 1);
  eq('老存档间隔被迁移为 16', migratedStore.settings.scrollInterval, 16);
  eq('迁移保留用户自定义 likeLimit', migratedStore.settings.likeLimit, 7);
  eq('迁移后写入新版本号', bag.get('autoReadSettingsVersionV4'), 2);
  eq('迁移后设置已写回存储', bag.get('autoReadSettingsV4').scrollSpeed, 1);

  // 已是当前版本时不再迁移，尊重用户自定义值
  bag.set('autoReadSettingsV4', { scrollSpeed: 3, scrollInterval: 40 });
  bag.set('autoReadSettingsVersionV4', 2);
  const keptStore = new OrigStore({ instanceId: 'mig-2' });
  eq('新版本下用户自定义步长被保留', keptStore.settings.scrollSpeed, 3);
  eq('新版本下用户自定义间隔被保留', keptStore.settings.scrollInterval, 40);

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
