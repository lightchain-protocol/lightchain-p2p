export interface RelayHandlers {
  onMessage(frame: string): void
  onClose(): void
  onError(error: Error): void
}

export interface RelaySocket {
  close(): void
}

export function connect(url: string, handlers: RelayHandlers): Promise<RelaySocket>
