import { appointments, auditEvents, containers } from './domain.js';
import type { Container, GateAppointment } from './domain.js';

/**
 * 闸口离线作业同步域。
 *
 * 浏览器端在断网时把签到步骤与检查结果（OCR / 称重 / 封志 / 完成）写入本地队列，
 * 恢复联网后按「设备 + 设备内序号」顺序批量上传。本模块负责：
 *  - 幂等键合并：同一 idempotencyKey 重复上传返回首次处理结果（部分成功后重试安全）
 *  - 顺序容错：前序步骤未到达的操作先挂起，前序补齐后自动生效（上传顺序颠倒安全）
 *  - 时钟容错：用批次 sentAt 估算终端时钟偏差，归一化操作时间后再校验预约窗口
 *  - 冲突防护：同一箱禁止在两个闸口重复签到；预约取消/删除后拒绝执行
 *  - 可解释性：每一步决策写入同步日志 + 审计记录，箱务/预约状态同步更新
 */

export type GateStepKind = 'check-in' | 'ocr' | 'weigh' | 'seal' | 'complete';
export type SyncDecision = 'accepted' | 'conflict' | 'review';

export interface GateOpPayload { weightT?: number; sealNo?: string; ocrPlate?: string; ocrContainerNo?: string; note?: string }
export interface GateOp { idempotencyKey: string; deviceId: string; sequence: number; appointmentId: string; containerId: string; step: GateStepKind; occurredAt: string; payload?: GateOpPayload }
export interface SyncBatch { deviceId?: string; sentAt?: string; ops?: GateOp[] }
export interface SyncResult { idempotencyKey: string; step: GateStepKind; appointmentId: string; containerId: string; decision: SyncDecision; reason: string; replay: boolean; serverSeq: number; clockSkewMs: number; occurredAt: string; normalizedAt: string; appointmentStatus?: string; containerStatus?: string }
export interface JournalEntry { serverSeq: number; idempotencyKey: string; deviceId: string; appointmentId: string; containerId: string; step: GateStepKind; decision: SyncDecision; reason: string; occurredAt: string; normalizedAt: string; clockSkewMs: number; decidedAt: string }
export interface ReviewItem { idempotencyKey: string; op: GateOp; reason: string; status: 'pending' | 'auto-applied' | 'accepted' | 'rejected'; createdAt: string; resolvedAt?: string; resolutionNote?: string }

export const STEP_LABEL: Record<GateStepKind, string> = { 'check-in': '签到', ocr: 'OCR 识别', weigh: '称重', seal: '封志检查', complete: '完成放行' };
const DECISION_LABEL: Record<SyncDecision, string> = { accepted: '接受', conflict: '冲突拒绝', review: '待人工复核' };
const STEP_KINDS: GateStepKind[] = ['check-in', 'ocr', 'weigh', 'seal', 'complete'];

const SKEW_FLAG_MS = 2 * 60_000;          // 终端时钟偏差超过 2 分钟则在结果中标记
const FUTURE_TOLERANCE_MS = 60_000;       // 归一化后仍未来超过 1 分钟 → 人工复核
const WINDOW_EARLY_GRACE_MS = 60 * 60_000;   // 离线容差：窗口前 60 分钟
const WINDOW_LATE_GRACE_MS = 120 * 60_000;   // 离线容差：窗口后 120 分钟
const WEIGHT_TOLERANCE_T = 1;             // 称重与台账允许偏差（吨）
const JOURNAL_LIMIT = 300;

interface CheckEvidence { ocr?: { plate?: string; containerNo?: string; at: string }; weigh?: { weightT: number; at: string }; seal?: { sealNo: string; at: string } }

const resultsByKey = new Map<string, SyncResult>();
const reviewByKey = new Map<string, ReviewItem>();
const parkedByAppointment = new Map<string, { op: GateOp; skewMs: number }[]>();
const appliedSteps = new Map<string, Set<GateStepKind>>();
const checkEvidence = new Map<string, CheckEvidence>();
const checkInDevice = new Map<string, string>();
const journal: JournalEntry[] = [];
let serverSeq = 0;

const findAppointment = (id: string) => appointments.find(item => item.id === id);
const findContainer = (id: string) => containers.find(item => item.id === id);

