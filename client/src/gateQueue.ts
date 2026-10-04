/**
 * 闸口离线作业队列（浏览器端）
 *
 * - OCR / 称重 / 封志 / 签到四类步骤先入本地队列，写入 localStorage：
 *   浏览器刷新、工位断电重启后队列与服务端裁决都不丢失；
 * - 每个设备维护独立的单调 seq，服务端据此恢复真实操作顺序（乱序上传也能重放）；
 * - 每个步骤生成幂等键，部分成功后整批重试不会重复执行；
 * - online 事件 / 定时 / 手动触发批量上传，按设备与序号交给服务端裁决；
 * - 与 /api/gate/devices 对时，界面显示本地时钟与服务端偏差；
 * - conflict / review 不会被自动重试轰炸，保留在队列里由值班员处理或重采。
 */

export type GateLane = 'north' | 'south' | 'rail';
export type GateStepKind = 'ocr' | 'weight' | 'seal' | 'check-in';
export type GateStepStatus = 'accepted' | 'conflict' | 'review';

export interface GateDevice { id: string; name: string; lane: GateLane; kind: 'inbound' | 'outbound' | 'hybrid'; lastSeenAt?: string }
export interface GateReason { code: string; message: string; severity: 'info' | 'warning' }
export interface GateStepPayload { kind: GateStepKind; [key: string]: unknown }

export interface GateStepEnvelope {
  idempotencyKey: string;
  deviceId: string;
  appointmentId: string;
  seq: number;
  clientAt: string;
  recordedAt?: string;
  kind: GateStepKind;
  payload: GateStepPayload;
}

export interface GateSyncResponseItem {
  idempotencyKey: string;
  deviceId: string;
  appointmentId: string;
  seq: number;
  kind: GateStepKind;
  status: GateStepStatus;
  applied: boolean;
  replayed: boolean;
  reasons: GateReason[];
  serverAt: string;
  skewMs: number;
  appointmentStatus?: string;
  containerStatus?: string;
  reconciledKey?: string;
}

export type LocalItemStatus = 'queued' | 'syncing' | 'accepted' | 'conflict' | 'review' | 'error';

export interface QueueItem extends GateStepEnvelope {
  localId: string;
  enqueuedAt: string;
  localStatus: LocalItemStatus;
  attempts: number;
  lastError?: string;
  lastResult?: GateSyncResponseItem;
}

export interface GateQueueState {
  items: QueueItem[];
  devices: GateDevice[];
  deviceId: string;
  online: boolean;
  forceOffline: boolean;
  autoSync: boolean;
  syncing: boolean;
  lastSyncAt?: string;
  serverAt?: string;
  /** 本地时钟 - 服务端时钟（毫秒，正数=本地快），由对时响应估算 */
  clockSkewMs?: number;
}

const STORAGE_KEY = 'harborgrid.gate-queue.v1';

interface Persisted {
  items: QueueItem[];
  seqCounters: Record<string, number>;
  deviceId: string;
  forceOffline: boolean;
  autoSync: boolean;
}

function uid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadPersisted(): Persisted {
  if (typeof localStorage === 'undefined') return { items: [], seqCounters: {}, deviceId: 'GATE-N1', forceOffline: false, autoSync: true };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: [], seqCounters: {}, deviceId: 'GATE-N1', forceOffline: false, autoSync: true };
    const parsed = JSON.parse(raw) as Persisted;
    // 上次同步进行中崩溃：恢复为待上传，保证不丢步骤
    parsed.items = (parsed.items ?? []).map(item => item.localStatus === 'syncing' ? { ...item, localStatus: 'queued' as const } : item);
    return { items: parsed.items, seqCounters: parsed.seqCounters ?? {}, deviceId: parsed.deviceId ?? 'GATE-N1', forceOffline: parsed.forceOffline ?? false, autoSync: parsed.autoSync ?? true };
  } catch {
    return { items: [], seqCounters: {}, deviceId: 'GATE-N1', forceOffline: false, autoSync: true };
  }
}

type Listener = (state: GateQueueState) => void;

