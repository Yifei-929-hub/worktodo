import { useState } from 'react'

export function QuickAdd(props: { hint: string; onAdd: (title: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  return (
    <form
      className="quick"
      onSubmit={(e) => {
        e.preventDefault()
        // 立即清空，避免重复回车添加多条；失败时还原
        const value = text
        if (value === '') return
        setText('')
        void props.onAdd(value).then((ok) => {
          if (!ok) setText((current) => (current === '' ? value : current))
        })
      }}
    >
      <input
        aria-label="快速添加"
        placeholder={props.hint}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit">添加</button>
    </form>
  )
}
