/**
 * 本侧保存重试
 * 调度室与管护班各自记账、互不代改：闸门写入归管护侧、走水计划写入归调度侧。
 * 任一侧 IndexedDB 瞬时保存失败（事务被抢占 / 锁冲突 / 磁盘抖动）只重试本侧操作，
 * 不触碰对方台账。数据级错误（约束、类型不对）立即抛出，不做无谓重试。
 */

/** 重试次数（首次执行 + 2 次重试） */
const DEFAULT_MAX_ATTEMPTS = 3

/** 基础退避（毫秒），逐次倍增：120 → 240 */
const BASE_BACKOFF_MS = 120

/** 触发重试的瞬时错误关键字（IndexedDB / 浏览器存储常见报错） */
const TRANSIENT_MARKS = ['timeout', 'quotaexceeded', 'internal error', 'database is closed', 'abort']

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 判断是否值得重试：仅瞬时故障重试，约束/键冲突等数据错误立即抛出 */
export function isTransientWriteError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const err = error as { name?: unknown; message?: unknown; inner?: { name?: unknown } }
  const name = typeof err.name === 'string' ? err.name : ''
  const message = typeof err.message === 'string' ? err.message : ''
  const innerName = typeof err.inner?.name === 'string' ? err.inner.name : ''
  const text = `${name} ${message} ${innerName}`.toLowerCase()
  return TRANSIENT_MARKS.some((mark) => text.includes(mark.toLowerCase()))
}

export interface RetryOptions {
  /** 台账侧别，仅用于错误信息 */
  side: '管护班闸门侧' | '调度室走水侧'
  maxAttempts?: number
}

/**
 * 本侧保存重试：指数退避（120ms、240ms），重试耗尽抛出带侧别说明的错误。
 */
export async function withSideRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts || !isTransientWriteError(error)) throw error
      await delay(BASE_BACKOFF_MS * 2 ** (attempt - 1))
    }
  }
  throw new Error(
    `${options.side}保存失败，已重试 ${maxAttempts} 次仍未成功：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}
