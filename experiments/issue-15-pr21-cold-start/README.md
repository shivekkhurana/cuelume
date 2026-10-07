# PR #21 cold-start browser harness

This copies the fresh-process Chrome capture harness used for the Cuelume cold-start experiment, pointed at this checkout's built `dist/` output. Each trial starts a new headless Chrome process, clicks once with CDP mouse input, and observes the audio rendering graph for one second.

Run the requested 20 trials for each cue:

```sh
npm run build
bun experiments/issue-15-pr21-cold-start/run.ts --leads=0 --repetitions=20 --summary
```

`--leads=0` disables extra timing offsets from the harness. PR #21's own 10 ms playback lead remains active. The capture detects samples reaching Chrome's audio destination graph; it does not measure physical speaker output.
