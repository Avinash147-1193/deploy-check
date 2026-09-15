#!/usr/bin/env node
// deploy-check: will this repository deploy?
//
//   deploy-check                    check the git repository you're in (its committed files)
//   deploy-check ./path             check another local git repository
//   deploy-check github.com/o/r     check a public repository without downloading it
//
// What it tells you: the services it found and how they build, start and listen; what would stop a deploy,
// each with the fix; the environment variables to supply; committed secrets and secret keys compiled into
// browser code; and what it would cost a month in your own DigitalOcean, AWS, Google Cloud or Azure account.
//
// How: the checks run on The Deployer's free check service (https://thedploy.com/check), so this file has no
// dependencies and never needs updating when a check improves. For a local repository it sends a
// `git archive` of HEAD, which holds committed files only, never your uncommitted changes, ignored files or
// .git history. That upload is private: only this run can read the result, the archive is deleted as soon
// as the check finishes, and the report is deleted after seven days.
//
// Exit codes: 0 checked, 1 checked and --fail-on matched, 2 couldn't check.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const VERSION = '0.1.0'
const DEFAULT_API = 'https://app.thedploy.com/api/v1'
const APP_SIGNUP = 'https://portal.thedploy.com/auth?utm_source=deploy-check&utm_medium=cli'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const FAIL_ON = new Set(['never', 'needs-work', 'almost', 'secrets'])
const REPO = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/\S+$|^git@(?:github\.com|gitlab\.com|bitbucket\.org):\S+$/i
const positiveNumber = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback)
const MAX_UPLOAD_BYTES = positiveNumber(process.env.DEPLOY_CHECK_MAX_BYTES, 20 * 1024 * 1024)
const POLL_MS = positiveNumber(process.env.DEPLOY_CHECK_POLL_MS, 2000)
const TIMEOUT_MS = positiveNumber(process.env.DEPLOY_CHECK_TIMEOUT_MS, 300000)

const HELP = `deploy-check ${VERSION}: will this repository deploy?

Usage: deploy-check [path or public repository] [options]

  --json               print the whole result as JSON
  --summary <file>     append a Markdown summary (GitHub Actions: "$GITHUB_STEP_SUMMARY")
  --fail-on <when>     exit 1 when: needs-work, almost (almost or needs work), secrets, or never (default)
  --quiet              don't print progress
  --api <url>          the check service (default ${DEFAULT_API}); also DEPLOY_CHECK_API
  --version, --help

A local repository is sent as a git archive of its committed files. The result is private to this run.
`

class Stop extends Error {
  constructor(message, code = 2) {
    super(message)
    this.code = code
  }
}

function parseArgs(argv) {
  const opts = { target: '', json: false, summary: '', failOn: 'never', quiet: false, api: process.env.DEPLOY_CHECK_API || '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Stop(`${arg} needs a value. See deploy-check --help.`)
      return argv[++i]
    }
    if (arg === '--json') opts.json = true
    else if (arg === '--quiet') opts.quiet = true
    else if (arg === '--summary') opts.summary = value()
    else if (arg === '--fail-on') opts.failOn = value()
    else if (arg === '--api') opts.api = value()
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--version') opts.version = true
    else if (arg.startsWith('--')) throw new Stop(`Unknown option ${arg}. See deploy-check --help.`)
    else if (!opts.target) opts.target = arg
    else throw new Stop('Give one path or repository at a time.')
  }
  if (!FAIL_ON.has(opts.failOn)) throw new Stop('--fail-on is one of: never, needs-work, almost, secrets.')
  return opts
}

