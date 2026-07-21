import { Button, Loader, Text, Title } from "@mantine/core"
import { useEffect, useRef, useState } from "react"

const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      readonly sitekey: string
      readonly appearance: "always" | "interaction-only"
      readonly size: "flexible"
      readonly theme: "auto"
      readonly action: "velib_access"
      readonly retry: "never"
      readonly "response-field": false
      readonly callback: (token: string) => void
      readonly "error-callback": (code: string) => void
      readonly "expired-callback": () => void
      readonly "timeout-callback": () => void
      readonly "unsupported-callback": () => void
    },
  ): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

interface TurnstileGateProps {
  readonly checked: boolean
  readonly error: string | null
  readonly siteKey: string
  readonly onRetry: () => void
  readonly onToken: (token: string) => Promise<boolean>
}

let scriptPromise: Promise<void> | undefined

const loadTurnstile = (): Promise<void> => {
  if (window.turnstile !== undefined) return Promise.resolve()
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT}"]`,
    )
    if (existing !== null) {
      existing.addEventListener("load", () => resolve(), { once: true })
      existing.addEventListener("error", () => {
        existing.remove()
        reject(new Error("Turnstile failed"))
      }, { once: true })
      return
    }

    const script = document.createElement("script")
    script.src = TURNSTILE_SCRIPT
    script.async = true
    script.defer = true
    script.addEventListener("load", () => resolve(), { once: true })
    script.addEventListener("error", () => {
      script.remove()
      reject(new Error("Turnstile failed"))
    }, { once: true })
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    scriptPromise = undefined
    throw error
  })
  return scriptPromise
}

export function TurnstileGate({
  checked,
  error,
  siteKey,
  onRetry,
  onToken,
}: TurnstileGateProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onTokenRef = useRef(onToken)
  const [forceVisible, setForceVisible] = useState(false)
  const [renderAttempt, setRenderAttempt] = useState(0)
  const [canRetry, setCanRetry] = useState(false)
  const [message, setMessage] = useState("Vérification de sécurité…")

  useEffect(() => {
    onTokenRef.current = onToken
  }, [onToken])

  useEffect(() => {
    if (!checked || error !== null || siteKey.length === 0) return
    let active = true
    let submitting = false
    let widgetId: string | undefined

    setCanRetry(false)
    setMessage(
      forceVisible
        ? "Confirmez que vous êtes humain."
        : "Vérification de sécurité…",
    )

    const showVisibleFallback = (nextMessage: string): void => {
      if (!active) return
      setMessage(nextMessage)
      if (forceVisible) setCanRetry(true)
      else setForceVisible(true)
    }

    void loadTurnstile().then(() => {
      if (!active || containerRef.current === null) return
      if (window.turnstile === undefined) {
        showVisibleFallback("La vérification est indisponible.")
        return
      }

      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        appearance: forceVisible ? "always" : "interaction-only",
        size: "flexible",
        theme: "auto",
        action: "velib_access",
        retry: "never",
        "response-field": false,
        callback: (token) => {
          if (submitting) return
          submitting = true
          setMessage("Validation en cours…")
          void onTokenRef.current(token).then((verified) => {
            if (!active || verified) return
            submitting = false
            showVisibleFallback("La vérification a échoué.")
          }).catch(() => {
            submitting = false
            showVisibleFallback("La vérification est indisponible.")
          })
        },
        "error-callback": (code) => {
          showVisibleFallback(`La vérification a échoué (code ${code}).`)
        },
        "expired-callback": () => {
          showVisibleFallback("La vérification a expiré.")
        },
        "timeout-callback": () => {
          showVisibleFallback("La vérification a expiré.")
        },
        "unsupported-callback": () => {
          showVisibleFallback("Ce navigateur ne peut pas effectuer la vérification.")
        },
      })
    }).catch(() => {
      showVisibleFallback("La vérification est indisponible.")
    })

    return () => {
      active = false
      if (widgetId !== undefined) window.turnstile?.remove(widgetId)
    }
  }, [checked, error, forceVisible, renderAttempt, siteKey])

  return (
    <div
      aria-label="Vérification de sécurité"
      aria-live="polite"
      aria-modal="true"
      className="verification-overlay"
      role="dialog"
    >
      <div className="verification-card">
        <div className="verification-brand" aria-hidden="true">V</div>
        <Title order={2}>Accès à Vélib’ Pulse</Title>
        {!checked ? (
          <>
            <Loader size="sm" />
            <Text size="sm" c="dimmed">Vérification de votre session…</Text>
          </>
        ) : error !== null ? (
          <>
            <Text size="sm" c="red">{error}</Text>
            <Button onClick={onRetry} variant="light">Réessayer</Button>
          </>
        ) : (
          <>
            <div className="verification-widget" ref={containerRef} />
            <Text size="sm" c="dimmed">{message}</Text>
            {canRetry ? (
              <Button
                onClick={() => setRenderAttempt((attempt) => attempt + 1)}
                variant="light"
              >
                Réessayer
              </Button>
            ) : null}
          </>
        )}
        <Text className="verification-note" size="xs" c="dimmed">
          Cette vérification protège le service public contre les requêtes automatisées abusives.
        </Text>
      </div>
    </div>
  )
}
