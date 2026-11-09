<script setup>
import { computed, onMounted } from 'vue'

import { useAuthStore } from '../stores/auth'
import { useWorkbenchStore } from '../stores/workbench'

const auth = useAuthStore()
const workbench = useWorkbenchStore()

const roleLabel = computed(() => ({
  admin: '管理员',
  reviewer: '审核员',
  finance: '财务',
}[auth.user?.role] || auth.user?.role || '-'))

// signatureService computed 已删:恒返回 null 的遗骸(签字功能 2026-06-12 下线),lint 清理确认

onMounted(() => {
  if (!workbench.batches.length) {
    workbench.fetchBatches().catch(() => null)
  }
})
</script>

<template>
  <section class="page-title">
    <div>
      <h1>设置</h1>
      <p>账号信息、部署环境与系统状态。模型训练与部署能力计划中。</p>
    </div>
  </section>

  <section class="split-layout">
    <div class="panel">
      <div class="panel-header">
        <strong>当前账号</strong>
      </div>
      <div class="panel-body">
        <div class="field">
          <label>用户名</label>
          <div>{{ auth.user?.username || '-' }}</div>
        </div>
        <div class="field">
          <label>角色</label>
          <div>{{ roleLabel }}</div>
        </div>
        <div class="field">
          <label>会话状态</label>
          <div>{{ auth.user ? '已登录' : '未登录' }}</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <strong>工作区概况</strong>
      </div>
      <div class="panel-body">
        <div class="field">
          <label>当前批次数</label>
          <div>{{ workbench.batches.length }}</div>
        </div>
        <div class="field">
          <label>文件总数</label>
          <div>{{ workbench.metrics.files }}</div>
        </div>
        <div class="field">
          <label>已通过文件</label>
          <div>{{ workbench.metrics.approved }}</div>
        </div>
      </div>
    </div>
  </section>

  <section class="panel" style="margin-top: 14px;">
    <div class="panel-header">
      <strong>即将提供</strong>
      <span class="status">规划中</span>
    </div>
    <div class="panel-body">
      <ul class="muted" style="padding-left: 16px; line-height: 1.8;">
        <li>模型训练中心（分类 / 切图 / OCR）</li>
        <li>部署与同步（Lora、微调、快照）</li>
        <li>用户与角色管理</li>
        <li>审计日志查询</li>
      </ul>
    </div>
  </section>
</template>