function apiBase(setting) {
  if (!setting) return DEFAULT_API
  let url
  try {
    url = new URL(setting)
  } catch {
    throw new Stop("The check service address isn't a valid URL.")
  }
  if (url.username || url.password) throw new Stop("The check service address can't contain a user name or password.")
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new Stop('The check service address must start with https://. Plain http:// only works for localhost.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Stop("The check service address isn't http(s).")
  return url.toString().replace(/\/+$/, '')
}

// --------------------------------------------------------------------------- the service

async function call(base, method, path, { json, body, key, contentType } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': `deploy-check/${VERSION}` }
  if (key) headers['X-Check-Key'] = key
  let payload = body
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(json)
  } else if (contentType) {
    headers['Content-Type'] = contentType
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  let response
  try {
    response = await fetch(`${base}${path}`, { method, headers, body: payload, signal: controller.signal, redirect: 'error' })
  } catch (err) {
    throw new Stop(`Couldn't reach the check service (${err.name === 'AbortError' ? 'timed out' : err.message}).`)
  } finally {
    clearTimeout(timer)
  }
  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : `The check service answered ${response.status}.`
    throw new Stop(detail)
  }
  return data
}

function run(command, args, { cwd, limit } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    const chunks = []
    let size = 0
    let err = ''
    let tooBig = false
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (limit && size > limit) {
        tooBig = true
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stdout: Buffer.concat(chunks), stderr: err, tooBig }))
  })
}

async function archiveOf(dir) {
  let top
  try {
    top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
  } catch {
    throw new Stop('deploy-check needs git to read a local repository. Install git, or check a public repository instead.')
  }
  if (top.code !== 0) {
    throw new Stop(`${dir} isn't inside a git repository. deploy-check reads committed files only: run it in a repository with at least one commit, or give it a public repository address.`)
  }
  const root = top.stdout.toString().trim()
  const archive = await run('git', ['-C', root, 'archive', '--format=tar.gz', 'HEAD'], { limit: MAX_UPLOAD_BYTES })
  if (archive.tooBig) {
    throw new Stop(`The committed files are bigger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB compressed. Push the repository and check it by its public address, or scan it in The Deployer, where size isn't capped.`)
  }
  if (archive.code !== 0) {
    throw new Stop("Couldn't read the committed files. Does the repository have at least one commit?")
  }
  const status = await run('git', ['-C', root, 'status', '--porcelain'])
  return { root, name: basename(root), data: archive.stdout, dirty: status.code === 0 && status.stdout.length > 0 }
}

