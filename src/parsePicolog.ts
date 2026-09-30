import type { Block, PicologChannelMetadata } from './container.ts';
import {
  SAMPLE_BYTES,
  channelDescriptions,
  describe,
  openPicolog,
} from './container.ts';

/** One logged input, over absolute time. */
export interface PicologChannel {
  /** `tc-08.A0032/381.ch1` — unique within the recording. */
  id: string;
  /** What the operator called it, e.g. `Channel 1`. */
  label: string;
  /** The unit its values are in; `°C` for a thermocouple. */
  unit: string;
  /** `thermocouple`, `cold-junction`, … as the file names it. */
  channelType?: string;
  /** The sensor kind, e.g. `thermo-k` for a type-K thermocouple. */
  input?: string;
  /** The colour PicoLog draws it in. */
  color?: string;
  /** Epoch milliseconds, ascending, one per value. */
  times: Float64Array;
  /** One value per timestamp; `NaN` where the logger recorded none. */
  values: Float64Array;
}

/** What a `.picolog` holds. */
export interface PicologRecording {
  /** The PicoLog build that wrote it, e.g. `6.1.9`. */
  appVersion: string;
  /** The container's own format version. */
  version: number;
  /** When the recording started, as the file states it, in ISO 8601 UTC. */
  startDate: string;
  /** When it was saved. */
  savedDate: string;
  /** The zone PicoLog displayed it in. Timestamps themselves are UTC. */
  timezone: string;
  /** The interval its samples were taken at, in seconds. */
  intervalSeconds: number;
  channels: PicologChannel[];
}

/**
 * Read a PicoLog 6 recording.
 *
 * Every sample is a **big-endian** Float32 on an absolute UTC-millisecond
 * grid, so nothing here needs a timezone: a sample's instant is its block's
 * start plus its slot's offset. Slots the logger never wrote — before it
 * started and after it stopped — hold the quiet NaN `0x7FC00000` and are
 * trimmed off both ends.
 *
 * Only the finest resolution level is read. PicoLog also stores min/max
 * pyramids at coarser intervals, which are reductions over the same samples;
 * reach them through {@link openPicolog} if a fast overview is wanted.
 * @param data - the whole file
 * @returns the channels the recording holds, with its own header
 */
export async function parsePicolog(
  data: ArrayBufferLike | Uint8Array,
): Promise<PicologRecording> {
  const { metadata, blocks, rawInterval, payloads, channelKeys } =
    await openPicolog(data);
  const descriptions = channelDescriptions(metadata);

  const channels: PicologChannel[] = [];
  for (const channelKey of channelKeys) {
    channels.push(
      decodeChannel({
        channelKey,
        blocks: blocks.filter(
          (block) =>
            block.channelKey === channelKey &&
            block.intervalSeconds === rawInterval,
        ),
        intervalSeconds: rawInterval,
        payloads,
        description: describe(descriptions, channelKey),
      }),
    );
  }

  return {
    appVersion: metadata.appVersion ?? '',
    version: metadata.version ?? 0,
    startDate: metadata.startDate ?? '',
    savedDate: metadata.savedDate ?? '',
    timezone: metadata.timezone ?? '',
    intervalSeconds: rawInterval,
    channels,
  };
}

/** What {@link decodeChannel} needs. */
interface DecodeOptions {
  channelKey: string;
  blocks: Block[];
  intervalSeconds: number;
  payloads: Map<string, Uint8Array>;
  description: PicologChannelMetadata | undefined;
}

/**
 * Decode one channel at the finest level into timestamps and values.
 * @param options - see {@link DecodeOptions}
 * @returns the channel, with the unwritten slots trimmed off both ends
 */
function decodeChannel(options: DecodeOptions): PicologChannel {
  const { channelKey, intervalSeconds, payloads, description } = options;
  // The index is neither sorted nor stably ordered: within one block start the
  // channels come in either order, so sorting here is what keeps the series in
  // time order.
  const blocks = options.blocks.toSorted((a, b) => a.blockStart - b.blockStart);

  let capacity = 0;
  for (const block of blocks) capacity += block.byteLength / SAMPLE_BYTES;

  const times = new Float64Array(capacity);
  const values = new Float64Array(capacity);
  const step = intervalSeconds * 1000;
  let length = 0;

  for (const block of blocks) {
    const payload = payloads.get(block.file);
    if (!payload) throw new Error(`block file ${block.file} was not read`);
    // A block holds as many samples as it has room for. The count is not fixed
    // by the format, and the last block of a recording need not be full.
    const slots = Math.floor(block.byteLength / SAMPLE_BYTES);
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + block.byteOffset,
      slots * SAMPLE_BYTES,
    );
    for (let index = 0; index < slots; index++) {
      // Big-endian: a Float32Array over the buffer reads it the other way
      // round and gives values in the hundreds of thousands.
      const value = view.getFloat32(index * SAMPLE_BYTES, false);
      // Leading unwritten slots are not part of the recording.
      if (Number.isNaN(value) && length === 0) continue;
      times[length] = block.blockStart + index * step;
      values[length] = value;
      length++;
    }
  }
  while (length > 0 && Number.isNaN(values[length - 1])) length--;

  const identifier = channelKey.slice(channelKey.lastIndexOf('.') + 1);
  return {
    id: channelKey.replaceAll('|', '/'),
    label: description?.description ?? identifier,
    unit: description?.channelType === 'thermocouple' ? '°C' : '',
    channelType: description?.channelType,
    input: description?.input,
    color: description?.color,
    times: times.subarray(0, length),
    values: values.subarray(0, length),
  };
}
