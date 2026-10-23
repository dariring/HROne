import { decrypt, encrypt } from './crypto.ts';
import { getSetting, setSetting } from './db.ts';
import type { AlertSettings, DefaultsSettings, Limits, NotifyPrefs, PanelSettings, Resources } from './types.ts';

export const NO_LIMITS: Resources = { cpu: null, memoryMB: null, swapMB: null, tasks: null, cpuWeight: null };

export const DEFAULT_NOTIFY: NotifyPrefs = {
  push: true,
  pending: true,
  start: false,
  success: true,
  failure: true,
  crash: true,
};

export const settings = {
  panel(): PanelSettings {
    const s = getSetting<PanelSettings>('panel', { port: 7700, access: 'private', allowedCidrs: [], baseUrl: '' });
    const envPort = Number(process.env.HRONE_PORT);
    if (envPort) s.port = envPort;
    return s;
  },
  setPanel(v: PanelSettings) {
    setSetting('panel', v);
  },
  limits(): Limits {
    const l = getSetting<Partial<Limits>>('limits', {});
    return {
      total: { ...NO_LIMITS, ...l.total },
      apps: { ...NO_LIMITS, ...l.apps },
      dbs: { ...NO_LIMITS, ...l.dbs },
    };
  },
  setLimits(v: Limits) {
    setSetting('limits', v);
  },
  alerts(): AlertSettings {
    return getSetting<AlertSettings>('alerts', { enabled: true, diskPercent: 90, memPercent: 95 });
  },
  setAlerts(v: AlertSettings) {
    setSetting('alerts', v);
  },
  defaults(): DefaultsSettings {
    const d = getSetting<DefaultsSettings>('defaults', { pollIntervalSec: 60, notify: DEFAULT_NOTIFY });
    d.notify = { ...DEFAULT_NOTIFY, ...d.notify };
    return d;
  },
  setDefaults(v: DefaultsSettings) {
    setSetting('defaults', v);
  },
  githubToken(): string {
    try {
      return decrypt(getSetting<string>('github_token', ''));
    } catch {
      return '';
    }
  },
  setGithubToken(token: string) {
    setSetting('github_token', token ? encrypt(token) : '');
  },
  discordWebhook(): string {
    try {
      return decrypt(getSetting<string>('discord_webhook', ''));
    } catch {
      return '';
    }
  },
  setDiscordWebhook(url: string) {
    setSetting('discord_webhook', url ? encrypt(url) : '');
  },
};
