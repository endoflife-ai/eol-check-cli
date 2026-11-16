# eol-check

**Check your runtimes against endoflife.ai — instantly from the terminal.**

```
npx @endoflife-ai/eol-check
```

Scans your project for version pins and tells you which runtimes are end-of-life, approaching EOL, or still supported. Powered by [endoflife.ai](https://endoflife.ai).

**An API key is required.** A free key works. [Get one here](https://endoflife.ai/api#free-key) and set it as `EOL_API_KEY` (see [API key](#api-key)).

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
| `0` | No end-of-life runtime found, and every lookup was answered |
| `1` | One or more end-of-life runtimes found |
| `2` | Could not check: no API key, key refused, daily limit reached, network or API error, or wrong usage |

The line `All runtimes are currently supported` is printed only when every detected runtime was checked and is supported.

A runtime whose lookup failed is shown as `Not checked` with the reason. The run then ends with `N runtime(s) could not be checked` and exit code `2`. If an end-of-life runtime was also found, the exit code is `1` and the not-checked count is still printed.

A version that endoflife.ai does not track is shown as `Not tracked`. It is not a failure and it is not called supported. The last line counts it, for example `All checked runtimes are supported; 1 not tracked by endoflife.ai.`

Use in shell scripts:

```bash
npx @endoflife-ai/eol-check
code=$?
if [ "$code" -eq 1 ]; then echo "EOL runtimes found. Upgrade before deploying."; fi
if [ "$code" -eq 2 ]; then echo "The check did not run. See the message above."; fi
```

## API key

The endoflife.ai API needs a key for every lookup, so this CLI needs one too. Without a key it checks nothing, says so, and exits with code `2`.

A free key gives 150 requests a day and does not expire. It is emailed at once.

[Get a free API key →](https://endoflife.ai/api#free-key)

Set it as `EOL_API_KEY` (`ENDOFLIFE_API_KEY` is read as well):

```bash
# macOS, Linux
EOL_API_KEY=your_key npx @endoflife-ai/eol-check

# Windows PowerShell
$env:EOL_API_KEY = "your_key"
npx @endoflife-ai/eol-check
```

Each detected runtime is one request. If the daily limit of the key is reached, the CLI says so and says when the limit resets.

Paid keys raise the limit: Starter is USD 89 a month for 10,000 requests a day, Pro is USD 299 a month for 100,000 requests a day (fair use). See [plans](https://endoflife.ai/api#get-key).

## CI integration

For CI pipelines, use the [EOL Check GitHub Action](https://github.com/marketplace/actions/eol-check-end-of-life-software-gate) instead. It posts file-anchored annotations and reads SBOMs. The Action does not need an API key.

To run this CLI in CI, store the key as a secret and pass it as `EOL_API_KEY`. Treat exit code `2` as "the check did not run", not as a pass.

## Data

EOL dates and risk scores sourced from [endoflife.ai](https://endoflife.ai) — lifecycle data for 700+ products, rebuilt at least daily.

## License

MIT — endoflife.ai
