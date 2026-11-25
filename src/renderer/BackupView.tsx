import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackupInfo, BackupPreview } from '../shared/types'
import { dayKey } from '../shared/views'
import { parseError } from './client'
import { formatDay } from './format'

const api = window.worktodo

export function BackupView(props: {
  unsaved: boolean
  today: string
  onRestore: () => Promise<boolean>
}) {
  const [list, setList] = useState<BackupInfo[]>([])
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState('')
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)

  const refresh = useCallback(async () => setList(await api.listBackups()), [])
  useEffect(() => {
    void refresh()
    return () => void api.cancelRestore()
  }, [refresh])
  useEffect(() => {
    if (preview) dialog.current?.showModal()
    else dialog.current?.close()
  }, [preview])

  const attempt = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage('')
    setFailed('')
    try {
      await action()
    } catch (e) {
      setFailed(parseError(e).text)
    } finally {
      setBusy(false)
    }
  }
  const choose = (name: string | null): void =>
    void attempt(async () => setPreview(await api.prepareRestore(name)))
  const cancel = (): void => {
    setPreview(null)
    void api.cancelRestore()
  }
  const when = (ms: number): string => {
    const d = new Date(ms)
    return `${formatDay(dayKey(ms), props.today)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const off = busy || props.unsaved

  return (
    <div className="backup">
      <section>
        <h2 className="group-title">手动备份</h2>
        <p className="hint">导出一个文件，可放到其他磁盘或 U 盘，换电脑或重装后用它恢复。</p>
        <button
          className="primary"
          disabled={off}
          onClick={() =>
            void attempt(async () => {
              const path = await api.exportBackup()
              if (path) setMessage(`已导出到 ${path}`)
            })
          }
        >
          导出备份
        </button>
        <button className="plain" disabled={off} onClick={() => choose(null)}>
          从文件恢复
        </button>
        {props.unsaved && <p className="hint">有修改尚未保存，保存后才能导出或恢复。</p>}
        {message && <p role="status">{message}</p>}
        {failed && (
          <p className="warn" role="alert">
            {failed}
          </p>
        )}
      </section>
      <section>
        <h2 className="group-title">本机备份</h2>
        <p className="hint">
          每天自动备份一次，保留最近 7 份；每次恢复前也会自动保存一份。
          <button className="plain" onClick={() => void attempt(() => api.openBackupFolder())}>
            打开所在文件夹
          </button>
        </p>
        {list.length === 0 && <p className="empty">还没有本机备份。</p>}
        <ul>
          {list.map((b) => (
            <li key={b.name} className="row" data-backup={b.name}>
              <div className="row-main">
                <span className="row-title">{when(b.time)}</span>
                <span className="row-note">{b.kind === 'auto' ? '自动备份' : '恢复前自动保存'}</span>
              </div>
              <button className="plain" disabled={off} onClick={() => choose(b.name)}>
                恢复
              </button>
            </li>
          ))}
        </ul>
      </section>
      <dialog ref={dialog} onClose={cancel} aria-label="确认恢复">
        {preview && (
          <>
            <p>
              用 {when(preview.time)} 的备份（{preview.count} 项待办）替换当前全部数据？当前数据会先自动保存一份。
            </p>
            <div className="dialog-actions">
              <button className="plain" autoFocus onClick={cancel}>
                取消
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  void attempt(async () => {
                    const ok = await props.onRestore()
                    setPreview(null)
                    if (ok) setMessage('已恢复。')
                    else setFailed('恢复没有成功，当前数据没有改变。')
                    await refresh()
                  })
                }
              >
                恢复
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  )
}
