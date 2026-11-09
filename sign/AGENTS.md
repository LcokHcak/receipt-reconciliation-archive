# AGENTS.md — Codex / Claude Code 通用约定

> 这份文件是给在本仓库工作的所有 AI agent(Codex CLI / Claude Code / 其他)读的项目通用约定。**任何任务卡只写这次任务特有的内容,下面这些通用规则不再重复贴。**
>
> 📌 **多 agent 并行协作 → 先读活文档 [AGENT_SHARED_MEMORY.md](AGENT_SHARED_MEMORY.md)**(当前版本/服务器状态、业务流程、代码地图、本仓库特有陷阱、变更日志)。这份(AGENTS.md)是**静态约定**,那份是**会变的状态 + 业务知识**,干完活要去那份追加变更日志。

---

## 项目基本信息

- 模块化单体,Node.js 22 + Express 5 后端,Vue 3 + Pinia + Vite 前端
- 数据存储:JSON 批次文件 + 两套 SQLite(`workbench.sqlite` / `monthly.sqlite`),走 `node:sqlite` 的 `DatabaseSync`
- 包管理:npm(注意 Windows 环境下要用 `npm.cmd` 而不是 `npm`)
- 测试运行器:`node --test`(原生),不用 jest / vitest
- Lint:eslint(配 `eslint.config.mjs`)
- 进程管理:PM2 fork 模式,单实例

---

## 工作流(每次任务都要做)

### 1. 起点确认
- 任何改动开始前先 `git log --oneline -3` 确认当前 HEAD 是任务卡里指定的 base SHA
- 不是的话先 `git status` 看看是不是脏的,**禁止在脏工作树上开工**

### 2. 完成前必跑的"验证三件套"
```
npm.cmd run lint        # 必须 0 errors(warnings 持平即可,不强制减少)
npm.cmd test            # 必须全过,不允许新增失败
git status              # 必须工作树干净(只准有任务卡明确允许的未追踪文件)
```
**三件套全绿才算完成。任何一项不过就回去修,不准提交带红的 commit。**

### 3. 提交规范
- Conventional Commits 格式:`<type>(<scope>): <subject>`
  - type: `feat` / `fix` / `refactor` / `perf` / `test` / `docs` / `chore` / `ci`
  - scope: 模块名,例如 `monthly` / `auth` / `workbench` / `frontend`
- 一个 commit 只做一件事。同任务允许多个 commit,但每个都得能独立通过验证三件套
- commit body 写**为什么这么改**,不写"做了什么"(diff 自己会说话)
- 工作必须在 worktree 分支(`refactor/xxx` 或 `feat/xxx`)上做,**禁止直接动主分支**

---

## 红线(任何情况都不准做)

- 不准 `git push`(任何远端任何分支)
- 不准 `git merge` 到主分支(用户自己 cherry-pick)
- 不准 `git rebase --onto` 改写已分享的 commit 哈希
- 不准用 `--no-verify` 跳过 hook
- 不准用 `eslint --fix` 批量改无关代码(只改任务范围内的)
- 不准为了让 lint 过而改 lint 配置(改源码或者老老实实留着 warning)
- 不准在测试里 mock 数据库;集成测试用真 SQLite(就开 `:memory:`)
- 不准硬编码 secret(JWT_SECRET 等),缺了应该让进程启动失败
- 不准引入新的运行时依赖,除非任务卡明确批准
- 不准动 `legacy-sqlite-fence` 围起来的代码(那是给运维脚本用的死路径)

---

## 调研偏好(省 token / 省时间)

- **优先 grep,不要预防性 Read 整文件**。`Grep` 工具拿到几行就够判断的事,不要 `Read` 整个 600 行文件
- 找一个符号/函数定义:`grep -rn "function fooBar"` 或 `grep -n "fooBar" file.js`
- 找调用方:`grep -rn "fooBar(" .` 比读各个 service 文件快得多
- 任务卡里没让你读的文件,**不要"为了完整性"顺手读** —— 如果改动需要它,grep 会带你找到

---

## 测试编写

- 新增测试放 `tests/`,文件名 `xxx_test.js` 或 `xxx.test.js`
- 用 `node:test` 的 `test()` / `describe()`,断言用 `node:assert/strict`
- 集成测试用临时 SQLite(`new DatabaseSync(':memory:')` + 跑 migration runner)
- **禁止 mock SQLite**:之前因为 mock 跟 prod 行为发散吃过亏,只用真 sqlite
- 单元测试可以 mock 纯函数依赖(用 DI 注入假对象),不要 mock 模块路径

---

## 完成后报告格式(贴回给用户)

每个任务做完,回复以下五行,不要多写:

```
- 起点 base SHA:xxxx(任务卡里给的)
- 新 commit SHA:xxxx(可以多个)
- lint 结果:N errors, M warnings
- test 结果:X pass / Y fail
- 工作树是否干净:是/否
```

如果有可疑点(比如某个测试因环境问题跳过、某个迁移需要手动验证),在五行下面**单独**用一两句话提一下。**不写"我做了什么" —— 用户会看 git show。**

---

## 任务卡阅读约定

任务卡里如果出现:

- "Step 1 — 调研先" → 必须先做调研,把答案写进 commit message,**不准跳过直接写代码**
- "可选" → 真的可选,不影响验收
- "推荐 N 个 commit" → 优先按推荐切;如果代码内在结构不允许,可以合并,但要在汇报里说明
- "禁止" / "不准" → 红线,等同上面的红线列表

---

## 常见陷阱(踩过的坑)

- **Windows 环境必须 `npm.cmd`**,纯 `npm` 在某些 shell 下找不到
- **`node:sqlite` 不支持嵌套事务**,外层 BEGIN/COMMIT 包含已经在事务里的 repo 方法会报错。需要嵌套时用 `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`
- **withBatchWrite 默认 30s 超时**,长事务会被 kill,不要在写队列里跑 OCR 之类的慢操作
- **migration 用 `IF NOT EXISTS`**,但每条迁移仍只允许跑一次(由 `schema_migrations` 表保证),写成幂等不是为了"重复跑"而是为了"被 ROLLBACK 后重试"
- **lint warnings 不动**:存量 134 条 warning 是历史债,任务里只管"不引入新 error 不引入新 warning",存量留给清理 sprint
