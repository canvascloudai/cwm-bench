// SSM inline stdout is limited and redacted. Transfer an immutable gzip snapshot
// in bounded lowercase-hex chunks, checking byte count and SHA256 before decode.
import { randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { runRemoteShell } from './aws.mjs';

export const TEXT_CHUNK_BYTES = 8000;
export const MAX_TEXT_GZIP_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export async function readRemoteText(runAws, options) {
  const { producer, ...remote } = options;
  const file = `/tmp/cwm-collect-${randomUUID()}`;
  const shell = commands => runRemoteShell(runAws, {
    ...remote, commands, throwOnFailure: true,
  });
  let primaryError;
  try {
    const staged = await shell([
      'set -euo pipefail',
      'umask 077',
      `(\n${producer}\n) > "${file}.txt"`,
      `gzip -c "${file}.txt" > "${file}.gz"`,
      `printf 'CWM_TEXT_BYTES=%s\\n' "$(wc -c < "${file}.gz" | tr -d ' ')"`,
      `printf 'CWM_TEXT_SHA256=%s\\n' "$(sha256sum "${file}.gz" | cut -d ' ' -f 1)"`,
    ]);
    const sizeMatch = staged.stdout.match(/^CWM_TEXT_BYTES=(\d+)$/m);
    const hashMatch = staged.stdout.match(/^CWM_TEXT_SHA256=([a-f0-9]{64})$/m);
    const bytes = Number(sizeMatch?.[1]);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_TEXT_GZIP_BYTES || !hashMatch)
      throw new Error('Remote text snapshot metadata missing, truncated, or oversized');
    const buffers = [];
    for (let index = 0; index * TEXT_CHUNK_BYTES < bytes; index++) {
      const result = await shell([
        'set -euo pipefail',
        "printf 'CWM_TEXT_HEX='",
        `dd if="${file}.gz" bs=${TEXT_CHUNK_BYTES} skip=${index} count=1 status=none | od -An -v -tx1 | tr -d ' \\n'`,
        "printf '\\n'",
      ]);
      const match = result.stdout.match(/^CWM_TEXT_HEX=([a-f0-9]+)$/m);
      const expectedBytes = Math.min(TEXT_CHUNK_BYTES, bytes - index * TEXT_CHUNK_BYTES);
      if (!match || match[1].length !== expectedBytes * 2)
        throw new Error(`Remote text chunk ${index} missing, truncated, or redacted`);
      buffers.push(Buffer.from(match[1], 'hex'));
    }
    const compressed = Buffer.concat(buffers);
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    if (compressed.length !== bytes || sha256 !== hashMatch[1])
      throw new Error('Remote text snapshot SHA256 or byte count mismatch');
    const text = gunzipSync(compressed, { maxOutputLength: MAX_TEXT_BYTES });
    return {
      stdout: text.toString('utf8'),
      transfer: { encoding: 'gzip-lowercase-hex', compressedBytes: bytes,
        uncompressedBytes: text.length, sha256, chunks: buffers.length,
        verifiedBeforeParse: true },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await shell([`rm -f "${file}.txt" "${file}.gz"`]);
    } catch (error) {
      if (!primaryError) throw error;
      primaryError.message += '; remote snapshot cleanup also failed';
    }
  }
}
