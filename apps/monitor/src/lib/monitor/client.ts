import type { ConnectionStatus, MonitorSnapshotData, ServerMessage, TimelineEvent } from './types';

type MonitorClientCallbacks = {
  onSnapshot: (snapshot: MonitorSnapshotData, ts: number) => void;
  onEvent: (event: TimelineEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError: (message: string) => void;
  shouldApplyUpdates: () => boolean;
};

const RECONNECT_STEPS_MS = [500, 1000, 2000, 4000, 8000, 10_000] as const;

export class MonitorWsClient {
  private readonly callbacks: MonitorClientCallbacks;
  private readonly clientVersion: string;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private wsUrl: string | null = null;

  constructor(options: { callbacks: MonitorClientCallbacks; clientVersion?: string }) {
    this.callbacks = options.callbacks;
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  start(wsUrl: string): void {
    this.wsUrl = wsUrl;
    this.closedByUser = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  stop(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.callbacks.onStatus('offline');
  }

  reconnectNow(): void {
    if (!this.wsUrl) {
      return;
    }
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.close();
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.wsUrl) {
      this.callbacks.onError('WebSocket URL is not configured.');
      return;
    }

    this.callbacks.onStatus('reconnecting');
    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      const hello = {
        type: 'hello',
        clientVersion: this.clientVersion,
      };
      socket.send(JSON.stringify(hello));
      this.callbacks.onStatus('connected');
    };

    socket.onmessage = (message) => {
      let payload: ServerMessage;
      try {
        payload = JSON.parse(String(message.data)) as ServerMessage;
      } catch {
        return;
      }

      if (payload.type === 'snapshot') {
        if (this.callbacks.shouldApplyUpdates()) {
          this.callbacks.onSnapshot(payload.data, payload.ts);
        }
        return;
      }

      if (payload.type === 'event') {
        if (this.callbacks.shouldApplyUpdates()) {
          this.callbacks.onEvent(payload.event);
        }
        return;
      }
    };

    socket.onerror = () => {
      this.callbacks.onError('WebSocket connection error.');
    };

    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.closedByUser) {
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.callbacks.onStatus('reconnecting');
    this.clearReconnectTimer();

    const index = Math.min(this.reconnectAttempt, RECONNECT_STEPS_MS.length - 1);
    const delay = RECONNECT_STEPS_MS[index] ?? RECONNECT_STEPS_MS[RECONNECT_STEPS_MS.length - 1];
    this.reconnectAttempt += 1;

    this.reconnectTimer = globalThis.setTimeout(() => {
      this.openSocket();
    }, delay) as unknown as number;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