async function follow(base, slug, key, say) {
  const started = Date.now()
  let after = 0
  for (;;) {
    const status = await call(base, 'GET', `/check/${encodeURIComponent(slug)}/status?after=${after}`, { key })
    for (const line of status.lines || []) {
      const text = [line.label, line.text].filter(Boolean).join(': ')
      if (text) say(`  ${text}`)
    }
    after = typeof status.next === 'number' ? status.next : after
    if (status.done) return status
    if (Date.now() - started > TIMEOUT_MS) throw new Stop('The check took too long. Try again in a few minutes.')
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

async function check(opts) {
  const base = apiBase(opts.api)
  const say = opts.quiet || opts.json ? () => {} : (text) => process.stderr.write(`${text}\n`)
  const target = opts.target || '.'
  let started
  let mode
  if (existsSync(target) && statSync(target).isDirectory()) {
    mode = 'local'
    const archive = await archiveOf(resolve(target))
    if (archive.dirty) say('Note: only committed files are checked. You have uncommitted changes.')
    say(`Checking ${archive.name} (${Math.max(1, Math.round(archive.data.length / 1024))} KB of committed files)`)
    const query = new URLSearchParams({ name: archive.name, utm_source: 'deploy-check', utm_medium: 'cli' })
    started = await call(base, 'POST', `/check/upload?${query}`, { body: archive.data, contentType: 'application/gzip' })
  } else if (REPO.test(target) || /^[\w.-]+\/[\w.-]+$/.test(target)) {
    mode = 'repository'
    say(`Checking ${target}`)
    started = await call(base, 'POST', '/check', { json: { repo: target, utm_source: 'deploy-check', utm_medium: 'cli' } })
  } else {
    throw new Stop(`${target} isn't a folder here or a repository address like github.com/owner/repo.`)
  }
  const key = started.viewer_key || ''
  const status = await follow(base, started.slug, key, say)
  const result = await call(base, 'GET', `/check/${encodeURIComponent(started.slug)}/result`, { key })
  let security = null
  if (key && status.status === 'succeeded') {
    const details = await call(base, 'GET', `/check/${encodeURIComponent(started.slug)}/security`, { key })
    if (details.ready && !details.expired) {
      // Kinds and places only. A masked preview still doesn't belong in a CI log.
      security = {
        secrets: (details.secrets || []).map((s) => ({ kind: s.kind, file: s.file, line: s.line })),
        env_files: (details.env_files || []).map((f) => ({ file: f.file, keys: f.keys || [] })),
        public_env: (details.public_env || []).map((e) => ({ name: e.name, service: e.service })),
      }
    }
  }
  return { version: VERSION, mode, target, slug: started.slug, status: result.status, url: result.url || null, result, security }
}

// --------------------------------------------------------------------------- output

const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`

// A fix is { text, file, language, code } from the check service; older answers may carry a plain string.
function fixLines(fix, indent) {
  if (!fix) return []
  if (typeof fix === 'string') return fix.split('\n').map((l) => `${indent}${l}`)
  const out = []
  if (fix.text) out.push(...String(fix.text).split('\n').map((l) => `${indent}${l}`))
  if (fix.code) {
    if (fix.file) out.push(`${indent}In ${fix.file}:`)
    out.push(...String(fix.code).split('\n').map((l) => `${indent}  ${l}`))
  }
  return out
}

function lines(outcome) {
  const report = outcome.result.report || {}
  const out = []
  if (outcome.status !== 'succeeded') {
    out.push(`Couldn't check it: ${outcome.result.error || 'the check failed.'}`)
    return out
  }
  const verdict = report.verdict || {}
  out.push('', `Verdict: ${verdict.label || outcome.result.verdict || 'checked'}`)
  if (verdict.summary) out.push(verdict.summary)
  const services = report.services || []
  if (services.length) {
    out.push('', 'Services:')
    for (const s of services) {
      const bits = [s.type, s.framework || s.language, s.port ? `port ${s.port}` : ''].filter(Boolean)
      out.push(`  - ${s.name || s.path || 'app'}${bits.length ? ` (${bits.join(', ')})` : ''}`)
    }
  }
  const findings = report.findings || []
  const fixes = findings.filter((f) => f.severity === 'fix')
  const tips = findings.filter((f) => f.severity !== 'fix')
  if (fixes.length) {
    out.push('', 'To fix before it will deploy:')
    fixes.forEach((f, i) => {
      out.push(`  ${i + 1}. ${f.title}`)
      if (f.why) out.push(`     ${f.why}`)
      out.push(...fixLines(f.fix, '     '))
    })
  }
  if (tips.length) {
    out.push('', 'Worth doing:')
    for (const f of tips) out.push(`  - ${f.title}`)
  }
  if ((report.env_needed || []).length) out.push('', `Environment variables to supply: ${report.env_needed.join(', ')}`)
  if ((report.costs || []).length) {
    out.push('', 'About a month in your own cloud account:')
    for (const c of report.costs) out.push(`  - ${c.label}: ${money(c.min)} to ${money(c.max)}`)
  }
  const sec = outcome.security
  if (sec) {
    out.push('', 'Security (visible only to this run):')
    if (!sec.secrets.length && !sec.env_files.length && !sec.public_env.length) out.push('  Nothing found.')
    for (const s of sec.secrets) out.push(`  - ${s.kind} committed in ${s.file}${s.line ? `:${s.line}` : ''}. Revoke it and make a new one.`)
    for (const f of sec.env_files) out.push(`  - ${f.file} with real values is committed (${f.keys.join(', ')}). Rotate them and stop tracking the file.`)
    for (const e of sec.public_env) out.push(`  - ${e.name} is compiled into browser code, so anyone can read it.`)
  }
  if (outcome.url) out.push('', `Shareable result: ${outcome.url}`)
  out.push('', `Deploy it into your own cloud account, free for your first app: ${APP_SIGNUP}`)
  return out
}

