export function getClientFileKey(file) {
  return [
    String(file?.webkitRelativePath || file?.name || '').replaceAll('\\', '/'),
    Number(file?.size || 0),
    Number(file?.lastModified || 0),
  ].join('::')
}

export function appendUniqueFiles(currentFiles = [], incomingFiles = []) {
  const nextFiles = Array.from(currentFiles || [])
  const seen = new Set(nextFiles.map((file) => getClientFileKey(file)))

  for (const file of Array.from(incomingFiles || [])) {
    const key = getClientFileKey(file)
    if (seen.has(key)) continue
    seen.add(key)
    nextFiles.push(file)
  }

  return nextFiles
}
