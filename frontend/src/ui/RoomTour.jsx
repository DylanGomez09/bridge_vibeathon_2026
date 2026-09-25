import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { TOUR_STEPS } from "./tour-steps.js"

const TOOLTIP_W = 348
const TOOLTIP_H = 268
const MARGIN = 16
const GAP = 14
const PAD = 8

function placeTooltip(rect) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!rect) {
    return { top: Math.max(MARGIN, Math.round((vh - TOOLTIP_H) / 2)), left: Math.round((vw - TOOLTIP_W) / 2) }
  }
  let top = rect.top + rect.height + GAP
  if (top + TOOLTIP_H > vh - MARGIN) {
    const above = rect.top - GAP - TOOLTIP_H
    top = above >= MARGIN ? above : Math.max(MARGIN, Math.min(top, vh - TOOLTIP_H - MARGIN))
  }
  const left = Math.min(
    Math.max(MARGIN, rect.left + rect.width / 2 - TOOLTIP_W / 2),
    Math.max(MARGIN, vw - TOOLTIP_W - MARGIN),
  )
  return { top: Math.round(top), left: Math.round(left) }
}

export default function RoomTour({ open, onClose, onNavigate, onMode, activePanel }) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState(null)
  const nextRef = useRef(null)
  const step = TOUR_STEPS[index]
  const last = index === TOUR_STEPS.length - 1

  const finish = useCallback(() => {
    setIndex(0)
    setRect(null)
    onClose()
  }, [onClose])

  const goTo = useCallback(
    (next) => {
      const target = TOUR_STEPS[next]
      if (!target) return
      setIndex(next)
      setRect(null)
      if (target.panel && target.panel !== activePanel) onNavigate(target.panel)
      if (target.mode) onMode(target.mode)
    },
    [activePanel, onMode, onNavigate],
  )

  const next = useCallback(() => {
    if (last) {
      finish()
      return
    }
    goTo(index + 1)
  }, [finish, goTo, index, last])

  const prev = useCallback(() => {
    if (index > 0) goTo(index - 1)
  }, [goTo, index])

  useEffect(() => {
    if (!open) return
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        finish()
      } else if (event.key === "ArrowRight" || event.key === "Enter") {
        event.preventDefault()
        next()
      } else if (event.key === "ArrowLeft") {
        event.preventDefault()
        prev()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [finish, next, open, prev])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const selector = step.target
      if (!selector) {
        setRect(null)
        return
      }
      const el = document.querySelector(selector)
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) {
        setRect(null)
        return
      }
      setRect({
        top: Math.round(r.top - PAD),
        left: Math.round(r.left - PAD),
        width: Math.round(r.width + PAD * 2),
        height: Math.round(r.height + PAD * 2),
      })
    }
    const timers = [
      setTimeout(measure, 60),
      setTimeout(measure, 220),
      setTimeout(measure, 420),
    ]
    const onReflow = () => measure()
    window.addEventListener("resize", onReflow)
    window.addEventListener("scroll", onReflow, true)
    return () => {
      timers.forEach(clearTimeout)
      window.removeEventListener("resize", onReflow)
      window.removeEventListener("scroll", onReflow, true)
    }
  }, [open, step, activePanel])

  useEffect(() => {
    if (open) nextRef.current?.focus()
  }, [open, index])

  if (!open) return null

  const spot = placeTooltip(rect)

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Recorrido por Puente">
      {rect ? (
        <div
          className="tour-spot"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      ) : (
        <div className="tour-dim" />
      )}

      <div
        className="tour-card"
        style={{ top: spot.top, left: spot.left, width: TOOLTIP_W }}
        aria-live="polite"
      >
        <div className="tour-head">
          <span className="tour-count">
            {index + 1} / {TOUR_STEPS.length}
          </span>
          <button type="button" className="tour-skip" onClick={finish}>
            Saltar
          </button>
        </div>
        <h2 className="tour-title">{step.title}</h2>
        <p className="tour-body">{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {TOUR_STEPS.map((item, i) => (
            <span key={item.id} className={`tour-dot${i === index ? " is-on" : ""}`} />
          ))}
        </div>
        <div className="tour-actions">
          {index > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={prev}>
              Atrás
            </button>
          ) : (
            <span />
          )}
          <button ref={nextRef} type="button" className="btn btn-primary btn-sm" onClick={next}>
            {last ? "Listo, empezar" : "Siguiente"}
          </button>
        </div>
      </div>
    </div>
  )
}
