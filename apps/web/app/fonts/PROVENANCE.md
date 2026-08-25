# Font provenance

`FRONTEND-007`: Viva self-hosts these fonts instead of loading them from
Google Fonts at request time. The variable TTFs and OFL license texts below
were fetched from the official [`google/fonts`](https://github.com/google/fonts)
repository at one pinned upstream commit, then partially instanced to this
plan's stated weight ranges and Latin-subset to WOFF2 with
[fonttools](https://github.com/fonttools/fonttools) in a disposable virtual
environment (never committed to this repository).

Upstream: `https://github.com/google/fonts`, pinned commit
`ec626514f79f831f1ab848a82114a0ce7e2d6372` (fetched 2026-08-24 via
`https://raw.githubusercontent.com/google/fonts/ec626514f79f831f1ab848a82114a0ce7e2d6372/<path>`).

| Committed file | Upstream source path | Weight range | SHA-256 |
| --- | --- | --- | --- |
| `cormorant-latin-roman.woff2` | `ofl/cormorant/Cormorant[wght].ttf` | 400-600 | `58f572e22c86287e54716344223d22ebbc084e521ff6f9b3bd4f77a247c920be` |
| `cormorant-latin-italic.woff2` | `ofl/cormorant/Cormorant-Italic[wght].ttf` | 400-500 | `cb65bae2b16e06b4d94675ef60c90e3fd73a56726d3ef86c892447590e204d16` |
| `hanken-grotesk-latin.woff2` | `ofl/hankengrotesk/HankenGrotesk[wght].ttf` | 400-700 | `577111522e5bb0735d648601445b5f0ab281135b2efec34756f437472c716967` |

| Committed OFL license text | Upstream source path | SHA-256 |
| --- | --- | --- |
| `OFL-Cormorant.txt` | `ofl/cormorant/OFL.txt` | `60700d351cac4650c51f3f9db318d2a420f8b45052dba2715eb5fec41f0f6956` |
| `OFL-Hanken-Grotesk.txt` | `ofl/hankengrotesk/OFL.txt` | `e02ccb89a86839b22feff7872ff5cc355cc0f58318d29eee20e2cf83a612f16d` |

Total committed WOFF2 payload: 58,064 + 42,200 + 23,456 = 123,720 bytes
(~120.8 KiB), under the 300 KiB (307,200 byte) `FRONTEND-007` budget.

## Reproducing the committed WOFF2 files

Both the raw upstream fetch and the fonttools subsetting step ran outside
this worktree (a disposable `uv` virtual environment, deleted afterward);
nothing in this recipe is committed except its output.

```bash
# 1. Fetch the pinned upstream TTFs and OFL texts (raw.githubusercontent.com).
PIN=ec626514f79f831f1ab848a82114a0ce7e2d6372
BASE="https://raw.githubusercontent.com/google/fonts/$PIN"
curl -sS -g -o "Cormorant[wght].ttf"        "$BASE/ofl/cormorant/Cormorant%5Bwght%5D.ttf"
curl -sS -g -o "Cormorant-Italic[wght].ttf" "$BASE/ofl/cormorant/Cormorant-Italic%5Bwght%5D.ttf"
curl -sS -g -o "HankenGrotesk[wght].ttf"    "$BASE/ofl/hankengrotesk/HankenGrotesk%5Bwght%5D.ttf"
curl -sS -g -o "OFL-Cormorant.txt"          "$BASE/ofl/cormorant/OFL.txt"
curl -sS -g -o "OFL-Hanken-Grotesk.txt"     "$BASE/ofl/hankengrotesk/OFL.txt"

# 2. Disposable fonttools environment (outside the worktree).
uv venv /tmp/fonttools-venv/.venv
uv pip install --python /tmp/fonttools-venv/.venv/bin/python fonttools brotli
BIN=/tmp/fonttools-venv/.venv/bin

# 3. Restrict each variable font's wght axis to this plan's stated range
#    (a *partial* instance — still variable, just a narrower axis) —
#    fonttools varLib.instancer's "AXIS=LOC" range syntax.
$BIN/fonttools varLib.instancer "Cormorant[wght].ttf"        wght=400:600 -o cormorant-roman-instanced.ttf
$BIN/fonttools varLib.instancer "Cormorant-Italic[wght].ttf" wght=400:500 -o cormorant-italic-instanced.ttf
$BIN/fonttools varLib.instancer "HankenGrotesk[wght].ttf"    wght=400:700 -o hanken-grotesk-instanced.ttf

# 4. Latin-subset + WOFF2-compress each instanced font.
UNICODES="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
$BIN/pyftsubset cormorant-roman-instanced.ttf   --flavor=woff2 --layout-features="*" --unicodes="$UNICODES" --output-file=cormorant-latin-roman.woff2
$BIN/pyftsubset cormorant-italic-instanced.ttf  --flavor=woff2 --layout-features="*" --unicodes="$UNICODES" --output-file=cormorant-latin-italic.woff2
$BIN/pyftsubset hanken-grotesk-instanced.ttf    --flavor=woff2 --layout-features="*" --unicodes="$UNICODES" --output-file=hanken-grotesk-latin.woff2
```

fonttools 4.63.0 / brotli 1.2.0 (Python 3.11.15) produced the committed
files above.
