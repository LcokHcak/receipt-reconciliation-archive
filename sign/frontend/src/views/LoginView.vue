<script setup>
import { computed, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '../stores/auth'
import { readPendingDraft, clearPendingDraft } from '../api/client'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const form = reactive({
  username: '',
  password: '',
})
const pendingDraft = readPendingDraft()
const draftHint = computed(() => {
  if (!pendingDraft) return ''
  const t = new Date(pendingDraft.ts).toLocaleTimeString('zh-CN')
  return `${t} 你在 ${pendingDraft.pathname} 提交时被踢了。登录后会回到这页，刚才填的内容已暂存在浏览器。`
})

watch(() => [form.username, form.password], () => {
  if (auth.error) {
    auth.error = ''
  }
})

async function submit() {
  try {
    await auth.login(form)
  } catch {
    // auth.error is already set by the store; swallow so the browser does
    // not log an unhandled rejection.
    return
  }
  // 优先回到 redirect / 草稿来源，登录成功后由调用方决定要不要清草稿
  const target = route.query.redirect
    || (pendingDraft && pendingDraft.pathname)
    || { name: 'workbench' }
  // 草稿的具体回填由各编辑页自己读 readPendingDraft；这里不在登录页粗
  // 暴清掉，否则用户下一秒就读不到了。
  router.push(target)
}

function dismissDraft() {
  clearPendingDraft()
  // force re-render hint
  window.location.reload()
}
</script>

<template>
  <main class="login-screen">
    <section class="panel login-panel">
      <div class="panel-header">
        <strong>收票对账系统</strong>
        <span class="status">登录</span>
      </div>
      <form class="panel-body" @submit.prevent="submit">
        <div v-if="draftHint" class="draft-hint">
          ⚠️ {{ draftHint }}
          <button type="button" class="ghost-button" @click="dismissDraft">丢弃草稿</button>
        </div>
        <div class="field">
          <label>用户名</label>
          <input v-model="form.username" name="username" autocomplete="username" required>
        </div>
        <div class="field" style="margin-top: 12px;">
          <label>密码</label>
          <input v-model="form.password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <p v-if="auth.error" class="error-text">{{ auth.error }}</p>
        <button class="primary-button" type="submit" :disabled="auth.loading">
          {{ auth.loading ? '登录中' : '登录' }}
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.draft-hint {
  background: #fef3c7;
  color: #92400e;
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
