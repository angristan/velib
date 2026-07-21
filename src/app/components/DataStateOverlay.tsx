import { Button, Loader, Stack, Text } from "@mantine/core"
import { IconDatabaseOff, IconRefresh } from "@tabler/icons-react"

interface DataStateOverlayProps {
  readonly loading: boolean
  readonly error: string | null
  readonly onRefresh: () => void
}

export const DataStateOverlay = ({ loading, error, onRefresh }: DataStateOverlayProps) => {
  if (loading) {
    return (
      <div className="data-state-overlay" role="status">
        <Loader color="blue" size="sm" />
        <Text fw={700}>Connexion au réseau…</Text>
      </div>
    )
  }

  return (
    <div className="data-state-overlay data-state-overlay--empty">
      <Stack align="center" gap={10} maw={390}>
        <span className="empty-state-icon"><IconDatabaseOff size={30} /></span>
        <Text component="h2" className="empty-state-title">
          {error ? "Le réseau ne répond pas" : "La collecte va bientôt commencer"}
        </Text>
        <Text c="dimmed" size="md" ta="center">
          {error
            ? "Impossible de récupérer les données pour le moment. Aucun chiffre fictif n’est affiché."
            : "Aucune observation n’est encore disponible. Les premières stations apparaîtront après le prochain passage du collecteur."}
        </Text>
        <Button leftSection={<IconRefresh size={18} />} onClick={onRefresh} size="md" variant="filled">
          Réessayer
        </Button>
      </Stack>
    </div>
  )
}
