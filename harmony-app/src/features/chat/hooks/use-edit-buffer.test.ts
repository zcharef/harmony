import { act, renderHook } from '@testing-library/react'
import { useEditBuffer } from './use-edit-buffer'

describe('useEditBuffer', () => {
  it('seeds the buffer with the current content (unescaped) when editing opens', () => {
    const { result, rerender } = renderHook(
      ({ content, isEditing }) => useEditBuffer(content, isEditing),
      { initialProps: { content: 'hello', isEditing: false } },
    )

    // Message edited remotely (SSE/AutoMod) BEFORE the editor is opened.
    rerender({ content: 'masked \\*word\\*', isEditing: false })
    rerender({ content: 'masked \\*word\\*', isEditing: true })

    expect(result.current.editContent).toBe('masked *word*')
  })

  it('does not clobber the draft when content changes while the editor is open', () => {
    const { result, rerender } = renderHook(
      ({ content, isEditing }) => useEditBuffer(content, isEditing),
      { initialProps: { content: 'original', isEditing: true } },
    )

    act(() => {
      result.current.setEditContent('user draft in progress')
    })

    // Remote edit arrives while the editor is open — draft wins (ADR-045
    // form-input exception).
    rerender({ content: 'remotely changed', isEditing: true })

    expect(result.current.editContent).toBe('user draft in progress')
  })

  it('reseeds with the new content on close and reopen', () => {
    const { result, rerender } = renderHook(
      ({ content, isEditing }) => useEditBuffer(content, isEditing),
      { initialProps: { content: 'first', isEditing: true } },
    )
    expect(result.current.editContent).toBe('first')

    rerender({ content: 'first', isEditing: false })
    rerender({ content: 'second', isEditing: false })
    rerender({ content: 'second', isEditing: true })

    expect(result.current.editContent).toBe('second')
  })
})
