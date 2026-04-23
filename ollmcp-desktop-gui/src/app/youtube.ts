function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs))
}

export function extractYouTubeIds(text: string): string[] {
  const t = text || ''
  const ids: string[] = []

  // Common URL forms
  for (const m of t.matchAll(/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{11})/g)) {
    ids.push(m[1])
  }
  for (const m of t.matchAll(
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?[^#\s]*\bv=([A-Za-z0-9_-]{11})/g,
  )) {
    ids.push(m[1])
  }
  for (const m of t.matchAll(
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/g,
  )) {
    ids.push(m[1])
  }
  for (const m of t.matchAll(
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{11})/g,
  )) {
    ids.push(m[1])
  }

  // "ID abcdefghijk" or "(ID abcdefghijk)" in plain text
  for (const m of t.matchAll(/\bID\s+([A-Za-z0-9_-]{11})\b/g)) {
    ids.push(m[1])
  }

  return uniq(ids)
}

export function hasYouTubeThumbnailAlready(text: string, id: string): boolean {
  const t = text || ''
  return (
    t.includes(`img.youtube.com/vi/${id}/`) ||
    t.includes(`i.ytimg.com/vi/${id}/`) ||
    t.includes(`img.youtube.com/vi/${id}`) ||
    t.includes(`i.ytimg.com/vi/${id}`)
  )
}

export function appendYouTubeThumbnailMarkdown(text: string): string {
  const ids = extractYouTubeIds(text)
  if (ids.length === 0) return text

  const blocks: string[] = []
  for (const id of ids.slice(0, 3)) {
    if (hasYouTubeThumbnailAlready(text, id)) continue
    const videoUrl = `https://www.youtube.com/watch?v=${id}`
    const thumbUrl = `https://img.youtube.com/vi/${id}/hqdefault.jpg`
    blocks.push(`[![YouTube thumbnail](${thumbUrl})](${videoUrl})`)
  }

  if (blocks.length === 0) return text
  return `${text}\n\n${blocks.join('\n\n')}\n`
}

