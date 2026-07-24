import { Button, Loader, Stack, Text } from "@mantine/core"
import { IconDatabaseOff, IconRefresh } from "@tabler/icons-react"
import { useI18n } from "../i18n"

interface DataStateOverlayProps {
  readonly loading: boolean
  readonly error: string | null
  readonly title?: string
  readonly message?: string
  readonly actionLabel?: string
  readonly onRefresh: () => void
}

export const DataStateOverlay = ({
  loading,
  error,
  title,
  message,
  actionLabel,
  onRefresh,
}: DataStateOverlayProps) => {
  const { messages } = useI18n()
  const copy = messages.dataState
  if (loading) {
    return (
      <div className="data-state-overlay" role="status">
        <Loader color="blue" size="sm" />
        <Text fw={700}>{copy.loading}</Text>
      </div>
    )
  }

  return (
    <div className="data-state-overlay data-state-overlay--empty">
      <Stack align="center" gap={10} maw={390}>
        <span className="empty-state-icon"><IconDatabaseOff size={30} /></span>
        <Text component="h2" className="empty-state-title">
          {title ?? (error ? copy.networkUnavailable : copy.collectionStarting)}
        </Text>
        <Text c="dimmed" size="md" ta="center">
          {message ?? (error ? copy.errorHint : copy.emptyHint)}
        </Text>
        <Button leftSection={<IconRefresh size={18} />} onClick={onRefresh} size="md" variant="filled">
          {actionLabel ?? copy.retry}
        </Button>
      </Stack>
    </div>
  )
}