function markStep(appointmentId: string, step: GateStepKind) {
  const set = appliedSteps.get(appointmentId) ?? new Set<GateStepKind>();
  set.add(step);
  appliedSteps.set(appointmentId, set);
}

/** 步骤是否已完成：优先看同步会话记录，其次看台账当前状态（覆盖在线直接操作的场景）。 */
function hasStep(appointment: GateAppointment, step: GateStepKind): boolean {
  if (appliedSteps.get(appointment.id)?.has(step)) return true;
  switch (step) {
    case 'check-in': return appointment.status === 'checked-in' || appointment.status === 'completed';
    case 'weigh': return appointment.weightVerified;
    case 'seal': return appointment.sealVerified;
    case 'complete': return appointment.status === 'completed';
    default: return false;
  }
}

/** 步骤的前序依赖：除签到外都需要先签到；完成放行还需要称重与封志。 */
function missingPrerequisite(op: GateOp): GateStepKind | null {
  const appointment = findAppointment(op.appointmentId);
  if (!appointment || appointment.status === 'cancelled') return null; // 硬冲突在 evaluate 中处理
  if (op.step === 'check-in') return null;
  if (!hasStep(appointment, 'check-in')) return 'check-in';
  if (op.step === 'complete') {
    if (!hasStep(appointment, 'weigh')) return 'weigh';
    if (!hasStep(appointment, 'seal')) return 'seal';
  }
  return null;
}

function recordJournal(op: GateOp, decision: SyncDecision, reason: string, skewMs: number, normalizedAt: string): JournalEntry {
  const entry: JournalEntry = { serverSeq: ++serverSeq, idempotencyKey: op.idempotencyKey, deviceId: op.deviceId, appointmentId: op.appointmentId, containerId: op.containerId, step: op.step, decision, reason, occurredAt: op.occurredAt, normalizedAt, clockSkewMs: skewMs, decidedAt: new Date().toISOString() };
  journal.unshift(entry);
  if (journal.length > JOURNAL_LIMIT) journal.pop();
  return entry;
}

function audit(actor: string, op: GateOp, decision: SyncDecision, reason: string) {
  auditEvents.unshift({ id: `AUD-SYNC-${Date.now()}-${serverSeq}`, actor, action: 'GATE_SYNC', entity: 'appointment', entityId: op.appointmentId, at: new Date().toISOString(), details: `${STEP_LABEL[op.step]}·${DECISION_LABEL[decision]}：${reason}（箱 ${op.containerId}，幂等键 ${op.idempotencyKey}）` });
}

function snapshotResult(op: GateOp, decision: SyncDecision, reason: string, skewMs: number, normalizedAt: string, seq: number): SyncResult {
  const appointment = findAppointment(op.appointmentId);
  const container = findContainer(op.containerId);
  return { idempotencyKey: op.idempotencyKey, step: op.step, appointmentId: op.appointmentId, containerId: op.containerId, decision, reason, replay: false, serverSeq: seq, clockSkewMs: Math.abs(skewMs) >= SKEW_FLAG_MS ? skewMs : 0, occurredAt: op.occurredAt, normalizedAt, appointmentStatus: appointment?.status, containerStatus: container?.status };
}

/** 记录一条新决策：日志 + 幂等结果 + 复核队列 + 预约异常说明 + 审计。 */
function decide(op: GateOp, skewMs: number, decision: SyncDecision, reason: string, normalizedAt: string): SyncResult {
  const entry = recordJournal(op, decision, reason, skewMs, normalizedAt);
  const result = snapshotResult(op, decision, reason, skewMs, normalizedAt, entry.serverSeq);
  resultsByKey.set(op.idempotencyKey, result);
  const appointment = findAppointment(op.appointmentId);
  if (decision === 'review') {
    reviewByKey.set(op.idempotencyKey, { idempotencyKey: op.idempotencyKey, op, reason, status: 'pending', createdAt: new Date().toISOString() });
    if (appointment) appointment.exception = `离线复核：${reason}`;
  }
  if (decision === 'conflict' && appointment) appointment.exception = `离线冲突：${reason}`;
  audit(`离线同步·${op.deviceId}`, op, decision, reason);
  return result;
}

