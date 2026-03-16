import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '../../src')
const FEATURES_DIR = join(SRC_DIR, 'features')

/**
 * Architecture tests for type safety and API access patterns.
 *
 * These validate rules that static analysis alone cannot enforce:
 * - No direct Supabase data access from features
 * - No raw fetch() calls in features (must use generated SDK)
 * - No hardcoded URLs in source code
 *
 * Run with: just test-arch
 */

function getAllFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  const { readdirSync, statSync } = require('node:fs')
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

describe('Type Safety', () => {
  describe('no_direct_supabase_data_access', () => {
    it('should not use supabase.from() or supabase.rpc() in features', () => {
      const ALLOWLIST = [join(SRC_DIR, 'lib/supabase.ts')]
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        if (ALLOWLIST.includes(filePath)) continue

        const content = readFileSync(filePath, 'utf-8')
        if (/supabase\.from\(/.test(content) || /supabase\.rpc\(/.test(content)) {
          violations.push(relative(SRC_DIR, filePath))
        }
      }

      expect(
        violations,
        `Direct Supabase data access found in features. Use the generated API client instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_raw_fetch_in_features', () => {
    it('should not use raw fetch() calls in features', () => {
      const files = getAllFiles(FEATURES_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Match fetch( but not .fetch( (method on generated client) and not in comments
          if (/(?<!\w)fetch\(/.test(line) && !line.trimStart().startsWith('//')) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Raw fetch() calls found in features. Use the generated SDK from @/lib/api instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })

  describe('no_hardcoded_urls', () => {
    it('should not contain hardcoded http:// or https:// URLs in source', () => {
      const ALLOWLIST = [
        join(SRC_DIR, 'lib/env.ts'),
        join(SRC_DIR, 'lib/api-client.ts'),
      ]
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        if (ALLOWLIST.includes(filePath)) continue
        // Exclude test files
        if (filePath.includes('.test.') || filePath.includes('.spec.')) continue
        // Exclude generated API client
        if (filePath.includes(join('lib', 'api') + '/')) continue

        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Skip comment lines
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
          if (/https?:\/\//.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Hardcoded URLs found. Use env variables via src/lib/env.ts instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })
  })
})
