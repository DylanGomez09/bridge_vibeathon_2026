import { useEffect, useState } from "react"
import {
  ArrowRightIcon,
  MicIcon,
  PlayIcon,
  SessionsIcon,
  SparkleIcon,
  TranslateIcon,
  WaveIcon,
} from "./icons.jsx"

const STEPS = [
  {
    title: "Conectá",
    body: "El orador habla (micrófono o archivo de audio) y Bridge abre una sesión en vivo con Gemini.",
  },
  {
    title: "Escuchá en vivo",
    body: "El audio se envía por turnos y la transcripción original baja en streaming, con timestamps.",
  },
  {
    title: "Seguí en tu idioma",
    body: "La traducción al español se completa por segmentos y se muestra al instante en el panel.",
  },
]

const FEATURES = [
  {
    icon: MicIcon,
    title: "Transcripción en vivo",
    body: "El audio se envía en tiempo real y el texto original aparece en streaming mientras el orador habla.",
  },
  {
    icon: TranslateIcon,
    title: "Traducción simultánea",
    body: "La traducción al español se arma por segmentos y se completa a los pocos segundos de cada turno.",
  },
  {
    icon: SessionsIcon,
    title: "Varias sesiones",
    body: "Seguí distintas charlas a la vez, cada una con su badge de idioma y su contador de oyentes.",
  },
  {
    icon: WaveIcon,
    title: "Subtítulos listos",
    body: "Cada sesión genera su transcripción completa lista para ver o descargar (SRT) cuando termina.",
  },
]

const FAQ = [
  {
    question: "¿Qué necesita Bridge para funcionar?",
    answer:
      "Solo un navegador con micrófono. La demo transcribe y traduce EN → ES con Google Gemini en vivo.",
  },
  {
    question: "¿Cuánto tarda en salir el primer subtítulo?",
    answer:
      "Entre 5 y 8 segundos desde que arranca el audio. Después baja un segmento nuevo cada ~20 segundos.",
  },
  {
    question: "¿Se puede descargar la transcripción?",
    answer:
      "Sí. Cada sesión termina con su transcripción completa lista para exportar en formato SRT.",
  },
  {
    question: "¿Funciona con otros idiomas?",
    answer:
      "En esta demo el backend traduce inglés a español. Los selectores ya aceptan otros idiomas y quedan listos para producción.",
  },
]

const LIVE_DEMO = [
  {
    en: "Welcome to the talk! Today we'll explore accessible subtitles for everyone.",
    es: "¡Bienvenidos a la charla! Hoy vamos a explorar subtítulos accesibles para todos.",
  },
  {
    en: "Every single word happens in real time, powered by Gemini Live.",
    es: "Cada palabra sucede en tiempo real, impulsado por Gemini Live.",
  },
  {
    en: "Subtitles should be for everyone, not only for people who hear.",
    es: "Los subtítulos deberían ser para todos, no solo para quien oye.",
  },
  {
    en: "That is why Bridge turns each segment into your language instantly.",
    es: "Por eso Bridge convierte cada segmento a tu idioma al instante.",
  },
]

