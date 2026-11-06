# Memory over time charts

`memory-chart.mts` draws how much memory the browser uses over a run, for one or more runs, as an SVG and a PNG.

```sh
npx tsx tools/dashboard/memory-chart.mts <run.json>... --out chart.svg \
  [--title "..."] [--series total,renderer,gpu,browser,heap] [--x time|phase] \
  [--label a,b] [--kill-mb N --kill-label "..."] [--emit dir] [--no-png]
```

Each input is either a `kong-memory-trace` file (described below) or a `result.json` written by `tools/performance/memory.mts`, whose timeline is converted when it is read. `--emit dir` writes each input out as a numbered `kong-memory-trace` file. `--label` names each run's build in the legend. `--x phase` stretches each run between its phase markers, so runs that load at different speeds line up. `--kill-mb` draws a horizontal line, for example the size at which a browser kills its content process. The PNG is rendered with the Playwright Chromium that is already in `devDependencies`.

## kong-memory-trace

```json
{
  "schema": "kong-memory-trace",
  "version": 1,
  "label": "v0.2.0",
  "build": "v0.2.0",
  "browser": "Safari 26",
  "machine": "Mac mini, 16 GB",
  "flags": "?seed=42",
  "launcher": "manual",
  "source": "the file or issue the numbers came from",
  "samples": [{ "t": 3, "totalMB": 917, "browserMB": 210, "rendererMB": 480, "gpuMB": 160, "heapMB": 95 }],
  "markers": [{ "t": 40, "name": "title" }],
  "killed": { "t": 312, "MB": 9000, "process": "WebContent" }
}
```

| Field | Meaning |
|---|---|
| `t` | Seconds since the browser was launched |
| `totalMB` | All browser processes together. Every sample needs it |
| `browserMB`, `rendererMB`, `gpuMB` | One process type each, when the source measured it. Safari's WebContent goes in `rendererMB` |
| `heapMB` | The retained JS heap. Include it only when it was read after a forced GC |
| `markers` | When the run reached `title`, `play`, `plane`, `landing`, `results` or `leave` |
| `launcher` | `playwright`, `manual` or the tool that launched the browser. Playwright-launched runs get a note that their totals may be inflated |
| `killed` | The browser killed a process at this time and size. Leave it out when nothing was killed |

When a value wasn't measured, leave the field out. Don't estimate it. The chart breaks a line where a sample has no value.

Converting a `memory.mts` result: timeline points where a process couldn't be read are left out, so the chart shows a gap instead of a partial total. The JS heap is left out too, because timeline points are read without a forced GC. `memory.mts` doesn't record its browser channel, so the legend names its default: Chromium for the `nogpu` profile and Chrome otherwise. Markers come from the first match only: `title` and `plane` come from the `memory/title` and `memory/plane` samples. `play` is the first timeline point inside a match, `landing` is the first point in the play phase, `results` is the first point in the results phase, and `leave` is the first point outside the match after that.
