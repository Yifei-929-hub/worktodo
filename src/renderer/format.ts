const WEEK = '日一二三四五六'

/** 例：3月10日 周日；不是今年时带年份。 */
export function formatDay(key: string, today: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const week = WEEK[new Date(y, m - 1, d).getDay()]
  const year = key.slice(0, 4) === today.slice(0, 4) ? '' : `${y}年`
  return `${year}${m}月${d}日 周${week}`
}
