import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

const vendorChunks = ['vue', 'vue-router', 'pinia', 'axios']

// G0: F10 删了 v1 monthly,这里改成 v2 视图分组(build 失败修复)。
const monthlyChunks = [
  './src/views/v2/MonthlyV2View.vue',
  './src/views/v2/LedgerView.vue',
  './src/views/v2/BillsView.vue',
  './src/views/v2/GroupCodesView.vue',
  './src/views/v2/BillMatchView.vue',
  './src/views/v2/BillReviewView.vue',
  './src/views/v2/BrandActivityView.vue',
  './src/views/v2/ImportsView.vue',
  './src/views/v2/DeliveryView.vue',
  './src/views/v2/DeliveryCheckView.vue',
  './src/views/v2/ErrorsView.vue',
  './src/views/v2/AuditDashboardView.vue',
  './src/views/v2/LogsView.vue',
  './src/views/v2/BadcaseView.vue',
  './src/views/v2/ConflictsView.vue',
  './src/views/v2/UnreceivedView.vue',
  './src/views/v2/ManualEntryView.vue',
  './src/views/v2/AuditLogsView.vue',
]

const adminChunks = [
  './src/views/AdminDashboardView.vue',
  './src/views/AdminFeedbackView.vue',
  './src/views/AdminLogsView.vue',
  './src/views/AdminUsersView.vue',
]

const chunkGroups = [
  ['monthly', monthlyChunks],
  ['admin', adminChunks],
]

function normalizeChunkId(id) {
  return id.replaceAll('\\', '/').split('?')[0]
}

function matchesVendorChunk(id) {
  const normalizedId = normalizeChunkId(id)
  return (
    vendorChunks.some((module) => normalizedId.includes(`/node_modules/${module}/`)) ||
    normalizedId.includes('/node_modules/@vue/')
  )
}

function matchesChunkModules(id, modules) {
  const normalizedId = normalizeChunkId(id)
  return modules.some((module) => normalizedId.endsWith(module.slice(1)))
}

function manualChunks(id) {
  if (matchesVendorChunk(id)) {
    return 'vendor'
  }
  for (const [chunkName, modules] of chunkGroups) {
    if (matchesChunkModules(id, modules)) {
      return chunkName
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/app/dist/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../passport_review_workbench/app/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks,
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            {
              name: 'vendor',
              test: matchesVendorChunk,
              priority: 3,
            },
            {
              name: 'monthly',
              test: (id) => matchesChunkModules(id, monthlyChunks),
              priority: 2,
            },
            {
              name: 'admin',
              test: (id) => matchesChunkModules(id, adminChunks),
              priority: 2,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3218',
      '/storage': 'http://127.0.0.1:3218',
    },
  },
})