/** 决策落地后回写已存在的幂等结果（挂起单被补齐 / 人工复核结案时调用）。 */
function reviseResult(key: string, decision: SyncDecision, reason: string, seq: number) {
  const stored = resultsByKey.get(key);
  if (!stored) return;
  stored.decision = decision;
  stored.reason = reason;
  stored.serverSeq = seq;
  const appointment = findAppointment(stored.appointmentId);
  const container = findContainer(stored.containerId);
  stored.appointmentStatus = appointment?.status;
  stored.containerStatus = container?.status;
}

/** 状态迁移：只在 evaluate 判定 accepted 后调用。 */
function applyOp(op: GateOp, appointment: GateAppointment, container: Container) {
  const evidence = checkEvidence.get(appointment.id) ?? {};
  switch (op.step) {
    case 'check-in': {
      appointment.status = 'checked-in';
      container.status = 'at-gate';
      container.appointmentId = appointment.id;
      container.lastEvent = `离线同步签到·${appointment.lane} 闸口`;
      checkInDevice.set(appointment.id, op.deviceId);
      break;
    }
    case 'ocr': {
      evidence.ocr = { plate: op.payload?.ocrPlate, containerNo: op.payload?.ocrContainerNo, at: op.occurredAt };
      container.lastEvent = 'OCR 识别完成（离线同步）';
      break;
    }
    case 'weigh': {
      const measured = op.payload?.weightT;
      if (typeof measured === 'number') container.weightT = Math.round(measured * 10) / 10;
      appointment.weightVerified = true;
      evidence.weigh = { weightT: container.weightT, at: op.occurredAt };
      container.lastEvent = `离线同步称重 ${container.weightT}t`;
      break;
    }
    case 'seal': {
      appointment.sealVerified = true;
      evidence.seal = { sealNo: op.payload?.sealNo ?? '', at: op.occurredAt };
      container.lastEvent = `封志 ${op.payload?.sealNo ?? ''} 检查通过（离线同步）`;
      break;
    }
    case 'complete': {
      appointment.status = 'completed';
      container.status = appointment.type === 'pickup' ? 'released' : 'in-yard';
      container.lastEvent = `闸口${appointment.type === 'pickup' ? '提箱出场' : '进场入区'}（离线同步）`;
      break;
    }
  }
  checkEvidence.set(appointment.id, evidence);
  markStep(appointment.id, op.step);
}

/**
 * 评估单个操作。硬冲突（预约取消/删除、箱号不符、跨闸口重复签到）永远拒绝，
 * 不受 override 影响；软性异常（窗口、时钟、重量偏差、OCR 不符）进人工复核，
 * 值班员接受时以 override 跳过。
 */
