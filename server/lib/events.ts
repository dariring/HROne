import { EventEmitter } from 'node:events';

/**
 * 패널 내부 이벤트 버스. WebSocket 이 채널 단위로 구독한다.
 * 채널 예: 'status', 'metrics', 'deploys', 'deploy:12', 'apps', 'databases', 'toast'
 */
class Bus extends EventEmitter {
  publish(channel: string, data: unknown) {
    this.emit('message', channel, data);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
