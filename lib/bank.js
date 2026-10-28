// 一个仓库一个 bank：默认 `coding-agent::{project}`，与厂商插件的默认值一致，
// 这样两代插件（云端版 / 本地版）看的是同一份记忆，切换不用迁移。
import { basename } from 'node:path'

export function projectName(cwd) {
  const name = basename(cwd || process.cwd())
  // bank id 会进 URL，保住可读性但别留空格与分隔符
  return (name || 'workspace').replace(/[^\w.-]+/g, '-')
}

export function bankIdFor(settings, cwd) {
  if (settings.bankId) return settings.bankId
  const template = settings.bankTemplate || 'coding-agent::{project}'
  return template.replaceAll('{project}', projectName(cwd))
}
