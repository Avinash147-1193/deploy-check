# deploy-check

[![npm](https://img.shields.io/npm/v/thedeploy-check)](https://www.npmjs.com/package/thedeploy-check) [![license](https://img.shields.io/npm/l/thedeploy-check)](./LICENSE)

**Will this repository deploy?** One command tells you:

- the services it found, and how each one builds, starts and listens
- what would stop a deploy, each with the fix for your framework
- the environment variables you'll need to supply
- committed secrets, and secret keys compiled into browser code
- what it would cost a month in your own DigitalOcean, AWS, Google Cloud or Azure account

Free, no account, no dependencies. Built by [The Deployer](https://thedploy.com).

## Use it

```sh
npx thedeploy-check                       # the git repository you're in
npx thedeploy-check ./apps/web            # another local repository
npx thedeploy-check github.com/you/app    # a public repository
```

Options:

| Option | What it does |
|---|---|
| `--json` | Print the whole result as JSON |
| `--summary <file>` | Append a Markdown summary, for example to `$GITHUB_STEP_SUMMARY` |
| `--fail-on <when>` | Exit 1 when the verdict is `needs-work`, `almost` (almost or needs work), when `secrets` are found, or `never` (default) |
| `--quiet` | Don't print progress |
| `--api <url>` | A different check service address; also `DEPLOY_CHECK_API` |

Exit codes: `0` checked, `1` checked and `--fail-on` matched, `2` couldn't check.

## GitHub Action

```yaml
name: Deploy check
on: [push, pull_request]
jobs:
  deploy-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Avinash147-1193/deploy-check@v0
        with:
          fail-on: secrets
```

The result appears in the job summary.

## What is sent, and what is kept

The checks run on The Deployer's free check service, so this tool stays small and never needs updating when
a check improves.

- **A public repository:** only its address is sent. The service reads the public repository itself, and
  the result gets a shareable page at thedploy.com/check.
- **A local repository:** a `git archive` of `HEAD` is sent. That holds your committed files only: never
  uncommitted changes, files git ignores, or the `.git` history.
  - The check is private. Only this run holds the key to read it, and there is no public page, badge or
    share card.
  - The uploaded archive is deleted as soon as the check finishes.
  - The report is deleted after seven days.
  - Uploads are capped at 20 MB compressed.
- **Secrets:** they are reported by kind and place (file and line). The tool never prints their values or
  previews, so they stay out of CI logs.

## Deploy it

When it's ready, [The Deployer](https://portal.thedploy.com/auth?utm_source=deploy-check&utm_medium=readme)
deploys it into your own cloud account, with HTTPS, health checks and monitoring. Your first app is free.

## License

MIT
