# eol-check

**Check your runtimes against endoflife.ai — instantly from the terminal.**

```
npx @endoflife-ai/eol-check
```

Scans your project for version pins and tells you which runtimes are end-of-life, approaching EOL, or still supported. Powered by [endoflife.ai](https://endoflife.ai).

---

## Usage

```bash
# Scan current directory (auto-detects version files)
npx @endoflife-ai/eol-check

# Scan a specific directory
npx @endoflife-ai/eol-check scan ./my-project

# Check a specific product and version
npx @endoflife-ai/eol-check check nodejs 18
npx @endoflife-ai/eol-check check python 3.11
npx @endoflife-ai/eol-check check php 8.1

# List all 700+ tracked products
npx @endoflife-ai/eol-check list
```

## Example output

```
endoflife.ai — scanning /my-project

  Found 3 runtime(s) — checking against endoflife.ai...

  ✗ EOL     nodejs 18  · EOL 2025-04-30 · 383 days past EOL  [.nvmrc]
    → https://endoflife.ai/score/nodejs/18

  ⚠ Warning  python 3.11  · EOL 2026-10-31 · 150 days remaining  [.python-version]
    → https://endoflife.ai/score/python/3.11

  ✓ Supported  go 1.24  · EOL 2027-02-01  [go.mod]

  ✗ 1 EOL runtime detected. Upgrade or add extended support.
    Learn more: https://endoflife.ai
```

## Detects versions from

| File | Runtime |
|---|---|
| `.nvmrc` / `.node-version` | Node.js |
| `.python-version` | Python |
| `.ruby-version` / `Gemfile` | Ruby |
| `.tool-versions` (asdf) | Node.js, Python, Ruby, Go |
| `package.json` engines | Node.js |
| `go.mod` | Go |
| `Dockerfile` FROM | Node.js, Python, PHP, Ruby |
| `composer.json` | PHP |
| `.terraform-version` | Terraform |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All runtimes supported |
| `1` | One or more EOL runtimes detected |

Use in shell scripts:

```bash
npx @endoflife-ai/eol-check || echo "EOL runtimes found — upgrade before deploying"
```

## API key

From November 16, 2026 the endoflife.ai API needs a key for every lookup (until then it answers without one at 50 requests a day). A free key gives 150 requests a day and does not expire; paid keys raise the limit. Set it as `EOL_API_KEY`:

```bash
EOL_API_KEY=your_key npx @endoflife-ai/eol-check
```

[Get a free API key →](https://endoflife.ai/api#free-key)

## CI integration

For CI pipelines, use the [EOL Check GitHub Action](https://github.com/marketplace/actions/eol-check-end-of-life-software-gate) instead — it posts file-anchored annotations, reads SBOMs, and works without a key.

## Data

EOL dates and risk scores sourced from [endoflife.ai](https://endoflife.ai) — lifecycle data for 700+ products, rebuilt at least daily.

## License

MIT — endoflife.ai
