import { useCallback, useEffect, useRef, useState } from "react"

import { fetchSessionStatus, verifyTurnstile } from "../api"

interface AccessSession {
  readonly checked: boolean
  readonly verified: boolean
  readonly siteKey: string
  readonly error: string | null
  readonly retry: () => void
  readonly requireVerification: () => void
  readonly verify: (token: string) => Promise<boolean>
}

const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.message : "La vérification est indisponible"

export const useAccessSession = (): AccessSession => {
  const [checked, setChecked] = useState(false)
  const [verified, setVerified] = useState(false)
  const [siteKey, setSiteKey] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [requestNumber, setRequestNumber] = useState(0)
  const verificationAbortRef = useRef<AbortController | null>(null)

  const retry = useCallback(() => {
    setChecked(false)
    setError(null)
    setRequestNumber((current) => current + 1)
  }, [])

  const requireVerification = useCallback(() => {
    setChecked(true)
    setVerified(false)
    setError(null)
  }, [])

  const verify = useCallback(async (token: string): Promise<boolean> => {
    verificationAbortRef.current?.abort()
    const controller = new AbortController()
    verificationAbortRef.current = controller
    try {
      await verifyTurnstile(token, controller.signal)
      if (verificationAbortRef.current !== controller) return false
      setVerified(true)
      setError(null)
      return true
    } catch (nextError) {
      if (controller.signal.aborted) return false
      setError(messageFrom(nextError))
      return false
    } finally {
      if (verificationAbortRef.current === controller) {
        verificationAbortRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void fetchSessionStatus(controller.signal).then((status) => {
      setSiteKey(status.turnstileSiteKey)
      setVerified(status.verified)
      setChecked(true)
    }).catch((nextError: unknown) => {
      if (controller.signal.aborted) return
      setError(messageFrom(nextError))
      setChecked(true)
    })
    return () => controller.abort()
  }, [requestNumber])

  useEffect(() => () => verificationAbortRef.current?.abort(), [])

  return {
    checked,
    verified,
    siteKey,
    error,
    retry,
    requireVerification,
    verify,
  }
}
