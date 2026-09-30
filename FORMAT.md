# The `.picolog` format

Reverse-engineered from PicoLog 6.1.9 recordings, container version 2, and
verified byte for byte against a four-hour TC-08 capture. There is no public
specification; everything below was established by decoding and cross-checking
against the recording's own `metadata.json`.

## Container

An **uncompressed GNU tar**. `file` reports `POSIX tar archive (GNU)`. Members
observed, in order:

| member             | contents                                        |
| ------------------ | ----------------------------------------------- |
| `metadata.json`    | UTF-8 JSON, one line, no BOM                    |
| `thumb.png`        | a rendered preview; no numeric data             |
| `data-map.json.gz` | gzipped JSON block index                        |
| `ov.gz`            | gzipped payload, the coarsest resolution levels |
| `10.0.gz`          | gzipped payload, the 10 s level                 |
| `1.0.gz`           | gzipped payload, the 1 s level                  |

The payload member names come from the block index, not from a convention —
look members up by the name the index gives, never by position.

## `metadata.json`

Top level: `appVersion`, `version` (2), `startDate`, `savedDate`, `timezone`,
`devices.items[]`. Each device carries its channels as _properties_ rather
than as an array — `thermocouple1` … `thermocouple8`, `coldJunction` — each
with `channelIdentifier` (`ch1`…), `channelType`, `deviceSerial`, `enabled`,
`capturedSamples`, and, when enabled, `description`, `color` and `input`
(`thermo-k` for a type-K thermocouple).

A disabled input still appears here with `capturedSamples: 0` and has no
blocks behind it, so **channel discovery is driven by the block index** and
this is used only for labels and units.

## `data-map.json.gz` — the block index

Gzipped JSON: an array of `[key, [memberName, byteOffset, byteLength]]`.

```
tc-08.A0032|381.ch1/1/1790236000000
└── device ─┘└ serial ┘└ ch ┘ │  └ block start, epoch ms
                              └ interval, SECONDS
```

Three traps:

- **The serial contains a `/`**, escaped to `|`, and `/` is also the key's own
  separator. Parse the key **from the right**: the last `/` precedes the block
  start, the one before it precedes the interval, everything earlier is the
  channel.
- **The interval in the key is in seconds**; `captureConfig.interval` in
  `metadata.json` is in milliseconds. They are not the same field.
- **Entries are not sorted**, and within one block start `ch2` sometimes
  precedes `ch1`. Sort by block start before concatenating, or the series is
  silently scrambled.

`byteOffset` addresses the **inflated** member, not the compressed bytes.

## Payload blocks

Every value is an **IEEE-754 big-endian Float32**. A `Float32Array` over the
buffer reads them the other way round and yields values in the hundreds of
thousands; use `DataView.getFloat32(offset, false)`.

At the **finest interval present**, a block is one value per slot, and slot `i`
is at `blockStart + i * intervalSeconds * 1000` ms.

At every **coarser** interval, a block is interleaved `(min, max)` pairs — one
pair per bucket, `min` at `i * 8` and `max` at `i * 8 + 4`. These are exact
reductions of the finest level: verified for all 1585 buckets of the reference
recording at 10 s, 100 s and 1000 s, with zero differences. They carry no
information of their own and exist for fast plotting.

Which level is raw is decided by **the smallest interval in the index**, never
by a block's size: a 4000-byte block is 1000 raw samples and an 8000-byte block
is 1000 min/max pairs, so the sizes alone do not distinguish them.

Unwritten slots — before the logger started and after it stopped — hold the
quiet NaN `0x7FC00000`. In the reference recording that is 92 leading and 656
trailing slots per channel, with no interior holes.

## Time

Every timestamp is **absolute UTC epoch milliseconds**, derived from the block
start, so no timezone is involved. `metadata.timezone` is a display hint.

`startDate` carries milliseconds while stored samples sit on the whole-second
grid, so the first sample can be up to one interval later than `startDate`
(127 ms in the reference recording). `savedDate` is when the file was written,
not when the recording stopped — 2 min 44 s after the last sample here.
