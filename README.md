# picolog-parser

Parse PicoLog 6 recordings (`.picolog`) from Pico Technology data loggers.

A `.picolog` is a tar archive holding a JSON header, a block index, and the
samples as big-endian Float32 on an absolute UTC grid. There is no public
specification for it; [`FORMAT.md`](./FORMAT.md) documents what this parser
decodes and how each fact was established.

Runs in the browser and in Node: the only dependency is
[`nanotar`](https://github.com/unjs/nanotar), and gzip is handled by the
platform's own `DecompressionStream`.

## Installation

```console
npm i picolog-parser
```

## Usage

```js
import { parsePicolog } from 'picolog-parser';

const recording = await parsePicolog(await file.arrayBuffer());

recording.intervalSeconds; // 1
recording.startDate; // '2026-09-24T07:48:11.873Z'

for (const channel of recording.channels) {
  channel.label; // 'Channel 1'
  channel.unit; // '°C'
  channel.times; // Float64Array of epoch milliseconds, ascending
  channel.values; // Float64Array, NaN where the logger recorded none
}
```

Timestamps are absolute UTC milliseconds — the format stores them that way, so
no timezone is involved. `recording.timezone` is the zone PicoLog _displayed_
the recording in, and is only a hint.

Channels come from the block index rather than from the header, so an input
that is described but disabled does not appear. `channel.values` may hold `NaN`
where the logger recorded nothing; unwritten slots at the two ends are trimmed.

## Resolution levels

PicoLog stores the samples once and then min/max pyramids over them at coarser
intervals, for fast plotting. `parsePicolog` reads only the finest level, which
is the measurement.

The pyramids are reachable through the lower-level entry point, which returns
the block index and the inflated payloads without decoding them:

```js
import { openPicolog } from 'picolog-parser';

const { blocks, rawInterval } = await openPicolog(buffer);
// blocks at an interval above rawInterval hold interleaved (min, max) pairs
```

## Scope

Decoded from **one** recording: a TC-08 with two type-K thermocouples, container
version 2, written by PicoLog 6.1.9. Other Pico loggers and other PicoLog
versions are expected to share the container but have not been tested. Issues
with a file that does not parse are welcome, with the file attached.

## License

[MIT](./LICENSE)
