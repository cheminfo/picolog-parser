import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { openPicolog } from '../container.ts';
import { parsePicolog } from '../parsePicolog.ts';

// A four-hour TC-08 recording with two type-K thermocouples enabled, 1 Hz.
const file = readFileSync(
  join(import.meta.dirname, 'data/tc08-two-thermocouples.picolog'),
);

test('reads the recording header', async () => {
  const recording = await parsePicolog(file);

  expect(recording.appVersion).toBe('6.1.9');
  expect(recording.version).toBe(2);
  expect(recording.startDate).toBe('2026-09-24T07:48:11.873Z');
  expect(recording.savedDate).toBe('2026-09-24T11:48:26.771Z');
  expect(recording.timezone).toBe('Europe/Zurich');
  expect(recording.intervalSeconds).toBe(1);
});

test('reads every enabled input, and only those', async () => {
  const { channels } = await parsePicolog(file);

  // Six more thermocouples and a cold junction are described but disabled, and
  // have no blocks behind them.
  expect(channels.map((channel) => channel.id)).toStrictEqual([
    'tc-08.A0032/381.ch1',
    'tc-08.A0032/381.ch2',
  ]);
  expect(channels.map((channel) => channel.label)).toStrictEqual([
    'Channel 1',
    'Channel 2',
  ]);

  for (const channel of channels) {
    expect(channel.unit).toBe('°C');
    expect(channel.channelType).toBe('thermocouple');
    expect(channel.input).toBe('thermo-k');
  }

  expect(channels[0]?.color).toBe('#0000FF');
});

test('decodes every sample onto a gapless grid', async () => {
  const { channels } = await parsePicolog(file);

  for (const channel of channels) {
    // metadata.json reports capturedSamples = 14252 for both thermocouples.
    expect(channel.values).toHaveLength(14_252);
    expect(channel.times[0]).toBe(1_790_236_092_000);
    expect(channel.times[14_251]).toBe(1_790_250_343_000);

    let gaps = 0;
    let holes = 0;
    for (let index = 1; index < channel.times.length; index++) {
      if (
        Number(channel.times[index]) - Number(channel.times[index - 1]) !==
        1000
      ) {
        gaps++;
      }
      if (Number.isNaN(channel.values[index])) holes++;
    }

    expect(gaps).toBe(0);
    expect(holes).toBe(0);
  }
});

test('reads the samples as big-endian Float32', async () => {
  const { channels } = await parsePicolog(file);
  const [one, two] = channels;

  // Read the other way round these are around -269722 and 949044.
  expect(one?.values[0]).toBeCloseTo(22.510_364_532_470_703, 10);
  expect(one?.values[14_251]).toBeCloseTo(24.415_113_449_096_68, 10);
  expect(two?.values[0]).toBeCloseTo(22.469_890_594_482_422, 10);
  expect(two?.values[14_251]).toBeCloseTo(24.236_053_466_796_875, 10);

  // 2026-09-24T09:00:00Z.
  const index = one?.times.indexOf(1_790_240_400_000) as number;

  expect(index).toBe(4308);
  expect(one?.values[index]).toBeCloseTo(23.161_441_802_978_516, 10);
  expect(two?.values[index]).toBeCloseTo(22.989_740_371_704_1, 10);
});

test('the first sample lands within one interval of the stated start', async () => {
  const recording = await parsePicolog(file);

  // startDate carries milliseconds while samples sit on whole seconds.
  const started = Date.parse(recording.startDate);

  expect(started).toBe(1_790_236_091_873);
  expect(Number(recording.channels[0]?.times[0]) - started).toBe(127);
});

test('the container exposes the coarser levels it does not decode', async () => {
  const container = await openPicolog(file);

  // Four resolutions: the 1 s samples and three min/max pyramids over them.
  const intervals = [
    ...new Set(container.blocks.map((block) => block.intervalSeconds)),
  ].toSorted((a, b) => a - b);

  expect(intervals).toStrictEqual([1, 10, 100, 1000]);
  expect(container.rawInterval).toBe(1);
  expect(container.channelKeys).toHaveLength(2);
});

test('rejects a file that is not a PicoLog recording', async () => {
  await expect(
    parsePicolog(new TextEncoder().encode('not a tar')),
  ).rejects.toThrow('not a PicoLog recording');
});
