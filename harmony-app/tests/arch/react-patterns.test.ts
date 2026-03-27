import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src')
const FEATURES_DIR = join(SRC_DIR, 'features')

/**
 * Architecture tests for React coding patterns.
 *
 * These validate rules that enforce consistency and prevent common pitfalls:
 * - No inline styles in feature code
 * - Barrel exports must be pure re-exports (no logic)
 * - No reset() inside useEffect (load-then-render pattern required)
 * - No complex boolean state combinations with negation
 *
 * Run with: just test-arch
 */

function getAllFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath)
    }
  }
  return files
}

/** WHY: Shared line-scanning helper reduces cognitive complexity in each test. */
function scanFilesForViolations(
  files: string[],
  matcher: (line: string, lineIndex: number, filePath: string) => string | null,
): string[] {
  const violations: string[] = []
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const result = matcher(lines[i], i, filePath)
      if (result !== null) violations.push(result)
    }
  }
  return violations
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

describe('React Patterns', () => {
  describe('no_inline_styles', () => {
    it('should not use inline styles in tsx files', () => {
      // WHY allowlist: @tanstack/react-virtual REQUIRES inline styles for dynamic
      // pixel positioning (getTotalSize, translateY). No Tailwind equivalent exists.
      const ALLOWLIST = [join(SRC_DIR, 'features/chat/chat-area.tsx')]
      const files = getAllFiles(SRC_DIR, ['.tsx']).filter((f) => !ALLOWLIST.includes(f))

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        if (/style=\{\{/.test(line) || /style=\{[^{]/.test(line)) {
          return `${relative(SRC_DIR, filePath)}:${i + 1}`
        }
        return null
      })

      expect(
        violations,
        `Inline styles found. Use Tailwind CSS classes instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_logic_in_barrel_exports', () => {
    it('should only contain re-exports in feature index.ts files', () => {
      if (!existsSync(FEATURES_DIR)) return

      const LOGIC_PATTERNS = [
        /\buseState\b/,
        /\buseEffect\b/,
        /\buseQuery\b/,
        /\buseMutation\b/,
        /\bReact\./,
        /<[A-Z]/,
        /=>/,
        /\bfunction\s+/,
      ]

      const featureDirs = readdirSync(FEATURES_DIR).filter((name) =>
        statSync(join(FEATURES_DIR, name)).isDirectory(),
      )

      const violations = collectBarrelViolations(featureDirs, LOGIC_PATTERNS)

      expect(
        violations,
        `Barrel exports should only contain re-exports, no logic.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_reset_in_useEffect', () => {
    it('should not call reset() inside useEffect in features', () => {
      const files = getAllFiles(FEATURES_DIR, ['.tsx'])
      const violations = collectResetInEffectViolations(files)

      expect(
        violations,
        `reset() called inside useEffect. Use the load-then-render pattern instead (see CLAUDE.md 4.4).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_complex_boolean_state', () => {
    it('should not combine boolean state with negation patterns in features', () => {
      const files = getAllFiles(FEATURES_DIR, ['.tsx'])

      const COMPLEX_PATTERNS = [
        /&&\s*!is(?:Error|Pending|Loading|Fetching)/,
        /!is(?:Error|Pending|Loading|Fetching)\s*&&/,
        /is(?:Loading|Pending)\s*&&\s*!is(?:Error|Pending|Loading|Fetching)/,
      ]

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        for (const pattern of COMPLEX_PATTERNS) {
          if (pattern.test(line)) return `${relative(SRC_DIR, filePath)}:${i + 1}`
        }
        return null
      })

      expect(
        violations,
        `Complex boolean state with negation found. Use TanStack Query status checks or derive state explicitly.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('query_key_factory_enforcement', () => {
    it('should use query key factory, not inline arrays (ADR-029)', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])

      const violations = scanFilesForViolations(files, (line, i, filePath) => {
        if (isCommentLine(line)) return null
        if (/queryKey:\s*\[/.test(line)) return `${relative(SRC_DIR, filePath)}:${i + 1}`
        return null
      })

      expect(
        violations,
        `Inline queryKey arrays found. Use queryKeys factory from @/lib/query-keys instead (ADR-029).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('type_assertion_enforcement', () => {
    it('should use satisfies over as Type assertions (ADR-035)', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx']).filter((f) => !f.includes('.test.'))
      const violations = scanFilesForViolations(files, matchTypeAssertion)

      expect(
        violations,
        `Type assertions with 'as Type' found. Use 'satisfies Type' or fix the actual type (ADR-035).\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })
})

// WHY: Extracted to reduce cognitive complexity of the barrel-exports test.
function collectBarrelViolations(featureDirs: string[], logicPatterns: RegExp[]): string[] {
  const violations: string[] = []

  for (const featureName of featureDirs) {
    const indexPath = join(FEATURES_DIR, featureName, 'index.ts')
    if (!existsSync(indexPath)) continue

    const content = readFileSync(indexPath, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim().length > 0)

    for (const line of lines) {
      const trimmed = line.trim()
      if (isCommentLine(trimmed)) continue
      checkBarrelLine(trimmed, indexPath, logicPatterns, violations)
    }
  }

  return violations
}

function checkBarrelLine(
  trimmed: string,
  indexPath: string,
  logicPatterns: RegExp[],
  violations: string[],
): void {
  if (!trimmed.startsWith('export ')) {
    violations.push(`${relative(SRC_DIR, indexPath)}: non-export statement: "${trimmed}"`)
    return
  }

  for (const pattern of logicPatterns) {
    if (pattern.test(trimmed)) {
      violations.push(`${relative(SRC_DIR, indexPath)}: logic detected (${pattern}): "${trimmed}"`)
    }
  }
}

// WHY: Extracted to reduce cognitive complexity of the reset-in-useEffect test.
function collectResetInEffectViolations(files: string[]): string[] {
  const violations: string[] = []

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8')
    const useEffectRegex = /useEffect\(\s*\(\)\s*=>\s*\{/g
    let match: RegExpExecArray | null = useEffectRegex.exec(content)

    while (match !== null) {
      const effectBody = extractBracedBlock(content, match.index + match[0].length)
      if (/\breset\(/.test(effectBody)) {
        const lineNumber = content.slice(0, match.index).split('\n').length
        violations.push(`${relative(SRC_DIR, filePath)}:${lineNumber}`)
      }
      match = useEffectRegex.exec(content)
    }
  }

  return violations
}

// WHY: Extracts content within a braced block starting at the given position.
function extractBracedBlock(content: string, startIndex: number): string {
  let depth = 1
  let pos = startIndex

  while (pos < content.length && depth > 0) {
    if (content[pos] === '{') depth++
    if (content[pos] === '}') depth--
    pos++
  }

  return content.slice(startIndex, pos - 1)
}

const ALLOWED_AS_PATTERNS = [/ as const\b/, / as unknown\b/, / as never\b/, / as React\./]

// WHY: Extracted to reduce cognitive complexity of the type_assertion_enforcement test.
function matchTypeAssertion(line: string, lineIndex: number, filePath: string): string | null {
  if (isCommentLine(line)) return null
  if (/\bimport\s/.test(line)) return null
  if (!/ as /.test(line)) return null
  for (const allowed of ALLOWED_AS_PATTERNS) {
    if (allowed.test(line)) return null
  }
  return `${relative(SRC_DIR, filePath)}:${lineIndex + 1}`
}
