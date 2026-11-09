# Sign Workbench

签证/小票 OCR 审核 + 月度对账交付系统。

## 先读这里

后续 agent 或开发者先读：

```text
AGENT_SHARED_MEMORY.md
```

这份共享记忆是当前业务流程、部署方式、已知风险和最新变更的入口。旧的 `agent_docs/`、历史方案和执行 prompt 已从仓库清理；需要追历史时看 git log。

## 当前主线

- 日度图片收件、OCR、审核、桥接入月度台账
- 团号匹配、待补救、台账状态流转
- 四个账单桶导入、扣点、模式归类、账单匹配
- 未收、字段冲突、异常核对、merge
- 月度交付包、客户资料包、导出与审计

## 常用命令

```powershell
npm.cmd --prefix frontend run build
npm.cmd run lint
npm.cmd test
node scripts/deploy_push.js
```

## 重要路径

- 后端组合入口：`workbench_server.js`
- Express 工厂：`server/create_app.js`
- 月度路由：`routes/monthly/`
- 月度服务：`services/monthly/`
- Vue 前端：`frontend/src/`
- Vue 构建输出：`passport_review_workbench/app/dist/`
- 部署脚本：`scripts/deploy_push.js`、`scripts/server_activate.sh`
- 当前共享记忆：`AGENT_SHARED_MEMORY.md`
