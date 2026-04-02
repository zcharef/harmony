export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
        'release',
      ],
    ],
    'scope-enum': [
      1,
      'always',
      ['chat', 'channels', 'servers', 'members', 'auth', 'ui', 'config', 'deps'],
    ],
    'subject-case': [2, 'always', 'lower-case'],
  },
}
