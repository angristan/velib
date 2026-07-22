type WaitForMapLoad = (listener: () => void) => () => void

export const updateWhenMapResourceAvailable = (
  resourceAvailable: () => boolean,
  update: () => void,
  waitForMapLoad: WaitForMapLoad,
): (() => void) | undefined => {
  if (resourceAvailable()) {
    update()
    return undefined
  }

  return waitForMapLoad(update)
}
