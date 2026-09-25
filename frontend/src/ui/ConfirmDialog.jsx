import { useEffect, useRef } from "react"

// <dialog> nativo con showModal(): el focus trap, el Esc, el click en el backdrop y
// el ::backdrop los resuelve el navegador, así que no hay que pelear z-index contra
// el sidebar (z-index: 50) ni el overlay del tour.
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = false,
  onConfirm,
  onCancel,
}) {
  const ref = useRef(null)
  const confirmRef = useRef(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      confirmRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // El Esc del navegador dispara "cancel"; sin esto el diálogo se cerraría solo y
  // quedaría desincronizado del estado de React.
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return undefined
    const onNativeCancel = (event) => {
      event.preventDefault()
      onCancel?.()
    }
    dialog.addEventListener("cancel", onNativeCancel)
    return () => dialog.removeEventListener("cancel", onNativeCancel)
  }, [onCancel])

  // El click en el backdrop lo cierra el navegador por su cuenta y dispara "close";
  // no se escucha "click" porque el padding del panel también apunta al <dialog> y
  // cerraría al tocarlo.
  const onNativeClose = () => {
    if (open) onCancel?.()
  }

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-title"
      onClose={onNativeClose}
    >
      <h2 id="confirm-title" className="confirm-title">
        {title}
      </h2>
      {body ? <p className="confirm-body">{body}</p> : null}
      <div className="confirm-actions">
        <button type="button" className="btn btn-surface" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={`btn ${destructive ? "btn-danger" : "btn-primary"}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
