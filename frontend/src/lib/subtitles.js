const LAST_SEGMENT_PADDING_MS = 3000

function formatTimecode(ms) {
  const totalSeconds = ms / 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const millis = Math.floor((totalSeconds % 1) * 1000)
  const pad = (value, length = 2) => String(value).padStart(length, "0")
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`
}

function clean(text) {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

export function buildSrt(segments, sourceDurationMs) {
  const entries = segments
    .map((segment) => ({
      start: segment.ts,
      original: clean(segment.original),
      translation: clean(segment.translation),
    }))
    .filter((entry) => entry.original || entry.translation)

  const duration = sourceDurationMs ?? 0

  const blocks = entries.map((entry, index) => {
    const next = entries[index + 1]
    let end
    if (next && next.start > entry.start) {
      end = next.start
    } else {
      end = entry.start + LAST_SEGMENT_PADDING_MS
      if (duration > 0) end = Math.min(end, duration)
    }
    const lines = []
    if (entry.original) lines.push(entry.original)
    if (entry.translation) lines.push(entry.translation)
    return `${index + 1}\n${formatTimecode(entry.start)} --> ${formatTimecode(end)}\n${lines.join("\n")}`
  })

  if (blocks.length === 0) return ""
  return `\uFEFF${blocks.join("\n\n")}\n`
}

export function downloadSrt(segments, sourceInfo, filename = "bridge.srt") {
  const content = buildSrt(segments, sourceInfo?.durationMs)
  if (!content) return false
  const blob = new Blob([content], { type: "application/x-subrip;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return true
}