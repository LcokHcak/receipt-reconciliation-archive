import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

export function fetchBuckets(workspaceKey) {
  return api.get(`${base(workspaceKey)}/bill-match/buckets`)
}

export function runBucketMatch(workspaceKey, folder) {
  return api.post(`${base(workspaceKey)}/bill-match/run-bucket`, { folder }, {
    timeout: 10 * 60 * 1000,
  })
}

export function clearBucketBills(workspaceKey, folder) {
  return api.delete(`${base(workspaceKey)}/bill-match/buckets/${encodeURIComponent(folder)}`, {
    timeout: 2 * 60 * 1000,
  })
}
