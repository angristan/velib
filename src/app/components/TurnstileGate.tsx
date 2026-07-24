import { Button, Loader, Modal, Text, Title } from "@mantine/core"
import { useEffect, useRef, useState } from "react"
import { useI18n } from "../i18n"

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
      readonly language: "fr" | "en"
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
  const { locale, messages } = useI18n()
  const copy = messages.security
  const containerRef = useRef<HTMLDivElement>(null)
  const onTokenRef = useRef(onToken)
  const [forceVisible, setForceVisible] = useState(false)
  const [renderAttempt, setRenderAttempt] = useState(0)
  const [canRetry, setCanRetry] = useState(false)
  const [message, setMessage] = useState(copy.checking)

  useEffect(() => {
    onTokenRef.current = onToken
  }, [onToken])

  useEffect(() => {
    if (!checked || error !== null || siteKey.length === 0) return
    let active = true
    let submitting = false
    let widgetId: string | undefined

    setCanRetry(false)
    setMessage(forceVisible ? copy.confirmHuman : copy.checking)

    const showVisibleFallback = (nextMessage: string): void => {
      if (!active) return
      setMessage(nextMessage)
      if (forceVisible) setCanRetry(true)
      else setForceVisible(true)
    }

    void loadTurnstile().then(() => {
      if (!active || containerRef.current === null) return
      if (window.turnstile === undefined) {
        showVisibleFallback(copy.unavailable)
        return
      }

      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        appearance: forceVisible ? "always" : "interaction-only",
        size: "flexible",
        theme: "auto",
        action: "velib_access",
        retry: "never",
        language: locale,
        "response-field": false,
        callback: (token) => {
          if (submitting) return
          submitting = true
          setMessage(copy.validating)
          void onTokenRef.current(token).then((verified) => {
            if (!active || verified) return
            submitting = false
            showVisibleFallback(copy.failed)
          }).catch(() => {
            submitting = false
            showVisibleFallback(copy.unavailable)
          })
        },
        "error-callback": (code) => {
          showVisibleFallback(copy.failedCode(code))
        },
        "expired-callback": () => {
          showVisibleFallback(copy.expired)
        },
        "timeout-callback": () => {
          showVisibleFallback(copy.expired)
        },
        "unsupported-callback": () => {
          showVisibleFallback(copy.unsupported)
        },
      })
    }).catch(() => {
      showVisibleFallback(copy.unavailable)
    })

    return () => {
      active = false
      if (widgetId !== undefined) window.turnstile?.remove(widgetId)
    }
  }, [checked, copy, error, forceVisible, locale, renderAttempt, siteKey])

  return (
    <Modal
      aria-labelledby="security-verification-title"
      centered
      classNames={{ body: "verification-card__body", content: "verification-card" }}
      closeOnClickOutside={false}
      closeOnEscape={false}
      onClose={() => undefined}
      opened
      overlayProps={{ backgroundOpacity: 0.62, blur: 8 }}
      size={390}
      withCloseButton={false}
      zIndex={1_000}
    >
      <div className="verification-brand" aria-hidden="true">V</div>
      <Title
        data-autofocus
        id="security-verification-title"
        order={2}
        tabIndex={-1}
      >
        {copy.title}
      </Title>
      <div aria-live="polite" className="verification-status">
        {!checked ? (
          <>
            <Loader size="sm" />
            <Text size="sm" c="dimmed">{copy.session}</Text>
          </>
        ) : error !== null ? (
          <>
            <Text size="sm" c="red">{error}</Text>
            <Button onClick={onRetry} variant="light">{messages.common.retry}</Button>
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
                {messages.common.retry}
              </Button>
            ) : null}
          </>
        )}
      </div>
      <Text className="verification-note" size="xs" c="dimmed">
        {copy.note}
      </Text>
    </Modal>
  )
}