function evaluate(op: GateOp, normalizedMs: number, override: boolean): { decision: SyncDecision; reason: string } {
  const appointment = findAppointment(op.appointmentId);
  if (!appointment) return { decision: 'conflict', reason: '预约不存在，可能已在离线期间被删除' };
  if (appointment.status === 'cancelled') return { decision: 'conflict', reason: '预约已在离线期间被取消，拒绝执行该步骤' };
  const container = findContainer(op.containerId);
  if (!container) return { decision: 'conflict', reason: `箱号 ${op.containerId} 不存在` };
  if (appointment.containerId !== op.containerId) return { decision: 'conflict', reason: `预约关联箱号为 ${appointment.containerId}，与上传箱号 ${op.containerId} 不一致` };
  if (!override && normalizedMs > Date.now() + FUTURE_TOLERANCE_MS) return { decision: 'review', reason: `操作时间 ${new Date(normalizedMs).toLocaleString('zh-CN')} 晚于服务端时间，疑似闸口终端时钟异常` };

  switch (op.step) {
    case 'check-in': {
      if (hasStep(appointment, 'check-in')) {
        const by = checkInDevice.get(appointment.id);
        return { decision: 'accepted', reason: `该预约已完成签到${by ? `（设备 ${by}）` : ''}，本次重复提交按幂等忽略` };
      }
      const other = appointments.find(item => item.containerId === op.containerId && item.id !== appointment.id && item.status === 'checked-in');
      if (other) return { decision: 'conflict', reason: `箱 ${op.containerId} 已通过 ${other.id} 在${other.lane} 闸口签到，禁止同一箱在两个闸口重复签到` };
      if (container.status === 'at-gate' && container.appointmentId && container.appointmentId !== appointment.id) return { decision: 'conflict', reason: `箱 ${op.containerId} 已凭 ${container.appointmentId} 签到在场，禁止重复签到` };
      if (!override) {
        const startMs = new Date(appointment.windowStart).getTime();
        const endMs = new Date(appointment.windowEnd).getTime();
        if (normalizedMs < startMs - WINDOW_EARLY_GRACE_MS || normalizedMs > endMs + WINDOW_LATE_GRACE_MS) return { decision: 'review', reason: `签到时间超出预约窗口 ${appointment.windowStart.slice(11, 16)}–${appointment.windowEnd.slice(11, 16)}（含离线容差），需值班员确认` };
      }
      applyOp(op, appointment, container);
      return { decision: 'accepted', reason: `签到成功，${appointment.lane} 闸口放行` };
    }
    case 'ocr': {
      if (hasStep(appointment, 'complete')) return { decision: 'accepted', reason: '预约已完成，后续识别结果按幂等忽略' };
      if (hasStep(appointment, 'ocr')) return { decision: 'accepted', reason: 'OCR 结果已存在，重复提交按幂等忽略' };
      const ocrNo = op.payload?.ocrContainerNo?.trim().toUpperCase();
      if (!override && ocrNo && ocrNo !== appointment.containerId) return { decision: 'review', reason: `OCR 识别箱号 ${ocrNo} 与预约箱号 ${appointment.containerId} 不一致` };
      applyOp(op, appointment, container);
      return { decision: 'accepted', reason: `OCR 识别完成（车牌 ${op.payload?.ocrPlate ?? '未上传'}）` };
    }
    case 'weigh': {
      if (hasStep(appointment, 'complete')) return { decision: 'accepted', reason: '预约已完成，后续称重按幂等忽略' };
      const measured = op.payload?.weightT;
      if (hasStep(appointment, 'weigh')) {
        const recorded = checkEvidence.get(appointment.id)?.weigh;
        if (!override && typeof measured === 'number' && recorded && Math.abs(measured - recorded.weightT) > WEIGHT_TOLERANCE_T) return { decision: 'review', reason: `两次称重不一致（已采信 ${recorded.weightT}t，本次 ${measured}t），需人工复核` };
        return { decision: 'accepted', reason: '称重结果已存在，重复提交按幂等忽略' };
      }
      if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) return { decision: 'conflict', reason: '称重数据缺失或非法，无法采信' };
      const diff = Math.abs(measured - container.weightT);
      if (!override && diff > WEIGHT_TOLERANCE_T) return { decision: 'review', reason: `称重 ${measured}t 与台账 ${container.weightT}t 偏差 ${diff.toFixed(1)}t，超过 ${WEIGHT_TOLERANCE_T}t 阈值` };
      applyOp(op, appointment, container);
      return { decision: 'accepted', reason: `称重 ${measured}t 已采信` };
    }
    case 'seal': {
      if (hasStep(appointment, 'complete')) return { decision: 'accepted', reason: '预约已完成，后续封志检查按幂等忽略' };
      if (hasStep(appointment, 'seal')) {
        const recorded = checkEvidence.get(appointment.id)?.seal;
        if (!override && op.payload?.sealNo && recorded?.sealNo && op.payload.sealNo !== recorded.sealNo) return { decision: 'review', reason: `封志号不一致（已记录 ${recorded.sealNo}，本次 ${op.payload.sealNo}），需人工复核` };
        return { decision: 'accepted', reason: '封志检查结果已存在，重复提交按幂等忽略' };
      }
      if (!op.payload?.sealNo) return { decision: 'conflict', reason: '缺少封志号，无法完成封志检查' };
      applyOp(op, appointment, container);
      return { decision: 'accepted', reason: `封志 ${op.payload.sealNo} 检查通过` };
    }
    case 'complete': {
      if (hasStep(appointment, 'complete')) return { decision: 'accepted', reason: '预约已完成，重复提交按幂等忽略' };
      applyOp(op, appointment, container);
      return { decision: 'accepted', reason: `闸口作业完成，箱状态更新为 ${container.status}` };
    }
  }
}

/** 前序缺失的操作挂起到预约维度队列，等待补齐后自动生效。 */
function park(op: GateOp, skewMs: number, normalizedAt: string, missing: GateStepKind): SyncResult {
  const list = parkedByAppointment.get(op.appointmentId) ?? [];
  if (!list.some(item => item.op.idempotencyKey === op.idempotencyKey)) {
    list.push({ op, skewMs });
    parkedByAppointment.set(op.appointmentId, list);
  }
  return decide(op, skewMs, 'review', `前序步骤「${STEP_LABEL[missing]}」尚未同步，操作已挂起，补齐后自动生效`, normalizedAt);
}

