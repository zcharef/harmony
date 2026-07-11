import { parseSearchQuery } from './parse-search-query'

describe('parseSearchQuery', () => {
  it('returns plain free text when there are no filters', () => {
    expect(parseSearchQuery('hello world')).toEqual({
      q: 'hello world',
      from: undefined,
      in: undefined,
      has: [],
    })
  })

  it('extracts from:/in:/has: in any order, leaving the free-text remainder', () => {
    const parsed = parseSearchQuery('has:link from:@alice deploy in:#general logs')
    expect(parsed.from).toBe('alice')
    expect(parsed.in).toBe('general')
    expect(parsed.has).toEqual(['link'])
    expect(parsed.q).toBe('deploy logs')
  })

  it('treats filter keys case-insensitively', () => {
    const parsed = parseSearchQuery('FROM:@bob IN:#Random HAS:Image widget')
    expect(parsed.from).toBe('bob')
    expect(parsed.in).toBe('Random')
    expect(parsed.has).toEqual(['image'])
    expect(parsed.q).toBe('widget')
  })

  it('collects and dedupes multiple has: filters', () => {
    const parsed = parseSearchQuery('has:link has:image has:link pics')
    expect(parsed.has).toEqual(['link', 'image'])
    expect(parsed.q).toBe('pics')
  })

  it('drops an unknown has: value (never leaks it to free text)', () => {
    const parsed = parseSearchQuery('has:video clip')
    expect(parsed.has).toEqual([])
    expect(parsed.q).toBe('clip')
  })

  it('does NOT treat an email in the body as a from: filter', () => {
    const parsed = parseSearchQuery('email bob@alice.com about billing')
    expect(parsed.from).toBeUndefined()
    expect(parsed.q).toBe('email bob@alice.com about billing')
  })

  it('strips the leading @ / # decorations', () => {
    expect(parseSearchQuery('from:@carol').from).toBe('carol')
    expect(parseSearchQuery('in:#announcements').in).toBe('announcements')
    // bare (undecorated) values also work
    expect(parseSearchQuery('from:dave').from).toBe('dave')
    expect(parseSearchQuery('in:general').in).toBe('general')
  })

  it('ignores extraneous whitespace between tokens', () => {
    const parsed = parseSearchQuery('   from:@eve    hello    ')
    expect(parsed.from).toBe('eve')
    expect(parsed.q).toBe('hello')
  })
})
