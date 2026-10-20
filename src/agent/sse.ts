export type SseFrame = { event: string; data: string };

function parseFrame(raw: string): SseFrame | null {
  const dataLines: string[] = [];
  let event = "message";

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Returns a stateful parser. A chunk boundary can fall in the middle of a frame (including between \n\n),
 * so the unconsumed tail must stay in the buffer to be appended to and split next time.
 */
export function createSseParser(): (chunk: string) => SseFrame[] {
  let buffer = "";

  return (chunk: string): SseFrame[] => {
    buffer += chunk;
    const frames: SseFrame[] = [];
    let sep = buffer.indexOf("\n\n");

    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      sep = buffer.indexOf("\n\n");
    }

    return frames;
  };
}