/** 前序步骤落地后，重放该预约下所有挂起操作。 */
function drainAppointment(appointmentId: string) {
  const list = parkedByAppointment.get(appointmentId);
  if (!list?.length) return;
  const stillParked: { op: GateOp; skewMs: number }[] = [];
  for (const item of list) {
    if (missingPrerequisite(item.op)) {
      stillParked.push(item);
      continue;
    }
    const normalizedMs = new Date(item.op.occurredAt).getTime() + item.skewMs;
    const normalizedAt = new Date(normalizedMs).toISOString();
    const { decision, reason } = evaluate(item.op, normalizedMs, false);
    const entry = recordJournal(item.op, decision, reason, item.skewMs, normalizedAt);
    reviseResult(item.op.idempotencyKey, decision, reason, entry.serverSeq);
    const review = reviewByKey.get(item.op.idempotencyKey);
    if (review) {
      review.reason = reason;
      review.resolvedAt = new Date().toISOString();
      review.status = decision === 'accepted' ? 'auto-applied' : decision === 'conflict' ? 'rejected' : 'pending';
      review.resolutionNote = decision === 'accepted' ? '前序步骤补齐，自动生效' : decision === 'conflict' ? '补齐前序后评估为冲突' : undefined;
    }
    const appointment = findAppointment(item.op.appointmentId);
    if (appointment && decision !== 'accepted') appointment.exception = `${decision === 'conflict' ? '离线冲突' : '离线复核'}：${reason}`;
    audit(`离线同步·${item.op.deviceId}`, item.op, decision, reason);
  }
  parkedByAppointment.set(appointmentId, stillParked);
  if (stillParked.length < list.length) drainAppointment(appointmentId); // 新落地的步骤可能继续解锁其它挂起单
}

/** 处理单个操作；allowPark=false 时前序缺失返回 null（批次内延迟到下一轮）。 */
function processOp(op: GateOp, skewMs: number, allowPark: boolean): SyncResult | null {
  const existing = resultsByKey.get(op.idempotencyKey);
  if (existing) return { ...existing, replay: true };
  const occurredMs = new Date(op.occurredAt).getTime();
  if (!Number.isFinite(occurredMs)) return decide(op, skewMs, 'conflict', '操作时间格式非法，无法采信', op.occurredAt);
  const normalizedMs = occurredMs + skewMs;
  const normalizedAt = new Date(normalizedMs).toISOString();
  const missing = missingPrerequisite(op);
  if (missing) return allowPark ? park(op, skewMs, normalizedAt, missing) : null;
  const { decision, reason } = evaluate(op, normalizedMs, false);
  const result = decide(op, skewMs, decision, reason, normalizedAt);
  if (decision === 'accepted') drainAppointment(op.appointmentId);
  return result;
}

function normalizeOp(raw: GateOp, index: number): GateOp | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.idempotencyKey !== 'string' || !raw.idempotencyKey) return null;
  if (typeof raw.appointmentId !== 'string' || typeof raw.containerId !== 'string') return null;
  if (!STEP_KINDS.includes(raw.step)) return null;
  return {
    idempotencyKey: raw.idempotencyKey,
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : 'unknown',
    sequence: typeof raw.sequence === 'number' && Number.isFinite(raw.sequence) ? raw.sequence : index,
    appointmentId: raw.appointmentId,
    containerId: raw.containerId,
    step: raw.step,
    occurredAt: typeof raw.occurredAt === 'string' ? raw.occurredAt : new Date().toISOString(),
    ...(raw.payload ? { payload: raw.payload } : {})
  };
}

/**
 * 同步入口：批次内先按（设备，序号）排序，再多轮尝试——前序在同一批次后面时
 * 第二轮即可落地；跨批次/跨设备缺失的进入挂起队列。
 */
