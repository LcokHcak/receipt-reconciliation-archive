<script setup>
/**
 * MoreMenu — "更多"下拉菜单，收纳次要 / 危险操作。
 *
 * 用法：
 *   <MoreMenu>
 *     <button @click="doSomething">恢复审核</button>
 *     <hr />
 *     <button class="danger" @click="doDanger">删除文件</button>
 *   </MoreMenu>
 *
 * - 子元素通过 default slot 直接插入
 * - 点击菜单外任意位置自动关闭
 * - 菜单项按钮自带样式，可用 class="danger" 标红
 */

import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  placement: { type: String, default: 'bottom' },
  // 触发按钮文案(默认「更多」);建档页把它当「+ 新建」下拉复用,免再造一个菜单组件
  label: { type: String, default: '更多' },
})

const open = ref(false)
const rootRef = ref(null)

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

function handleDocClick(event) {
  if (!rootRef.value) return
  if (!rootRef.value.contains(event.target)) close()
}

onMounted(() => {
  document.addEventListener('click', handleDocClick)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocClick)
})
</script>

<template>
  <div ref="rootRef" class="more-menu" @click.stop>
    <button class="ghost-button trigger" type="button" @click="toggle">
      {{ props.label }} <span class="caret">▾</span>
    </button>
    <div v-if="open" :class="['menu-panel', `placement-${props.placement}`]" @click="close">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.more-menu {
  position: relative;
  display: inline-block;
}

.trigger .caret {
  margin-left: 4px;
  font-size: 10px;
}

.menu-panel {
  position: absolute;
  right: 0;
  min-width: 180px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  padding: 6px 0;
  z-index: 1000;
}

.menu-panel.placement-bottom {
  top: calc(100% + 4px);
}

.menu-panel.placement-top {
  bottom: calc(100% + 4px);
}

.menu-panel :deep(button) {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}

.menu-panel :deep(button:hover) {
  background: var(--surface-soft);
}

.menu-panel :deep(button.danger) {
  color: var(--danger);
}

.menu-panel :deep(button.danger:hover) {
  background: #fce4e4;
}

.menu-panel :deep(button:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}

.menu-panel :deep(hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 4px 0;
}
</style>
