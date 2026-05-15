/**
 * Length-prefixed framing.
 *
 *   wire = [u32 BE length][protobuf bytes]
 *
 * The SkyrimRP gateway shares this framing between its QUIC streams and the
 * WebSocket transport so a single decoder is reused on the server. WebSocket
 * already gives us message boundaries, but a single WS frame can carry
 * multiple records — we never assume one-to-one.
 *
 * This module deliberately has zero dependencies on Skyrim Platform so it
 * stays unit-testable. The transport pipes WS bytes in and gets `Uint8Array`
 * payloads out, one per complete frame.
 */

/** Encode `payload` with a 4-byte big-endian length prefix. */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, payload.byteLength, false /* big-endian */);
  out.set(payload, 4);
  return out;
}

/** Incremental reader. Feed it bytes; drain complete frames. */
export class FrameReader {
  // Concatenated buffer of unread bytes. We compact when a frame is consumed.
  private buf: Uint8Array = new Uint8Array(0);

  /** Maximum permitted frame body length. Bigger than a SpawnPlayer's appearance
   *  blob but small enough to crash early on a corrupt length prefix. */
  static readonly MAX_FRAME_BYTES = 4 * 1024 * 1024;

  /** Append bytes received from the transport. */
  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.byteLength);
    this.buf = merged;
  }

  /** Pop one complete frame body, or undefined if not enough bytes yet. */
  next(): Uint8Array | undefined {
    if (this.buf.byteLength < 4) return undefined;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const len = view.getUint32(0, false /* big-endian */);
    if (len > FrameReader.MAX_FRAME_BYTES) {
      throw new RangeError(`frame body length ${len} exceeds MAX_FRAME_BYTES`);
    }
    if (this.buf.byteLength < 4 + len) return undefined;
    // Slice yields a copy; we then trim the internal buffer.
    const body = this.buf.slice(4, 4 + len);
    this.buf = this.buf.slice(4 + len);
    return body;
  }

  /** Drain every complete frame in one call. */
  drain(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (;;) {
      const f = this.next();
      if (!f) return out;
      out.push(f);
    }
  }

  /** Bytes still unconsumed — useful for diagnostics, e.g. "11 bytes pending". */
  get pendingByteLength(): number {
    return this.buf.byteLength;
  }
}