export function syncBatch(batch: SyncBatch): { serverTime: string; clockSkewMs: number; results: SyncResult[] } {
  if (!batch || typeof batch.deviceId !== 'string' || !batch.deviceId) throw new Error('缺少设备标识 deviceId');
  if (!Array.isArray(batch.ops)) throw new Error('缺少操作列表 ops');
  const sentMs = batch.sentAt ? new Date(batch.sentAt).getTime() : NaN;
  const skewMs = Number.isFinite(sentMs) ? Date.now() - sentMs : 0;
  const ops = batch.ops.map(normalizeOp).filter((op): op is GateOp => op !== null).sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.sequence - b.sequence);
  const results: SyncResult[] = [];
  let current = ops;
  while (current.length) {
    const deferred: GateOp[] = [];
    for (const op of current) {
      const result = processOp(op, skewMs, false);
      if (result) results.push(result);
      else deferred.push(op);
    }
    if (!deferred.length) break;
    if (deferred.length === current.length) { // 本轮无进展：前序不在批次内，挂起等待
      for (const op of deferred) {
        const result = processOp(op, skewMs, true);
        if (result) results.push(result);
      }
      break;
    }
    current = deferred;
  }
  return { serverTime: new Date().toISOString(), clockSkewMs: skewMs, results };
}

/** 客户端断线重连后按幂等键对账（处理「已发出但未收到响应」的不确定状态）。 */
export function getSyncResults(keys: string[]): SyncResult[] {
  return keys.map(key => resultsByKey.get(key)).filter((result): result is SyncResult => result !== undefined);
}

export function syncJournal(): JournalEntry[] {
  return [...journal];
}

export function reviewQueue(): ReviewItem[] {
  return [...reviewByKey.values()].filter(item => item.status === 'pending');
}

/** 值班员处理复核项：接受则以 override 落地（硬冲突仍不可覆盖），拒绝则终态为冲突。 */
export function resolveReview(key: string, action: 'accept' | 'reject', note: string, actor = '闸口值班员'): { item: ReviewItem; result?: SyncResult } | undefined {
  const item = reviewByKey.get(key);
  if (!item) return undefined;
  if (item.status !== 'pending') throw new Error('该复核项已处理，请刷新后查看最新状态');
  const op = item.op;
  const appointment = findAppointment(op.appointmentId);
  const parked = parkedByAppointment.get(op.appointmentId);
  if (parked) parkedByAppointment.set(op.appointmentId, parked.filter(entry => entry.op.idempotencyKey !== key));
  const resolutionNote = note.trim() || (action === 'accept' ? '值班员现场确认' : '值班员现场拒绝');

  if (action === 'accept') {
    if (!appointment) throw new Error('预约已不存在，无法接受，请拒绝该条');
    if (appointment.status === 'cancelled') throw new Error('预约已取消，无法接受，请拒绝该条');
    const container = findContainer(op.containerId);
    if (!container) throw new Error('箱号已不存在，无法接受，请拒绝该条');
    if (op.step === 'check-in' && !hasStep(appointment, 'check-in')) {
      const other = appointments.find(entry => entry.containerId === op.containerId && entry.id !== appointment.id && entry.status === 'checked-in');
      if (other) throw new Error(`箱 ${op.containerId} 已凭 ${other.id} 签到，复核不能覆盖双闸口签到限制`);
    }
    const reason = `人工复核通过：${resolutionNote}`;
    applyOp(op, appointment, container);
    const entry = recordJournal(op, 'accepted', reason, 0, op.occurredAt);
    reviseResult(key, 'accepted', reason, entry.serverSeq);
    item.status = 'accepted';
    if (appointment.exception?.startsWith('离线复核')) appointment.exception = undefined;
    drainAppointment(op.appointmentId);
  } else {
    const reason = `人工复核拒绝：${resolutionNote}`;
    const entry = recordJournal(op, 'conflict', reason, 0, op.occurredAt);
    reviseResult(key, 'conflict', reason, entry.serverSeq);
    item.status = 'rejected';
    if (appointment) appointment.exception = `离线冲突：${reason}`;
  }
  item.resolvedAt = new Date().toISOString();
  item.resolutionNote = resolutionNote;
  auditEvents.unshift({ id: `AUD-SYNC-${Date.now()}-${serverSeq}`, actor, action: 'GATE_SYNC_REVIEW', entity: 'appointment', entityId: op.appointmentId, at: new Date().toISOString(), details: `${STEP_LABEL[op.step]} 复核${action === 'accept' ? '接受' : '拒绝'}：${resolutionNote}（箱 ${op.containerId}，幂等键 ${key}）` });
  return { item, result: resultsByKey.get(key) };
}
