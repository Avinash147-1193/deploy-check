import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../index.mjs', import.meta.url))
const HAS_GIT = spawnSync('git', ['--version']).status === 0

const REPORT = {
  verdict: { code: 'partial', label: 'Almost: 1 thing to fix', summary: 'It will deploy once the items below are sorted.' },
  services: [{ name: 'web', path: '/', type: 'Full-stack app', framework: 'nextjs', port: 3000 }],
  findings: [
    { severity: 'fix', title: 'Add a health endpoint', why: 'A deploy waits for it.',
      fix: { text: 'Add a route that answers 200.', file: 'app/api/health/route.ts', language: 'ts', code: 'export function GET() {\n  return Response.json({ ok: true })\n}' } },
    { severity: 'tip', title: 'Pin the Node version' },
  ],
  env_needed: ['DATABASE_URL'],
  costs: [{ label: 'DigitalOcean', min: 6, max: 12 }, { label: 'AWS', min: 18, max: 30 }],
}
const SECURITY = {
  ready: true, expired: false,
  secrets: [{ kind: 'AWS access key', file: 'config.js', line: 3, preview: 'AKIA... (20 characters)' }],
  env_files: [], public_env: [{ service: 'web', path: '/', name: 'VITE_STRIPE_SECRET' }],
}

// A stand-in for the check service that records what arrives.
async function service({ verdict = 'partial', failUpload = null } = {}) {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://x')
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body })
      const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
      const report = { ...REPORT, verdict: { ...REPORT.verdict, code: verdict } }
      if (req.method === 'POST' && url.pathname === '/api/v1/check') {
        return send(200, { slug: 'abcdefghjk', status: 'queued', viewer_key: 'pubkey', url: 'https://thedploy.com/check/abcdefghjk' })
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/check/upload') {
        if (failUpload) return send(failUpload.status, { detail: failUpload.detail })
        return send(200, { slug: 'mnpqrstuvw', status: 'queued', viewer_key: 'uploadkey', url: null })
      }
      const polls = seen.filter((s) => s.path.endsWith('/status')).length
      if (url.pathname.endsWith('/status')) {
        return send(200, polls < 2
          ? { status: 'running', done: false, lines: [{ label: 'reading', text: '12 files' }], next: 1 }
          : { status: 'succeeded', done: true, lines: [{ label: 'verdict', text: 'Almost' }], next: 2 })
      }
      if (url.pathname.endsWith('/result')) {
        const upload = url.pathname.includes('mnpqrstuvw')
        return send(200, { status: 'succeeded', verdict, url: upload ? null : 'https://thedploy.com/check/abcdefghjk', report })
      }
      if (url.pathname.endsWith('/security')) return send(200, SECURITY)
      return send(404, { detail: 'nope' })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { api: `http://127.0.0.1:${server.address().port}/api/v1`, seen, close: () => new Promise((r) => server.close(r)) }
}

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, DEPLOY_CHECK_POLL_MS: '10', DEPLOY_CHECK_API: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-check-'))
  const git = (...args) => assert.equal(spawnSync('git', ['-C', dir, ...args]).status, 0, `git ${args.join(' ')}`)
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return dir
}

test('checks a public repository and prints the verdict, the fix, costs and security without previews', async () => {
  const api = await service()
  try {
    const { code, stdout, stderr } = await cli(['github.com/acme/shop', '--api', api.api])
    assert.equal(code, 0, stderr)
    assert.match(stdout, /Verdict: Almost: 1 thing to fix/)
    assert.match(stdout, /1\. Add a health endpoint/)
    assert.match(stdout, /Add a route that answers 200\./)
    assert.match(stdout, /In app\/api\/health\/route\.ts:/)
    assert.match(stdout, /return Response\.json\(\{ ok: true \}\)/)
    assert.ok(!stdout.includes('[object Object]'))
    assert.match(stdout, /DigitalOcean: \$6 to \$12/)
    assert.match(stdout, /AWS access key committed in config\.js:3/)
    assert.match(stdout, /VITE_STRIPE_SECRET is compiled into browser code/)
    assert.match(stdout, /Shareable result: https:\/\/thedploy\.com\/check\/abcdefghjk/)
    assert.ok(!stdout.includes('AKIA'), 'a secret preview must never be printed')
    assert.match(stderr, /reading: 12 files/)
    const start = api.seen.find((s) => s.path === '/api/v1/check')
    assert.deepEqual(JSON.parse(start.body.toString()), { repo: 'github.com/acme/shop', utm_source: 'deploy-check', utm_medium: 'cli' })
    assert.equal(api.seen.find((s) => s.path.endsWith('/security')).headers['x-check-key'], 'pubkey')
  } finally {
    await api.close()
  }
})

