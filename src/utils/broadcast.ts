export type ChannelTarget = {
  platform?: string;
  channelId: string;
};

export function parseChannelTarget(input: string): ChannelTarget | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return { channelId: trimmed };
  }
  const platform = trimmed.slice(0, colonIndex).trim();
  const channelId = trimmed.slice(colonIndex + 1).trim();
  if (!platform || !channelId) return null;
  return { platform, channelId };
}

export function chunkLines(
  header: string,
  lines: string[],
  maxLines: number,
): string[] {
  if (!lines.length) return [];
  const safeMax = Math.max(1, Math.floor(maxLines));
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += safeMax) {
    const block = lines.slice(i, i + safeMax);
    chunks.push([header, ...block].join("\n"));
  }
  return chunks;
}
