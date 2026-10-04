/**
 * 闸口离线作业队列（浏览器端）。
 *
 * - 队列持久化在 localStorage：刷新/关页不丢失，重启后自动续传
 * - 每条操作携带设备标识 + 设备内单调序号 + 幂等键，服务端按键合并
 * - 上传按序号排序；失败自动退避重试；`online` 事件触发立即同步
 * - 刷新时若存在「已发出未确认」的操作，先向服务端按幂等键对账再决定重传
 */

export type GateStepKind = 'check-in' | 'ocr' | 'weigh' | 'seal' | 'complete';
export type OpStatus = 'queued' | 'syncing' | 'accepted' | 'conflict' | 'review';

export interface QueuedOp {
  key: string;
  deviceId: string;
  sequence: number;
  appointmentId: string;
  containerId: string;
  step: GateStepKind;
  occurredAt: string;
  payload?: Record<string, unknown>;
  status: OpStatus;
  attempts: number;
  reason?: string;
  clockSkewMs?: number;
}

export interface QueueSnapshot {
  deviceId: string;
  online: boolean;
  forcedOffline: boolean;
  syncing: boolean;
  ops: QueuedOp[];
  pendingCount: number;
  lastSyncAt?: string;
  lastServerTime?: string;
  lastSkewMs?: number;
}

const QUEUE_KEY = 'harborgrid.gate-queue.v1';
const DEVICE_KEY = 'harborgrid.gate-device-id';
const SEQ_KEY = 'harborgrid.gate-device-seq';
const MAX_KEPT_OPS = 120;

function loadDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `GATE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function loadQueue(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) return JSON.parse(raw) as QueuedOp[];
  } catch { /* 存储损坏时从空队列开始 */ }
  return [];
}

const deviceId = loadDeviceId();
let ops: QueuedOp[] = loadQueue();
let forcedOffline = false;
let syncing = false;
let lastSyncAt: string | undefined;
let lastServerTime: string | undefined;
let lastSkewMs: number | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

function persist() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(ops.slice(-MAX_KEPT_OPS))); } catch { /* 存储满时忽略 */ }
}

function nextSequence(): number {
  const sequence = Number(localStorage.getItem(SEQ_KEY) ?? '0') + 1;
  localStorage.setItem(SEQ_KEY, String(sequence));
  return sequence;
}

function newKey(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function queueSnapshot(): QueueSnapshot {
  return {
    deviceId,
    online: !forcedOffline && navigator.onLine,
    forcedOffline,
    syncing,
    ops: [...ops].reverse(),
    pendingCount: ops.filter(op => op.status === 'queued' || op.status === 'syncing').length,
    lastSyncAt,
    lastServerTime,
    lastSkewMs
  };
}

export function setForcedOffline(value: boolean) {
  forcedOffline = value;
  emit();
  if (!value) void flushQueue();
}

export function enqueueOp(input: { appointmentId: string; containerId: string; step: GateStepKind; payload?: Record<string, unknown> }): QueuedOp {
  const op: QueuedOp = {
    key: newKey(),
    deviceId,
    sequence: nextSequence(),
    appointmentId: input.appointmentId,
    containerId: input.containerId,
    step: input.step,
    occurredAt: new Date().toISOString(),
    payload: input.payload,
    status: 'queued',
    attempts: 0
  };
  ops.push(op);
  persist();
  emit();
  return op;
}

interface SyncResultWire { idempotencyKey: string; decision: 'accepted' | 'conflict' | 'review'; reason: string; clockSkewMs: number }

/** 上传一批待同步操作；返回是否真的发起了上传（用于决定是否刷新服务端数据）。 */
export async function flushQueue(): Promise<boolean> {
  if (syncing || forcedOffline || !navigator.onLine) return false;
  const pending = ops
    .filter(op => op.status === 'queued' || op.status === 'syncing')
    .sort((a, b) => a.sequence - b.sequence);
  if (!pending.length) return false;
  syncing = true;
  pending.forEach(op => { op.status = 'syncing'; });
  persist();
  emit();
  try {
    const response = await fetch('/api/gate/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        sentAt: new Date().toISOString(),
        ops: pending.map(op => ({
          idempotencyKey: op.key,
          deviceId: op.deviceId,
          sequence: op.sequence,
          appointmentId: op.appointmentId,
          containerId: op.containerId,
          step: op.step,
          occurredAt: op.occurredAt,
          payload: op.payload
        }))
      })
    });
    if (!response.ok) throw new Error(`同步失败 (${response.status})`);
    const body = await response.json() as { serverTime: string; clockSkewMs: number; results: SyncResultWire[] };
    lastSyncAt = new Date().toISOString();
    lastServerTime = body.serverTime;
    lastSkewMs = body.clockSkewMs;
    for (const result of body.results) {
      const op = ops.find(item => item.key === result.idempotencyKey);
      if (op) {
        op.status = result.decision;
        op.reason = result.reason;
        op.clockSkewMs = result.clockSkewMs;
      }
    }
    return true;
  } catch {
    // 网络或服务端不可用：操作回到待上传，退避后自动重试（幂等键保证重传安全）
    pending.forEach(op => { if (op.status === 'syncing') { op.status = 'queued'; op.attempts += 1; } });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void flushQueue(), 8000);
    return false;
  } finally {
    syncing = false;
    persist();
    emit();
  }
}

/** 启动时对账：上次会话中「已发出未确认」的操作向服务端查询最终状态。 */
export async function reconcileQueue(): Promise<void> {
  const stuck = ops.filter(op => op.status === 'syncing');
  if (!stuck.length || !navigator.onLine) return;
  try {
    const response = await fetch(`/api/gate/sync/status?keys=${stuck.map(op => encodeURIComponent(op.key)).join(',')}`);
    if (!response.ok) throw new Error('对账失败');
    const body = await response.json() as { results: SyncResultWire[] };
    const found = new Map(body.results.map(result => [result.idempotencyKey, result]));
    stuck.forEach(op => {
      const result = found.get(op.key);
      if (result) {
        op.status = result.decision;
        op.reason = result.reason;
      } else {
        op.status = 'queued'; // 服务端没有记录：重新上传
      }
    });
  } catch {
    stuck.forEach(op => { op.status = 'queued'; });
  }
  persist();
  emit();
}

/** 清理已有终态（接受/冲突/复核）的记录，只保留待上传项。 */
export function clearFinished() {
  ops = ops.filter(op => op.status === 'queued' || op.status === 'syncing');
  persist();
  emit();
}

window.addEventListener('online', () => { emit(); void flushQueue(); });
window.addEventListener('offline', () => emit());