class GateQueueStore {
  private persisted: Persisted = loadPersisted();
  private items: QueueItem[] = this.persisted.items;
  private devices: GateDevice[] = [];
  private online = typeof navigator === 'undefined' ? true : navigator.onLine;
  private syncing = false;
  private lastSyncAt: string | undefined;
  private serverAt: string | undefined;
  private clockSkewMs: number | undefined;
  private listeners = new Set<Listener>();
  private syncTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.online = true; this.emit(); void this.autoSyncTick(); });
      window.addEventListener('offline', () => { this.online = false; this.emit(); });
      // 多标签页之间共享队列：一个标签页同步后，其它标签页也刷新裁决
      window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) this.reloadFromStorage(); });
      this.syncTimer = setInterval(() => void this.autoSyncTick(), 15000);
    }
    void this.refreshDevices();
    void this.autoSyncTick();
  }

  getState(): GateQueueState {
    return {
      items: [...this.items].sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq || a.enqueuedAt.localeCompare(b.enqueuedAt)),
      devices: this.devices,
      deviceId: this.persisted.deviceId,
      online: this.online,
      forceOffline: this.persisted.forceOffline,
      autoSync: this.persisted.autoSync,
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      serverAt: this.serverAt,
      clockSkewMs: this.clockSkewMs,
    };
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.persisted.items = this.items;
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.persisted)); } catch { /* 配额满时保留内存队列 */ }
    }
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private reloadFromStorage() {
    const fresh = loadPersisted();
    this.items = fresh.items;
    this.persisted.seqCounters = fresh.seqCounters;
    this.persisted.deviceId = fresh.deviceId;
    this.persisted.forceOffline = fresh.forceOffline;
    this.persisted.autoSync = fresh.autoSync;
    this.emit();
  }

  setDevice(deviceId: string) { this.persisted.deviceId = deviceId; this.emit(); }
  setForceOffline(forceOffline: boolean) { this.persisted.forceOffline = forceOffline; this.emit(); if (!forceOffline) void this.autoSyncTick(); }
  setAutoSync(autoSync: boolean) { this.persisted.autoSync = autoSync; this.emit(); if (autoSync) void this.autoSyncTick(); }

  enqueue(appointmentId: string, kind: GateStepKind, payload: GateStepPayload, deviceId = this.persisted.deviceId, clientAtOverride?: string): QueueItem {
    const now = new Date();
    const seq = (this.persisted.seqCounters[deviceId] ?? 0) + 1;
    this.persisted.seqCounters[deviceId] = seq;
    const clientAt = clientAtOverride ?? now.toISOString();
    const item: QueueItem = {
      localId: uid(),
      idempotencyKey: uid(),
      deviceId,
      appointmentId,
      seq,
      clientAt,
      recordedAt: clientAt,
      kind,
      payload,
      enqueuedAt: now.toISOString(),
      localStatus: 'queued',
      attempts: 0,
    };
    this.items.push(item);
    this.emit();
    void this.autoSyncTick();
    return item;
  }

  /** 失败/挂起步骤重新送裁（幂等键不变，服务端返回同一份或升级后的裁决） */
  retry(localId: string) {
    const item = this.items.find(entry => entry.localId === localId);
    if (!item) return;
    item.localStatus = 'queued';
    item.lastError = undefined;
    this.emit();
    void this.autoSyncTick();
  }

  retryAll() {
    let changed = false;
    for (const item of this.items) {
      if (item.localStatus === 'conflict' || item.localStatus === 'review' || item.localStatus === 'error') {
        item.localStatus = 'queued';
        item.lastError = undefined;
        changed = true;
      }
    }
    if (changed) { this.emit(); void this.autoSyncTick(); }
  }

  remove(localId: string) {
    this.items = this.items.filter(item => item.localId !== localId);
    this.emit();
  }

  /** 清除已接受的步骤（服务端已落库，本地无需再保留），挂起/冲突项保留 */
  clearAccepted() {
    this.items = this.items.filter(item => item.localStatus !== 'accepted');
    this.emit();
  }

  async refreshDevices() {
    try {
      const response = await fetch('/api/gate/devices');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { serverAt: string; devices: GateDevice[] };
      this.devices = body.devices;
      this.serverAt = body.serverAt;
      // 用请求往返中点估算本地与服务端时钟差
      const localAfter = Date.now();
      this.clockSkewMs = localAfter - Date.parse(body.serverAt);
      this.online = true;
      this.emit();
    } catch {
      this.online = false;
      this.emit();
    }
  }

  private get effectiveOnline() { return this.online && !this.persisted.forceOffline; }

  private pendingItems() {
    // queued 与上次发送中崩溃恢复的步骤才自动重发；conflict/review 等值班员动作
    return this.items.filter(item => item.localStatus === 'queued' || item.localStatus === 'syncing');
  }

  private async autoSyncTick() {
    if (this.persisted.autoSync && this.effectiveOnline && this.pendingItems().length > 0) {
      await this.sync();
    }
  }

  async sync(): Promise<{ synced: number } | { error: string }> {
    if (this.syncing) return { synced: 0 };
    if (!this.effectiveOnline) return { error: '当前处于离线状态，步骤已保存在本机队列' };
    const pending = this.pendingItems();
    if (pending.length === 0) return { synced: 0 };

    this.syncing = true;
    for (const item of pending) { item.localStatus = 'syncing'; item.attempts += 1; }
    this.emit();

    const envelopes = pending.map(({ idempotencyKey, deviceId, appointmentId, seq, clientAt, recordedAt, kind, payload }) =>
      ({ idempotencyKey, deviceId, appointmentId, seq, clientAt, recordedAt, kind, payload }));

    try {
      const response = await fetch('/api/gate/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: envelopes }),
      });
      const body = await response.json().catch(() => ({})) as { serverAt?: string; items?: GateSyncResponseItem[]; message?: string };
      const localAfter = Date.now();
      if (body.serverAt) { this.serverAt = body.serverAt; this.clockSkewMs = localAfter - Date.parse(body.serverAt); }

      if (!response.ok || !body.items) throw new Error(body.message || `同步失败（HTTP ${response.status}）`);

      const byKey = new Map(body.items.map(item => [item.idempotencyKey, item]));
      for (const item of pending) {
        const result = byKey.get(item.idempotencyKey);
        if (!result) { item.localStatus = 'error'; item.lastError = '服务端响应缺少该步骤的裁决'; continue; }
        item.lastResult = result;
        item.lastError = undefined;
        item.localStatus = result.status === 'accepted' ? 'accepted' : result.status;
      }
      this.lastSyncAt = new Date().toISOString();
      this.online = true;
      this.syncing = false;
      this.emit();
      return { synced: pending.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : '网络不可达';
      for (const item of pending) { item.localStatus = 'queued'; item.lastError = message; }
      this.online = false;
      this.syncing = false;
      this.emit();
      return { error: message };
    }
  }
}

export const gateQueue = new GateQueueStore();

export const stepLabel: Record<GateStepKind, string> = { ocr: 'OCR 识别', weight: '称重', seal: '封志检查', 'check-in': '签到' };
export const statusLabel: Record<LocalItemStatus, string> = {
  queued: '待上传', syncing: '同步中', accepted: '已接受', conflict: '冲突', review: '待人工复核', error: '网络错误',
};
