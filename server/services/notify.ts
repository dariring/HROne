import os from 'node:os';
import { decryptJSON } from '../lib/crypto.ts';
import { q } from '../lib/db.ts';
import { errMsg, log } from '../lib/log.ts';
import { settings } from '../lib/settings.ts';
import type { App, AppSecrets, NotifyPrefs } from '../lib/types.ts';
import { sleep } from '../lib/util.ts';

export type NotifyKind = keyof NotifyPrefs | 'backup_failed' | 'alert' | 'panel' | 'test';

const COLORS = {
  green: 0x22c55e,
  red: 0xef4444,
  yellow: 0xf59e0b,
  blue: 0x3b82f6,
  gray: 0x64748b,
  purple: 0x8b5cf6,
};

export interface NotifyInput {
  kind: NotifyKind;
  app?: App;
  title: string;
  description?: string;
  color?: keyof typeof COLORS;
  fields?: { name: string; value: string; inline?: boolean }[];
  /** 패널 내 경로 (예: /apps/foo) — baseUrl 이 설정돼 있으면 링크가 된다 */
  path?: string;
  /** 지정하면 이 URL 로만 보낸다 (테스트용) */
  webhookOverride?: string;
}

function appWebhook(app: App) {
  const row = q.get<{ secrets_enc: string }>('SELECT secrets_enc FROM apps WHERE id = ?', app.id);
  return decryptJSON<AppSecrets>(row?.secrets_enc, { webhookSecret: '', discordWebhook: '', gitToken: '' }).discordWebhook;
}

const queue: { url: string; body: unknown }[] = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const item = queue[0]!;
      let attempts = 0;
      while (attempts < 5) {
        attempts++;
        try {
          const res = await fetch(item.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item.body),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.status === 429) {
            const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
            await sleep(Math.min(60_000, (j.retry_after ?? 2) * 1000 + 250));
            continue;
          }
          if (!res.ok) log.warn(`discord webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
          break;
        } catch (e) {
          log.warn(`discord webhook error: ${errMsg(e)}`);
          await sleep(2000 * attempts);
        }
      }
      queue.shift();
      await sleep(300);
    }
  } finally {
    draining = false;
  }
}

export function isDiscordWebhook(url: string) {
  return /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url.trim());
}

export async function notify(n: NotifyInput) {
  let url = n.webhookOverride ?? '';
  if (!url) {
    if (n.app) {
      const prefKey = n.kind as keyof NotifyPrefs;
      if (prefKey in n.app.config.notify && !n.app.config.notify[prefKey]) return;
      url = appWebhook(n.app) || settings.discordWebhook();
    } else url = settings.discordWebhook();
  }
  if (!url) return;
  const base = settings.panel().baseUrl.replace(/\/+$/, '');
  const embed: Record<string, unknown> = {
    title: n.title.slice(0, 256),
    color: COLORS[n.color ?? 'blue'],
    timestamp: new Date().toISOString(),
    footer: { text: `HROne · ${os.hostname()}` },
  };
  if (n.description) embed.description = n.description.slice(0, 4000);
  if (n.fields?.length) embed.fields = n.fields.slice(0, 25).map((f) => ({ ...f, value: f.value.slice(0, 1024) || '-' }));
  if (base && n.path) embed.url = base + n.path;
  queue.push({ url, body: { username: 'HROne', embeds: [embed], allowed_mentions: { parse: [] } } });
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  void drain();
}
