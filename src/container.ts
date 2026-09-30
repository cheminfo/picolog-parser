import { parseTar } from 'nanotar';

/** Bytes per stored sample: one big-endian Float32. */
export const SAMPLE_BYTES = 4;

/** What PicoLog records about one input of a device. */
export interface PicologChannelMetadata {
  channelIdentifier?: string;
  channelType?: string;
  description?: string;
  deviceSerial?: string;
  input?: string;
  color?: string;
  enabled?: boolean;
  capturedSamples?: number;
  captureConfig?: { interval?: number; mode?: string };
}

/** The recording's own header, as `metadata.json` holds it. */
export interface PicologMetadata {
  appVersion?: string;
  startDate?: string;
  savedDate?: string;
  timezone?: string;
  version?: number;
  devices?: { items?: Array<Record<string, unknown>> };
}

/** One entry of the block index, as the file writes it. */
export type DataMapEntry = [string, [string, number, number]];

/** Where one block of one channel at one resolution lives. */
export interface Block {
  /** `tc-08.A0032|381.ch1` — the serial's `/` is escaped to `|`. */
  channelKey: string;
  intervalSeconds: number;
  /** Epoch milliseconds of the block's first slot. */
  blockStart: number;
  /** Which archive member holds it. */
  file: string;
  /** Offset into that member once inflated. */
  byteOffset: number;
  byteLength: number;
}

/** A `.picolog` with its container opened. */
export interface PicologContainer {
  metadata: PicologMetadata;
  /** Every block the index lists, at every resolution. */
  blocks: Block[];
  /** The finest interval present, in seconds. Its blocks hold the raw samples. */
  rawInterval: number;
  /** Each inflated member, keyed by its name in the archive. */
  payloads: Map<string, Uint8Array>;
  /** Every channel with data at the finest level, sorted by input number. */
  channelKeys: string[];
}

/**
 * Open a `.picolog` and inflate what its finest resolution level needs.
 *
 * The container is an uncompressed GNU tar holding `metadata.json`, a gzipped
 * block index, and gzipped payload members. Only the members the finest level
 * addresses are inflated: the coarser levels PicoLog also stores are min/max
 * pyramids over the same samples.
 * @param data - the whole file
 * @returns its metadata, its block index and the inflated payloads
 */
export async function openPicolog(
  data: ArrayBufferLike | Uint8Array,
): Promise<PicologContainer> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const members = new Map<string, Uint8Array>();
  for (const item of parseTar(bytes)) {
    if (item.data) members.set(item.name, item.data);
  }

  const metadataBytes = members.get('metadata.json');
  const mapBytes = members.get('data-map.json.gz');
  if (!metadataBytes || !mapBytes) {
    throw new Error(
      'not a PicoLog recording: metadata.json or data-map.json.gz is missing',
    );
  }

  const metadata = JSON.parse(
    new TextDecoder().decode(metadataBytes),
  ) as PicologMetadata;
  const blocks = parseDataMap(
    JSON.parse(await gunzipText(mapBytes)) as DataMapEntry[],
  );
  if (blocks.length === 0) throw new Error('PicoLog recording holds no data');

  // Never assume one second: the finest level is whatever interval the device
  // was set to record at.
  let rawInterval = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    if (block.intervalSeconds < rawInterval) {
      rawInterval = block.intervalSeconds;
    }
  }

  const payloads = new Map<string, Uint8Array>();
  for (const block of blocks) {
    if (block.intervalSeconds !== rawInterval || payloads.has(block.file)) {
      continue;
    }
    const member = members.get(block.file);
    if (!member) throw new Error(`block file ${block.file} is missing`);
    // eslint-disable-next-line no-await-in-loop -- inflating one member at a time keeps peak memory at the largest member rather than all of them at once
    payloads.set(block.file, await gunzip(member));
  }

  return {
    metadata,
    blocks,
    rawInterval,
    payloads,
    channelKeys: channelKeys(blocks, rawInterval),
  };
}

