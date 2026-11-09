# 图片 storage 迁移到 500G 大盘（/data）方案

> 目标：把每天增长的图片数据从 120G 系统盘挪到闲置的 500G 数据盘，且**审核台看图、导出交付包、切图、COS 同步一个都不能坏**。
> 结论先行：**用软链迁移，应用代码零改动，已逐项验证不会出问题。** 参见下方「为什么安全」。

---

## 一、现状（为什么要迁）

| 盘 | 挂载点 | 容量/用量 | 装了什么 |
|---|---|---|---|
| `/dev/vda2` 系统盘 | `/` | 120G，**用 63G / 56%** | 系统 + **storage 49G（图片+数据库）** + models + logs + releases |
| `/dev/vdb` 数据盘 | `/data` | **500G，用 8.3G / 2%** | **只有 backups**（`/opt/sign-data/backups → /data/backups` 软链，7-04 建） |

问题：当初挂 500G 盘只把「备份」软链过去了，**真正每天涨 ~2.4 万张的图片 storage 还全压在 120G 系统盘上**。
系统盘一旦被图片撑满，**OS 和整个应用会一起挂**（比数据盘满严重得多），而 500G 大盘 459G 闲着。

---

## 二、方案：软链迁移（与现有 backups 迁移同一套路）

把 `/opt/sign-data/storage` 本身变成一个软链，指向 `/data/storage`：

```
迁移前： /opt/sign-data/storage        = 真实目录（在 vda2 系统盘，49G）
迁移后： /opt/sign-data/storage         -> /data/storage（真实数据在 vdb 大盘）
```

应用访问链路（迁移后自动变三级软链，OS 透明解析）：

```
release/passport_review_workbench/storage
   -> /opt/sign-data/storage        （部署脚本每次建的软链，不用动）
      -> /data/storage              （本次新增的软链）
```

**为什么选它**：这正是本服务器 `backups` 已经在用、跑了好几天没问题的成熟套路；应用代码、部署脚本、COS 脚本**一律不用改**。

---

## 三、⭐ 为什么安全（针对「图片挪了、审核台/导出会不会坏」的逐项论证）

唯一会因软链翻车的写法是 **`fs.realpath`**（它会把 `/opt/sign-data/storage/x` 解析成 `/data/storage/x`，
若之后再拿去和 `/opt/sign-data/storage` 做 `startsWith` 前缀校验就会失配、把图片/文件判成越权而拦掉）。

**已全库排查：`lib/` `server/` `services/` 中 `fs.realpath` 用法 = 0 处。** 所有路径都是词法拼接，软链对它们不可见。逐条：

| 环节 | 代码位置 | 怎么读图 | 软链后 | 判定 |
|---|---|---|---|---|
| 审核台看图（批次内切片） | `server/create_app.js:126` `/storage` 路由 | `express.static(batchesRoot)`（send 库用 `path.resolve` 词法校验穿越，**不 realpath**，root 是软链照常服务） | 路径仍 `.../storage/batches/...`，OS 解析到 /data | ✅ 不受影响 |
| 原图/客户库看图 | `services/customer_image_review_service.js:52` | `path.join(customerDir, relativePath)` 词法拼接 + `ensureInsideRoot`（lib 内，零 realpath=词法） | 同上 | ✅ 不受影响 |
| 导出交付包复制图 | `services/monthly/final_delivery_export_service.js:1143` | `fs.copyFileSync(image.path, ...)`，image.path 为 `.../storage/...` | OS 解析到 /data | ✅ 不受影响 |
| 切图写盘 | `lib/qwen_ocr/qwen_split_service.js` | 词法路径写入 storageRoot 下 | 落到 /data | ✅ 不受影响 |
| 数据库 | `server/dependencies.js:68` `path.join(storageRoot,'workbench.sqlite')` | 词法路径 | 落到 /data | ✅（cutover 停机时搬，见执行步骤） |
| COS 异地镜像 | `/opt/sign-data/bin/cos_data_backup.sh` | 脚本写死 `$STORAGE/customer_library`、`$STORAGE/batches`（$STORAGE=/opt/sign-data/storage） | `find`/`sync`/`rm` 都跟随软链落到 /data | ✅ 不用改脚本 |
| 部署激活 | `scripts/server_activate.sh:40,77` | `[ -d "$DATA/storage" ]` 测试跟随软链=真；`ln -sfn $DATA/storage release/.../storage` 指向路径 | 软链→软链，透明 | ✅ 未来部署不炸 |
| 回滚脚本 | `scripts/server_rollback.sh:45` | 同样 `ln -sfn /opt/sign-data/storage ...` | 透明 | ✅ |

**先例佐证**：`/opt/sign-data/backups → /data/backups` 已是同款软链，备份/COS 同步一直正常。

---

## 四、执行步骤

脚本已就位：`scripts/migrate_storage_to_data.sh`（上传到服务器 `/opt/sign-data/bin/`）。两个子命令。