function FaqItem({ item }) {
  const [open, setOpen] = useState(false)

  return (
    <div
      className={`faq-item${open ? " open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="faq-question"
        tabIndex={0}
        role="button"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {item.question}
      </div>
      <div className="faq-answer">
        <p>{item.answer}</p>
      </div>
    </div>
  )
}

export default function Landing({ onEnterApp }) {
  const [heroReady, setHeroReady] = useState(false)
  const [liveSeg, setLiveSeg] = useState(0)
  const [liveTick, setLiveTick] = useState(0)

  const demo = LIVE_DEMO[liveSeg]
  const demoTotal = demo.en.length + 1 + demo.es.length
  const liveReduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  const demoEn = liveReduce ? demo.en.length : Math.min(liveTick, demo.en.length)
  const demoEs = liveReduce
    ? demo.es.length
    : Math.max(0, Math.min(demo.es.length, liveTick - demo.en.length - 1))

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    if (reduceMotion) {
      const timer = setTimeout(
        () => {
          setLiveSeg((seg) => (seg + 1) % LIVE_DEMO.length)
        },
        2000,
      )
      return () => clearTimeout(timer)
    }
    if (liveTick < demoTotal) {
      const timer = setTimeout(() => setLiveTick((t) => t + 1), 26)
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(
      () => {
        setLiveSeg((seg) => (seg + 1) % LIVE_DEMO.length)
        setLiveTick(0)
      },
      2200,
    )
    return () => clearTimeout(timer)
  }, [liveTick, demoTotal, liveSeg])

  useEffect(() => {
    const elements = document.querySelectorAll(".reveal")
    if (!("IntersectionObserver" in window)) {
      elements.forEach((element) => element.classList.add("in-view"))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view")
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.15 },
    )
    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [])

  const scrollTo = (event, id) => {
    event.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })
  }

  const scrollToSteps = (event) => scrollTo(event, "como-funciona")
  const scrollToFeatures = (event) => scrollTo(event, "caracteristicas")
  const scrollToDemo = (event) => scrollTo(event, "demo")
  const scrollToFaq = (event) => scrollTo(event, "faq")
  const scrollTop = (event) => {
    event.preventDefault()
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <a className="brand-row brand-mark" href="#/" aria-label="Bridge inicio">
            <img src="/brand/logo.svg" alt="Bridge" />
          </a>
          <nav className="landing-nav-links" aria-label="Navegación principal">
            <a href="#/" onClick={scrollTop}>Inicio</a>
            <a href="#como-funciona" onClick={scrollToSteps}>Cómo funciona</a>
            <a href="#caracteristicas" onClick={scrollToFeatures}>Características</a>
            <a href="#demo" onClick={scrollToDemo}>Demostración</a>
            <a href="#faq" onClick={scrollToFaq}>Preguntas</a>
            <button type="button" className="btn btn-brand btn-sm nav-cta" onClick={() => onEnterApp()}>
              Abrir la app
            </button>
          </nav>
        </div>
      </header>

      <section className="hero">
        <span className="hero-orb orb-brand" aria-hidden="true" />
        <span className="hero-orb orb-live" aria-hidden="true" />
        <div className="hero-grid">
          <div>
            <span className="badge">
              <SparkleIcon size={14} />
              Nerdearla Vibeathon 2026 Special
            </span>
            <h1>
              Subtitulá charlas <em>en vivo</em>, sin perder una palabra.
            </h1>
            <p className="hero-sub">
              Puente transcribe conferencias en inglés y las traduce al español en
              tiempo real. Seguí a tu orador favorito con el panel de
              traducción dentro de la app — así de simple.
            </p>
            <div className="hero-ctas">
              <button type="button" className="btn btn-brand" onClick={() => onEnterApp("sesiones")}>
                <PlayIcon size={16} />
                Ver sesiones en vivo
              </button>
              <a className="btn btn-ghost" href="#como-funciona" onClick={scrollToSteps}>
                Saber más
              </a>
            </div>
          </div>

          <div className="hero-media mosaic" aria-label="Lugar para el mockup del producto">
            <div className="hero-live-chip">
              <span className="dot" aria-hidden="true" />
              Transmisión EN → ES
            </div>
            <img
              src="/brand/hero.png"
              alt=""
              onLoad={() => setHeroReady(true)}
              onError={() => setHeroReady(false)}
            />
            {heroReady ? null : (
              <div className="hero-placeholder">
                <strong>Mockup del producto</strong>
                <span>Tu imagen del panel de traducción va acá.</span>
                <code>public/brand/hero.png</code>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="brand-band" aria-label="Marca del evento">
        <div className="brand-band-inner">
          <a href="https://nerdearla.com/en/" target="_blank" rel="noreferrer">
            <img src="/brand/NERDEARLA_color_black.png" alt="Nerdearla" />
          </a>
        </div>
      </section>

      <section className="steps how reveal" id="como-funciona">
        <span className="steps-orb" aria-hidden="true" />
        <div className="steps-inner">
          <span className="eyebrow eyebrow-brand">Cómo funciona</span>
          <h2>¿Cómo funciona Puente?</h2>
          <div className="steps-grid flow reveal-cards">
            {STEPS.map((step, index) => (
              <article className="step" key={step.title}>
                <span className="step-num">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="steps features reveal" id="caracteristicas" aria-label="Características">
        <span className="features-orb" aria-hidden="true" />
        <div className="steps-inner">
          <span className="eyebrow">Características</span>
          <h2>Hecho para seguir la charla</h2>
          <div className="steps-grid reveal-cards">
            {FEATURES.map((feature) => {
              const Icon = feature.icon
              return (
                <article className="step" key={feature.title}>
                  <span className="feature-icon">
                    <Icon size={18} />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              )
            })}
          </div>
        </div>
      </section>

      <section className="steps live-demo reveal" id="demo" aria-label="Demo en vivo">
        <div className="steps-inner">
          <h2>Miralo traducir</h2>
          <p className="live-demo-lead">
            Así se ve el panel Traducción trabajando. Cada segmento baja y se
            completa en segundos.
          </p>
          <div className="live-window">
            <div className="live-head">
              <span className="dot" aria-hidden="true" />
              EN → ES · Transmisión en vivo
            </div>
            <div className="live-body">
              <div className="live-row">
                <span className="live-lang en">EN</span>
                <p>
                  {demo.en.slice(0, demoEn)}
                  {demoEn < demo.en.length ? <span className="caret" aria-hidden="true" /> : null}
                </p>
              </div>
              <div className="live-row">
                <span className="live-lang es">ES</span>
                <p>
                  {demo.es.slice(0, demoEs)}
                  {demoEs < demo.es.length ? <span className="caret" aria-hidden="true" /> : null}
                </p>
              </div>
            </div>
            <div className="live-progress">
              <span
                style={{
                  width: `${Math.min(100, Math.round((liveTick / demoTotal) * 100))}%`,
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="steps reveal" id="faq" aria-label="Preguntas frecuentes">
        <div className="steps-inner">
          <h2>Preguntas frecuentes</h2>
          <div className="faq-list reveal-cards">
            {FAQ.map((item) => (
              <FaqItem key={item.question} item={item} />
            ))}
          </div>
        </div>
      </section>

      <section className="cta-band reveal" aria-label="Probar Puente">
        <span className="cta-orb" aria-hidden="true" />
        <span className="cta-chip cta-en" aria-hidden="true">EN</span>
        <span className="cta-chip cta-es" aria-hidden="true">ES</span>
        <div className="cta-band-inner">
          <span className="eyebrow eyebrow-light">Probá Puente</span>
          <h2>¿Ya querés probarlo?</h2>
          <p>
            Abrí la app, conectá el micrófono o subí un audio, y mira la
            traducción aparecer en vivo.
          </p>
          <div className="cta-actions">
            <button type="button" className="btn btn-light btn-lg" onClick={() => onEnterApp("traduccion")}>
              Probar la app <ArrowRightIcon size={18} />
            </button>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="footer-meta">
          <span>Bridge — transcripción y traducción simultánea</span>
          <span>Nerdearla Vibeathon 2026</span>
        </div>
        <div className="footer-credits">
          <span className="credit">
            Design by{" "}
            <a
              className="credit-value"
              href="https://www.linkedin.com/in/dylang%C3%B3mez09/"
              target="_blank"
              rel="noreferrer"
            >
              Dylan Gómez
            </a>
          </span>
          <span className="credit powered">
            Powered by{" "}
            <a href="https://nerdearla.com/en/" target="_blank" rel="noreferrer">
              <img className="credit-logo" src="/brand/NERDEARLA_black.png" alt="Nerdearla" />
            </a>
          </span>
        </div>
      </footer>
    </div>
  )
}