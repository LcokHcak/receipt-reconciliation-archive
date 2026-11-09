const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const SRC = path.join(FRONTEND, 'src');

/**
 * 0728 波3「全站重命名」+ 0727「界面不出现『同步』二字」的扫描护栏。
 *
 * 为什么要扫而不是逐条断言:这两条规则各自都已经漏过一轮——
 *   波3 漏了 layouts/AppSidebar.vue 整套侧栏(见 frontend_two_sidebars_aligned.test.js);
 *   「不出现同步」当时只在建档页落实,客户中心的两处提示照旧在说「待同步」「数据同步滞后」。
 * 逐条断言只能锁住已知的那几处,新写进来的旧词照样溜过去。这里改成扫全部界面文案。
 *
 * 只扫**用户看得见的字**:模板正文 + title/placeholder/aria-label。
 * 注释里出现旧词是**有用的**(交代"这里原来叫什么、为什么改"),不该被自己的护栏逼着删。
 */

// 旧词 → 现名。value 只用于报错时给出建议,不参与判定。
const RETIRED = Object.freeze({
  'Sign Workbench': '收票对账系统',
  审核工作台: '收票对账系统',
  代理视图: '客户中心',
  月度工作台: '结算中心',
  同步: '(内部管道,不该出现在操作员界面;按业务说法改写)',
});

// 豁免:这些不是"操作员流程里的同步",而是别的领域里正当的词。
// 例外要写清理由,否则豁免会变成绕过规则的后门。
const EXEMPT = [
  {
    file: 'views/SettingsView.vue',
    word: '同步',
    why: '「部署与同步(Lora、微调、快照)」讲的是模型运维,admin 才看得到,'
      + '与 0727 拍板针对的「客户数据自动进批次」不是一回事',
  },
  {
    file: 'views/AgentWorkspaceView.vue',
    word: '资料库',
    why: '「日交付(原资料库)」是改名过渡期的注解(悬停里),帮还记得旧名的操作员对上号;'
      + '括号写法本身就说明它是旧名,不是在用旧名指路',
  },
  {
    file: 'views/v2/ErrorsView.vue',
    word: '同步',
    why: '「检测 + 同步离境」「只同步离境」是**用户自己点的动作**(去拉离境记录来对账),'
      + '不是 0727 拍板要消灭的那个"全自动、操作员既不用管也点不动"的内部管道;'
      + '且该页已从导航隐藏(见 AppSidebar:错表/对账总览操作员不用),只有管理员手动进',
  },
];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(vue|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// 取"用户看得见的字":<template> 段的正文与文案类属性。
// 粗糙但够用——宁可多扫(注释已排除),也别漏掉真在界面上的字。
function userVisibleText(source) {
  const tpl = source.match(/<template>([\s\S]*)<\/template>/);
  let body = tpl ? tpl[1] : source;
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')   // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, '')  // 块注释
    .replace(/(^|\s)\/\/[^\n]*/g, ''); // 行注释
  if (tpl) return body;
  // 纯 .js:只看字符串字面量(那才可能是文案),其余是代码
  return (body.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || []).join('\n');
}

function isExempt(relFile, word) {
  return EXEMPT.some((e) => relFile.replace(/\\/g, '/').endsWith(e.file) && e.word === word);
}

test('退役词不得再出现在用户看得见的界面文案里', () => {
  const hits = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    const visible = userVisibleText(fs.readFileSync(file, 'utf8'));
    for (const [word, suggest] of Object.entries(RETIRED)) {
      if (!visible.includes(word)) continue;
      if (isExempt(rel, word)) continue;
      const line = visible.split('\n').find((l) => l.includes(word)) || '';
      hits.push(`${rel}  「${word}」→ 建议「${suggest}」\n      ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, [], `发现退役词 ${hits.length} 处:\n  ${hits.join('\n  ')}`);
});

test('浏览器标签页标题也要正名(书签/窗口标题上就是它)', () => {
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  const m = html.match(/<title>([^<]*)<\/title>/);
  assert.ok(m, 'index.html 应有 <title>');
  assert.doesNotMatch(m[1], /Sign/i, `标签页标题仍是旧品牌:${m[1]}`);
  assert.match(m[1], /收票对账系统/, '标签页标题应含品牌「收票对账系统」');
});

test('豁免必须写明理由(否则豁免名单会变成绕过规则的后门)', () => {
  for (const e of EXEMPT) {
    assert.ok(e.why && e.why.length > 20, `豁免 ${e.file}/${e.word} 缺少充分理由`);
    const p = path.join(SRC, e.file);
    assert.ok(fs.existsSync(p), `豁免指向的文件已不存在(${e.file}),该清理这条豁免了`);
  }
});
