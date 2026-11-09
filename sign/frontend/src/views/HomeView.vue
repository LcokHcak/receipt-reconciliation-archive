<script setup>
// 工作台首页分发器(2026-07-18 首页分离):同一个 `/` 路由,按身份渲染两套首页。
//   管理员/财务 → AdminHomeView(管人:全局看板);finance 复用管理员版(拍板#7,数据只读)
//   审核员      → ReviewerHomeView(干活:我的任务)
// 路由名保持 'workbench'(LoginView/ReviewView/守卫都按名跳转,不能改)。
import { computed } from 'vue'

import { useAuthStore } from '../stores/auth'
import AdminHomeView from './home/AdminHomeView.vue'
import ReviewerHomeView from './home/ReviewerHomeView.vue'

const auth = useAuthStore()
const isGlobalRole = computed(() => ['admin', 'finance'].includes(auth.user?.role))
</script>

<template>
  <AdminHomeView v-if="isGlobalRole" />
  <ReviewerHomeView v-else />
</template>
