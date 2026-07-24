import { useCallback, useEffect, useRef, useState } from "react"

import { ApiRequestError, fetchSessionStatus, verifyTurnstile } from "../api"
import { useI18n } from "../i18n"

interface AccessSession {
  readonly checked: boolean
  readonly verified: boolean
  readonly siteKey: string
  readonly error: string | null
  readonly retry: () => void
  readonly requireVerification: () => void
  readonly verify: (token: string) => Promise<boolean>
}

type AccessErrorCode = "rate_limited" | "unavailable"

const errorCodeFrom = (error: unknown): AccessErrorCode =>
  error instanceof ApiRequestError && error.status === 429 ? "rate_limited" : "unavailable"

export const useAccessSession = (): AccessSession => {
  const { messages } = useI18n()
  const [checked, setChecked] = useState(false)
  const [verified, setVerified] = useState(false)
  const [siteKey, setSiteKey] = useState("")
  const [errorCode, setErrorCode] = useState<AccessErrorCode | null>(null)
  const [requestNumber, setRequestNumber] = useState(0)
  const verificationAbortRef = useRef<AbortController | null>(null)

  const retry = useCallback(() => {
    setChecked(false)
    setErrorCode(null)
    setRequestNumber((current) => current + 1)
  }, [])

  const requireVerification = useCallback(() => {
    setChecked(true)
    setVerified(false)
    setErrorCode(null)
  }, [])

  const verify = useCallback(async (token: string): Promise<boolean> => {
    verificationAbortRef.current?.abort()
    const controller = new AbortController()
    verificationAbortRef.current = controller
    try {
      await verifyTurnstile(token, controller.signal)
      if (verificationAbortRef.current !== controller) return false
      setVerified(true)
      setErrorCode(null)
      return true
    } catch (nextError) {
      if (controller.signal.aborted) return false
      setErrorCode(errorCodeFrom(nextError))
      return false
    } finally {
      if (verificationAbortRef.current === controller) {
        verificationAbortRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setErrorCode(null)
    void fetchSessionStatus(controller.signal).then((status) => {
      setSiteKey(status.turnstileSiteKey)
      setVerified(status.verified)
      setChecked(true)
    }).catch((nextError: unknown) => {
      if (controller.signal.aborted) return
      setErrorCode(errorCodeFrom(nextError))
      setChecked(true)
    })
    return () => controller.abort()
  }, [requestNumber])

  useEffect(() => () => verificationAbortRef.current?.abort(), [])

  return {
    checked,
    verified,
    siteKey,
    error: errorCode === null
      ? null
      : errorCode === "rate_limited"
        ? messages.errors.rateLimited
        : messages.errors.verificationUnavailable,
    retry,
    requireVerification,
    verify,
  }
}
