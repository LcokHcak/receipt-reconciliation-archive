import api from './client'
import { postWithRetry } from './uploadRetry'

export function fetchCustomerLibraryState() {
  return api.get('/customer-library/state')
}

export function fetchWorkspaces() {
  return api.get('/customer-library/workspaces')
}

export function fetchWorkspaceCustomers(workspaceKey) {
  return api.get(`/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/customers`)
}

export function createWorkspace(workspaceKey) {
  return api.post('/customer-library/workspaces', { workspaceKey })
}

export function deleteWorkspace(workspaceKey) {
  return api.delete(`/customer-library/workspaces/${encodeURIComponent(workspaceKey)}`)
}

export function createCustomerFromFiles({ workspaceKey, agentName, files, batchId = '', onUploadProgress = null }) {
  // 瞬断自动重试(uploadRetry):FormData 在工厂里每次重建,不跨次复用
  return postWithRetry(() => {
    const formData = new FormData()
    formData.append('workspaceKey', workspaceKey)
    formData.append('agentName', agentName)
    if (batchId) {
      formData.append('batchId', batchId) // 批次前置:后端强制要求先建/选批次
    }
    for (const file of files) {
      formData.append('files', file)
    }
    return api.post('/customer-library/customers/upload', formData, {
      timeout: 10 * 60 * 1000,
      onUploadProgress,
    })
  })
}

export function appendCustomerImages({ workspaceKey, customerId, batchId = '', files, onUploadProgress = null }) {
  // 瞬断自动重试(uploadRetry):FormData 在工厂里每次重建,不跨次复用
  return postWithRetry(() => {
    const formData = new FormData()
    formData.append('workspaceKey', workspaceKey)
    formData.append('customerId', customerId)
    if (batchId) {
      formData.append('batchId', batchId)
    }
    for (const file of files) {
      formData.append('files', file)
    }
    return api.post(
      `/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/customers/${encodeURIComponent(customerId)}/images/upload`,
      formData,
      {
        timeout: 10 * 60 * 1000,
        onUploadProgress,
      }
    )
  })
}

export function deleteCustomer(workspaceKey, customerId) {
  return api.delete(`/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/customers/${encodeURIComponent(customerId)}`)
}

export function preprocessWorkspace(workspaceKey) {
  return api.post(
    `/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/preprocess`,
    null,
    { timeout: 10 * 60 * 1000 }
  )
}

export function preprocessCustomer(workspaceKey, customerId) {
  return api.post(
    `/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/customers/${encodeURIComponent(customerId)}/preprocess`,
    null,
    { timeout: 10 * 60 * 1000 }
  )
}

export function importWorkspaceToBatch({
  workspaceKey,
  batchName,
  monthlyWorkspaceKey = '',
  groupCodeImportJobId = '',
  groupCodeSourceFile = '',
  groupCodeFile = null,
  allowEmpty = false,
}) {
  const body = new FormData()
  body.append('workspaceKey', workspaceKey)
  body.append('batchName', batchName || '')
  if (monthlyWorkspaceKey) body.append('monthlyWorkspaceKey', monthlyWorkspaceKey)
  if (groupCodeImportJobId) body.append('groupCodeImportJobId', groupCodeImportJobId)
  if (groupCodeSourceFile) body.append('groupCodeSourceFile', groupCodeSourceFile)
  if (groupCodeFile) body.append('groupCodeFile', groupCodeFile)
  if (allowEmpty) body.append('allowEmpty', 'true')
  return api.post(
    '/customer-library/import-workspace',
    body,
    { timeout: 10 * 60 * 1000 }
  )
}

export function fetchLibraryOrphans() {
  return api.get('/customer-library/cleanup/orphans')
}

export function deleteLibraryOrphans(items) {
  return api.post('/customer-library/cleanup/delete', { items })
}

export function uploadBatchGroupCode({ batchId, file, onUploadProgress = null }) {
  // 瞬断自动重试:换表是幂等操作(同文件重传=同解析结果),重试零风险
  return postWithRetry(() => {
    const body = new FormData()
    body.append('groupCodeFile', file)
    return api.post(
      `/customer-library/batches/${encodeURIComponent(batchId)}/group-code`,
      body,
      { timeout: 10 * 60 * 1000, onUploadProgress }
    )
  })
}

export function appendWorkspaceToBatch({ workspaceKey, batchId }) {
  return api.post(
    '/customer-library/append-workspace',
    { workspaceKey, batchId },
    { timeout: 10 * 60 * 1000 }
  )
}

export function appendCustomerToBatch({ workspaceKey, customerId, batchId }) {
  return api.post(
    '/customer-library/append-customer',
    { workspaceKey, customerId, batchId },
    { timeout: 10 * 60 * 1000 }
  )
}

export function buildCustomerImageUrl({ workspaceKey, customerId, imageId }) {
  return `/api/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/customers/${encodeURIComponent(customerId)}/images/${encodeURIComponent(imageId)}/file`
}

export function confirmCustomerImage({ workspaceKey, customerId, imageId, status = 'accepted' }) {
  return api.post(
    `/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/customers/${encodeURIComponent(customerId)}/images/${encodeURIComponent(imageId)}/review`,
    { status }
  )
}

export function deleteCustomerImage({ workspaceKey, customerId, imageId }) {
  return api.delete(
    `/customer-library/workspaces/${encodeURIComponent(workspaceKey)}/customers/${encodeURIComponent(customerId)}/images/${encodeURIComponent(imageId)}`
  )
}