### 步骤 A：预同步（在线、零风险、可反复跑）—— 建议 cutover 前先跑，缩短停机

```bash
# 上传脚本（若还没上传）
node tmp/ssh_putfile.js scripts/migrate_storage_to_data.sh /opt/sign-data/bin/migrate_storage_to_data.sh
node tmp/ssh_run.js 'chmod +x /opt/sign-data/bin/migrate_storage_to_data.sh'

# 在线预同步：rsync 图片到 /data，排除活动数据库，应用照常跑
node tmp/ssh_run.js 'bash /opt/sign-data/bin/migrate_storage_to_data.sh presync'
```

- 只拷图片（`--exclude` 掉 `*.sqlite*` / `*.db*` / `tmp_uploads`），**不碰数据库、不停机**。
- 49G 跨盘拷贝约 5~10 分钟。可反复跑，第二次只补增量（很快）。
- 数据库故意留到 cutover 停机后再搬（边写边拷会得到撕裂副本）。

### 步骤 B：停机秒切（需维护窗口，选深夜没人用时）

> ⚠️ 会停机约 **2~5 分钟**（终同步数据库 + 切软链 + 重启）。30 人在用，务必挑无人时段。
> 执行前当着我复述一遍再动（生产写规矩）。

```bash
# cutover 前再跑一次 presync 补增量（可选，缩短停机）
node tmp/ssh_run.js 'bash /opt/sign-data/bin/migrate_storage_to_data.sh presync'

# 正式切换（脚本内部：停应用→终同步含数据库→校验DB搬到位→改名旧目录→建软链→起应用→验readyz）
node tmp/ssh_run.js 'bash /opt/sign-data/bin/migrate_storage_to_data.sh cutover'
```

cutover 脚本内置保护：
- 先检查 `/opt/sign-data/storage` 还是真实目录（已是软链则中止，防重复迁）；
- 检查 /data/storage 已有预同步数据（文件太少则中止，逼你先 presync）；
- 终同步失败 / 缺 workbench.sqlite 或 monthly.sqlite → **自动 `pm2 start` 恢复原状、不切换**；
- 切换后 `readyz≠200` 会打印回滚命令。
- 旧数据**改名保留**为 `/opt/sign-data/storage.old-<时间戳>`（不删！留作回滚，确认没问题后手动删）。

---

## 五、迁移后验证清单（cutover 完立刻逐条过）

```bash
# 1. 软链已生效、指向 /data
node tmp/ssh_run.js 'ls -la /opt/sign-data/storage; readlink -f /opt/sign-data/storage'
# 2. 应用健康
node tmp/ssh_run.js 'curl -s -o /dev/null -w "readyz=%{http_code}\n" http://localhost:3000/readyz'
# 3. 系统盘掉下来、大盘涨上去
node tmp/ssh_run.js 'df -h / /data | grep -E "vda2|vdb"'
```

浏览器人工验（最关键，直接打消「审核台/导出坏了」的担心）：
- [ ] 打开审核台，**能看到切片图**（批次内图片正常显示）；
- [ ] 点某客户「查看原图」，**原图能打开**；
- [ ] 跑一次**资料库导出/交付包**，下载打开确认**里面的图片在**；
- [ ] 建档传一张新图，确认**新图落到 /data**（`find /data/storage -newermt "-5 min" -name '*.jpg' | head`）；
- [ ] 结算一组，确认台账（monthly.sqlite 在 /data）写入正常。

全过 → 观察 1~2 天无异常，再删旧数据：
```bash
node tmp/ssh_run.js 'du -sh /opt/sign-data/storage.old-*; rm -rf /opt/sign-data/storage.old-*'
```

---

## 六、回滚（万一切换后不对）

```bash
# storage.old-<ts> 是迁移前的原始真实数据，原封不动还在系统盘
node tmp/ssh_run.js 'pm2 stop sign-workbench && rm /opt/sign-data/storage && mv /opt/sign-data/storage.old-<ts> /opt/sign-data/storage && pm2 start sign-workbench && sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/readyz'
```

因为原数据是**改名保留、没删**，回滚就是「删软链 + 把旧目录名字改回来」，秒级、零丢失。

---

## 七、注意事项 / 后续

- **COS 脚本不用改**：`cos_data_backup.sh` 里 `$STORAGE=/opt/sign-data/storage` 会自动跟随软链读写 /data。迁移后 COS 镜像照常。
- **未来部署不受影响**：`server_activate.sh` 每次建 `release/.../storage → /opt/sign-data/storage`，软链套软链透明。
- **90 天清理照常**：`cos_data_backup.sh` 的 `find $STORAGE ... -delete` 跟随软链删的是 /data 上的真实文件。
- **备份缺口已单独修复**（见 [[project_backup_apicost_2026-07]]），与本迁移无关。
- **顺带**：`/opt/sign-data/backups` 下 0706~0709 那几个失败夜留下的空壳目录可一并清（删备份目录要单独报备）。
- 迁移只动图片存储位置，**不改任何业务逻辑、不需要重新部署 release**。
