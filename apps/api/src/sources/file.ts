import { open } from 'node:fs/promises';
export async function readBoundedFile(
  path: string,
  cap: number,
): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > cap)
      throw new Error('Expected a file within the size limit');
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > cap) throw new Error('File exceeds byte limit');
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}