test('uploads a git archive of committed files only, and reads the private result with its key', { skip: !HAS_GIT }, async () => {
  const api = await service()
  const dir = gitRepo({ 'package.json': '{"name":"shop"}', 'index.js': 'console.log(1)' })
  writeFileSync(join(dir, 'uncommitted.txt'), 'not committed')
  try {
    const { code, stdout, stderr } = await cli([dir, '--api', api.api])
    assert.equal(code, 0, stderr)
    const upload = api.seen.find((s) => s.path === '/api/v1/check/upload')
    assert.equal(upload.headers['content-type'], 'application/gzip')
    assert.deepEqual([upload.body[0], upload.body[1]], [0x1f, 0x8b])
    assert.equal(upload.query.utm_source, 'deploy-check')
    assert.ok(upload.query.name.startsWith('deploy-check-'))
    const tar = spawnSync('tar', ['-tzf', '-'], { input: upload.body }).stdout.toString()
    assert.match(tar, /index\.js/)
    assert.doesNotMatch(tar, /uncommitted\.txt/)
    assert.doesNotMatch(tar, /\.git\//)
    for (const s of api.seen.filter((x) => x.method === 'GET')) assert.equal(s.headers['x-check-key'], 'uploadkey')
    assert.match(stderr, /only committed files are checked/)
    assert.doesNotMatch(stdout, /Shareable result/)
  } finally {
    await api.close()
  }
})

test('a folder that is not a git repository is refused before anything is sent', { skip: !HAS_GIT }, async () => {
  const api = await service()
  const dir = mkdtempSync(join(tmpdir(), 'not-git-'))
  try {
    const { code, stderr } = await cli([dir, '--api', api.api])
    assert.equal(code, 2)
    assert.match(stderr, /isn't inside a git repository/)
    assert.equal(api.seen.length, 0)
  } finally {
    await api.close()
  }
})

test('--fail-on decides the exit code', async () => {
  const api = await service({ verdict: 'partial' })
  try {
    assert.equal((await cli(['acme/shop', '--api', api.api, '--fail-on', 'never'])).code, 0)
    assert.equal((await cli(['acme/shop', '--api', api.api, '--fail-on', 'needs-work'])).code, 0)
    assert.equal((await cli(['acme/shop', '--api', api.api, '--fail-on', 'almost'])).code, 1)
    assert.equal((await cli(['acme/shop', '--api', api.api, '--fail-on', 'secrets'])).code, 1)
    assert.equal((await cli(['acme/shop', '--api', api.api, '--fail-on', 'sometimes'])).code, 2)
  } finally {
    await api.close()
  }
})

test('--json and --summary', async () => {
  const api = await service()
  const summary = join(mkdtempSync(join(tmpdir(), 'summary-')), 'summary.md')
  try {
    const { code, stdout } = await cli(['acme/shop', '--api', api.api, '--json', '--summary', summary])
    assert.equal(code, 0)
    const outcome = JSON.parse(stdout)
    assert.equal(outcome.result.verdict, 'partial')
    assert.equal(outcome.security.secrets[0].file, 'config.js')
    assert.equal(outcome.security.secrets[0].preview, undefined)
    const md = readFileSync(summary, 'utf8')
    assert.match(md, /## Deploy check: Almost: 1 thing to fix/)
    assert.match(md, /\| web \| Full-stack app \| nextjs \| 3000 \|/)
    assert.match(md, /1 committed credential\(s\): AWS access key/)
    assert.match(md, /```ts title="app\/api\/health\/route\.ts"/)
    assert.ok(!md.includes('[object Object]'))
    assert.ok(!md.includes('AKIA'))
  } finally {
    await api.close()
  }
})

test('the service address must be https, except on this machine', async () => {
  const { code, stderr } = await cli(['acme/shop', '--api', 'http://example.com/api/v1'])
  assert.equal(code, 2)
  assert.match(stderr, /must start with https/)
  const creds = await cli(['acme/shop', '--api', 'https://user:pass@example.com/api/v1'])
  assert.equal(creds.code, 2)
  assert.match(creds.stderr, /user name or password/)
})

test('a repository bigger than the upload cap is refused locally', { skip: !HAS_GIT }, async () => {
  const api = await service()
  const dir = gitRepo({ 'big.txt': 'x'.repeat(200000) + Math.random() })
  try {
    const { code, stderr } = await cli([dir, '--api', api.api], { DEPLOY_CHECK_MAX_BYTES: '50' })
    assert.equal(code, 2)
    assert.match(stderr, /bigger than/)
    assert.equal(api.seen.length, 0)
  } finally {
    await api.close()
  }
})

test("the service's own words reach the user", { skip: !HAS_GIT }, async () => {
  const api = await service({ failUpload: { status: 429, detail: "That's the daily limit for checks from your connection." } })
  const dir = gitRepo({ 'a.txt': 'a' })
  try {
    const { code, stderr } = await cli([dir, '--api', api.api])
    assert.equal(code, 2)
    assert.match(stderr, /daily limit/)
  } finally {
    await api.close()
  }
})

test('--version and --help', async () => {
  assert.equal((await cli(['--version'])).stdout.trim(), '0.1.0')
  assert.match((await cli(['--help'])).stdout, /Usage: deploy-check/)
  assert.equal((await cli(['--wat'])).code, 2)
})