/**
 * Read the block index.
 *
 * Keys are parsed from the right because the device serial itself holds a `/`,
 * escaped to `|`: `tc-08.A0032|381.ch1/1/1790236000000`. Splitting from the
 * left breaks on the serial.
 * @param entries - the index as stored
 * @returns one descriptor per block
 */
export function parseDataMap(entries: DataMapEntry[]): Block[] {
  const blocks: Block[] = [];
  for (const [key, [file, byteOffset, byteLength]] of entries) {
    const lastSlash = key.lastIndexOf('/');
    const previousSlash = key.lastIndexOf('/', lastSlash - 1);
    if (lastSlash < 0 || previousSlash === -1) continue;
    blocks.push({
      channelKey: key.slice(0, previousSlash),
      intervalSeconds: Number(key.slice(previousSlash + 1, lastSlash)),
      blockStart: Number(key.slice(lastSlash + 1)),
      file,
      byteOffset,
      byteLength,
    });
  }
  return blocks;
}

/**
 * Collect the per-channel metadata, keyed by `<serial>.<channelIdentifier>`.
 *
 * Which channels have data is decided by the block index rather than by this:
 * a disabled input still appears here, with no data behind it.
 * @param metadata - the parsed `metadata.json`
 * @returns what the file says about each channel it describes
 */
export function channelDescriptions(
  metadata: PicologMetadata,
): Map<string, PicologChannelMetadata> {
  const found = new Map<string, PicologChannelMetadata>();
  for (const device of metadata.devices?.items ?? []) {
    for (const value of Object.values(device)) {
      if (typeof value !== 'object' || value === null) continue;
      const channel = value as PicologChannelMetadata;
      if (!channel.channelIdentifier || !channel.deviceSerial) continue;
      found.set(
        `${channel.deviceSerial}.${channel.channelIdentifier}`,
        channel,
      );
    }
  }
  return found;
}

/**
 * Find the metadata of a channel the block index names.
 *
 * The index key carries the device kind too — `tc-08.A0032|381.ch1` — while the
 * metadata knows only the serial and the identifier, so the match is made on
 * the tail of the key.
 * @param descriptions - every channel the metadata describes
 * @param channelKey - the key as the block index writes it
 * @returns that channel's metadata, or `undefined`
 */
export function describe(
  descriptions: Map<string, PicologChannelMetadata>,
  channelKey: string,
): PicologChannelMetadata | undefined {
  const normalized = channelKey.replaceAll('|', '/');
  for (const [key, description] of descriptions) {
    if (normalized === key || normalized.endsWith(`.${key}`)) {
      return description;
    }
  }
  return undefined;
}

/**
 * The channels that have data at the finest level.
 *
 * The index lists them in neither a stable nor a meaningful order — within one
 * block start `ch2` sometimes precedes `ch1` — so they are sorted by input
 * number here.
 * @param blocks - every block of the recording
 * @param rawInterval - the finest interval present, in seconds
 * @returns the channel keys, deduplicated and sorted
 */
function channelKeys(blocks: Block[], rawInterval: number): string[] {
  const keys = new Set<string>();
  for (const block of blocks) {
    if (block.intervalSeconds !== rawInterval) continue;
    keys.add(block.channelKey);
  }
  return [...keys].toSorted((a, b) =>
    a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }),
  );
}

/**
 * Inflate a gzip member with the platform's own decompressor.
 * @param data - the compressed bytes
 * @returns the inflated bytes
 */
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  // A view rather than a copy. The cast is safe because nothing in this
  // package is ever handed a SharedArrayBuffer.
  const bytes = new Uint8Array(
    data.buffer as ArrayBuffer,
    data.byteOffset,
    data.byteLength,
  );
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const inflated = source.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/**
 * Inflate a gzip member and decode it as UTF-8.
 * @param data - the compressed bytes
 * @returns the text
 */
async function gunzipText(data: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await gunzip(data));
}