function markdown(outcome) {
  const report = outcome.result.report || {}
  const verdict = report.verdict || {}
  const md = [`## Deploy check: ${verdict.label || outcome.status}`, '']
  if (outcome.status !== 'succeeded') {
    md.push(outcome.result.error || 'The check failed.', '')
    return md.join('\n')
  }
  if (verdict.summary) md.push(verdict.summary, '')
  const services = report.services || []
  if (services.length) {
    md.push('| Service | Type | Framework | Port |', '|---|---|---|---|')
    for (const s of services) md.push(`| ${s.name || s.path || 'app'} | ${s.type || ''} | ${s.framework || s.language || ''} | ${s.port || ''} |`)
    md.push('')
  }
  const fixes = (report.findings || []).filter((f) => f.severity === 'fix')
  if (fixes.length) {
    md.push('### To fix', '')
    for (const f of fixes) {
      md.push(`- **${f.title}**${f.why ? `: ${f.why}` : ''}`)
      const fix = f.fix && typeof f.fix === 'object' ? f.fix : { text: f.fix || '' }
      if (fix.text) md.push(`  ${fix.text}`)
      if (fix.code) {
        const fence = '```'
        md.push('', `  ${fence}${fix.language || ''}${fix.file ? ` title="${fix.file}"` : ''}`,
          ...String(fix.code).split('\n').map((l) => `  ${l}`), `  ${fence}`)
      }
    }
    md.push('')
  }
  if ((report.env_needed || []).length) md.push(`**Environment variables to supply:** ${report.env_needed.join(', ')}`, '')
  if ((report.costs || []).length) {
    md.push('### About a month in your own cloud', '')
    for (const c of report.costs) md.push(`- ${c.label}: ${money(c.min)} to ${money(c.max)}`)
    md.push('')
  }
  const sec = outcome.security
  if (sec && (sec.secrets.length || sec.env_files.length || sec.public_env.length)) {
    md.push('### Security', '')
    if (sec.secrets.length) md.push(`- ${sec.secrets.length} committed credential(s): ${[...new Set(sec.secrets.map((s) => s.kind))].join(', ')}. Revoke and rotate them.`)
    if (sec.env_files.length) md.push(`- Committed .env file(s): ${sec.env_files.map((f) => f.file).join(', ')}`)
    if (sec.public_env.length) md.push(`- Secret-looking variables in browser code: ${sec.public_env.map((e) => e.name).join(', ')}`)
    md.push('')
  }
  md.push(`[Deploy it into your own cloud account](${APP_SIGNUP}), free for your first app.`, '')
  return md.join('\n')
}

function failed(outcome, failOn) {
  if (failOn === 'never') return false
  const code = outcome.result.verdict
  if (failOn === 'needs-work') return code === 'manual'
  if (failOn === 'almost') return code === 'manual' || code === 'partial'
  const sec = outcome.security
  return !!sec && (sec.secrets.length > 0 || sec.env_files.length > 0 || sec.public_env.length > 0)
}

// --------------------------------------------------------------------------- main

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`deploy-check: ${err.message}\n`)
    return 2
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }
  try {
    const outcome = await check(opts)
    if (opts.json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
    else process.stdout.write(`${lines(outcome).join('\n')}\n`)
    if (opts.summary) {
      try {
        appendFileSync(opts.summary, `${markdown(outcome)}\n`)
      } catch (err) {
        process.stderr.write(`deploy-check: couldn't write the summary (${err.message}).\n`)
      }
    }
    if (outcome.status !== 'succeeded') return 2
    return failed(outcome, opts.failOn) ? 1 : 0
  } catch (err) {
    process.stderr.write(`deploy-check: ${err.message}\n`)
    return err instanceof Stop ? err.code : 2
  }
}

main().then((code) => { process.exitCode = code })
