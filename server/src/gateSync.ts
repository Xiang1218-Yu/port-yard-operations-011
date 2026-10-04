import { appointments, auditEvents, containers } from './domain.js';

/**
 * 闸口离线作业同步模块
 *
 * 浏览器（闸口工位）在断网期间可以暂存 OCR、称重、封志检查、签到四类步骤，
 * 重新联网后按设备与操作序号批量上传。本模块负责：
 *
 * 1. 幂等：每个步骤带 idempotencyKey，重复/部分成功重试返回同一份裁决；
 * 2. 互斥：同一箱只能被一台闸口签到，另一台闸口得到 conflict；
 * 3. 时钟：以服务端时间为准，检测设备时钟偏差，时间敏感决策偏差过大转人工；
 * 4. 乱序：批次内按设备 seq 排序处理，迟到的测量结果可以补齐并触发自动对账；
 * 5. 取消：同步期间预约被取消/删除，相关步骤全部 conflict，不做任何状态翻转；
 * 6. 审计：每一步接受/拒绝/转人工都写审计，携带原因码与说明。
 */

export type GateLane = 'north' | 'south' | 'rail';
export type GateStepKind = 'ocr' | 'weight' | 'seal' | 'check-in';
export type GateStepStatus = 'accepted' | 'conflict' | 'review';

export interface GateDevice {
  id: string;
  name: string;
  lane: GateLane;
  kind: 'inbound' | 'outbound' | 'hybrid';
  lastSeenAt?: string;
}

export interface OcrPayload { kind: 'ocr'; containerId: string; confidence: number; isoType?: string }
export interface WeightPayload { kind: 'weight'; weightT: number }
export interface SealPayload { kind: 'seal'; sealNo: string; intact: boolean }
export interface CheckinPayload { kind: 'check-in'; truckNo?: string; driver?: string }
export type GateStepPayload = OcrPayload | WeightPayload | SealPayload | CheckinPayload;

export interface GateStepEnvelope {
  idempotencyKey: string;
  deviceId: string;
  appointmentId: string;
  /** 设备侧单调序号，同一设备内代表操作先后 */
  seq: number;
  /** 设备本地时钟（ISO），仅用于偏差检测，业务时间一律以服务端为准 */
  clientAt: string;
  /** 物理作业实际发生时刻（设备时钟），用于审计还原现场 */
  recordedAt?: string;
  kind: GateStepKind;
  payload: GateStepPayload;
}

export interface GateReason {
  code: string;
  message: string;
  /** info 只做解释，不改变裁决；warning 会把该步推向 review */
  severity: 'info' | 'warning';
}

export interface GateSyncResponseItem {
  idempotencyKey: string;
  deviceId: string;
  appointmentId: string;
  seq: number;
  kind: GateStepKind;
  status: GateStepStatus;
  /** 该步骤的结论当前是否已写入业务状态（被取代/未采纳/挂起/幂等重放时为 false） */
  applied: boolean;
  /** 本批次是否只是幂等重放（键已存在，没有重新执行副作用） */
  replayed: boolean;
  reasons: GateReason[];
  serverAt: string;
  /** 设备时钟相对服务端的偏差（毫秒，正数=设备时钟快） */
  skewMs: number;
  appointmentStatus?: string;
  containerStatus?: string;
  /** 若该步骤触发了待补条件签到的自动对账，这里给出被补齐的签到键 */
  reconciledKey?: string;
}

export interface GateSyncBatchResponse {
  serverAt: string;
  items: GateSyncResponseItem[];
}

interface StoredStep {
  key: string;
  deviceId: string;
  appointmentId: string;
  seq: number;
  kind: GateStepKind;
  clientAt: string;
  recordedAt?: string;
  receivedAt: string;
  skewMs: number;
  payload: GateStepPayload;
  status: GateStepStatus;
  applied: boolean;
  reasons: GateReason[];
  /** 被同机重采的新键取代后，旧读数保留审计但不再阻挡签到 */
  supersededBy?: string;
}

// 容忍的设备时钟偏差：3 分钟，超过则时间敏感步骤（签到/窗口判定）转人工
export const CLOCK_SKEW_LIMIT_MS = 3 * 60 * 1000;
// 预约窗口宽限：早到/晚出 30 分钟内仍可签到，之外转人工
export const WINDOW_GRACE_MS = 30 * 60 * 1000;
// OCR 置信度阈值
export const OCR_MIN_CONFIDENCE = 0.75;
// 称重与台账重量允许偏差（取 0.8t 与 5% 中较大者）
export const WEIGHT_TOLERANCE_ABS = 0.8;
export const WEIGHT_TOLERANCE_PCT = 0.05;

const devices: GateDevice[] = [
  { id: 'GATE-N1', name: '北闸口 1 号车道', lane: 'north', kind: 'hybrid' },
  { id: 'GATE-N2', name: '北闸口 2 号车道', lane: 'north', kind: 'outbound' },
  { id: 'GATE-S1', name: '南闸口 1 号车道', lane: 'south', kind: 'inbound' },
  { id: 'GATE-R1', name: '铁路闸口查验道', lane: 'rail', kind: 'hybrid' },
];

const steps = new Map<string, StoredStep>();
const deviceMaxSeq = new Map<string, number>();

export function listDevices(): GateDevice[] {
  return devices.map(device => ({ ...device }));
}

export function getClock() {
  return { serverAt: new Date().toISOString() };
}

function reason(code: string, message: string, severity: 'info' | 'warning' = 'warning'): GateReason {
  return { code, message, severity };
}

function liveSteps(appointmentId: string): StoredStep[] {
  return [...steps.values()].filter(step => step.appointmentId === appointmentId && !step.supersededBy);
}

function appliedCheckin(appointmentId: string): StoredStep | undefined {
  return liveSteps(appointmentId).find(step => step.kind === 'check-in' && step.applied);
}

/** 跨预约查找同一箱的已接受签到——防止同一箱在另一台闸口/另一张预约签到 */
function findCheckinForContainer(containerId: string, excludeAppointmentId?: string): StoredStep | undefined {
  for (const step of steps.values()) {
    if (step.kind !== 'check-in' || !step.applied) continue;
    if (step.appointmentId === excludeAppointmentId) continue;
    const app = appointments.find(item => item.id === step.appointmentId);
    if (app?.containerId === containerId) return step;
  }
  return undefined;
}

function appliedMeasurements(appointmentId: string) {
  const list = liveSteps(appointmentId);
  return {
    ocr: list.find(step => step.kind === 'ocr' && step.applied),
    weight: list.find(step => step.kind === 'weight' && step.applied),
    seal: list.find(step => step.kind === 'seal' && step.applied),
    /** 仍然生效但被挂起的测量（数据冲突/异常），会阻止签到自动放行；被取代的旧读数不计 */
    pending: list.filter(step => step.status === 'review' && step.kind !== 'check-in'),
  };
}

let auditSerial = 0;
function audit(step: StoredStep, action: string, extra?: Record<string, unknown>) {
  auditSerial += 1;
  const device = devices.find(item => item.id === step.deviceId);
  auditEvents.unshift({
    id: `AUD-GATE-${Date.now()}-${auditSerial}`,
    actor: `闸口工位 ${device?.name ?? step.deviceId}`,
    action,
    entity: 'appointment',
    entityId: step.appointmentId,
    at: new Date().toISOString(),
    details: JSON.stringify({
      key: step.key,
      deviceId: step.deviceId,
      kind: step.kind,
      seq: step.seq,
      status: step.status,
      applied: step.applied,
      skewMs: step.skewMs,
      clientAt: step.clientAt,
      recordedAt: step.recordedAt,
      supersededBy: step.supersededBy,
      reasons: step.reasons.map(item => item.code),
      ...extra,
    }),
  });
}

function payloadFor(kind: GateStepKind, raw: unknown): { payload?: GateStepPayload; error?: string } {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (kind === 'ocr') {
    const containerId = String(data.containerId ?? '').trim().toUpperCase();
    const confidence = Number(data.confidence);
    if (!containerId) return { error: 'OCR 结果缺少箱号' };
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { error: 'OCR 置信度必须在 0–1 之间' };
    return { payload: { kind, containerId, confidence, isoType: data.isoType ? String(data.isoType) : undefined } };
  }
  if (kind === 'weight') {
    const weightT = Number(data.weightT);
    if (!Number.isFinite(weightT) || weightT <= 0) return { error: '称重结果必须为正数（吨）' };
    return { payload: { kind, weightT: Math.round(weightT * 1000) / 1000 } };
  }
  if (kind === 'seal') {
    const intact = Boolean(data.intact);
    const sealNo = String(data.sealNo ?? '').trim();
    return { payload: { kind, sealNo, intact } };
  }
  return { payload: { kind: 'check-in', truckNo: data.truckNo ? String(data.truckNo) : undefined, driver: data.driver ? String(data.driver) : undefined } };
}

interface Decision {
  status: GateStepStatus;
  applied: boolean;
  reasons: GateReason[];
  /** 测量步骤采纳时，同时标记被取代的旧读数键 */
  supersedesKey?: string;
}

const makeAccepted = (reasons: GateReason[] = []): Decision => ({ status: 'accepted', applied: reasons.every(r => r.severity !== 'warning'), reasons });

function evaluateMeasurementSelf(
  payload: Exclude<GateStepPayload, CheckinPayload>,
  container: (typeof containers)[number] | undefined,
  reasons: GateReason[],
): Decision {
  if (payload.kind === 'ocr') {
    if (container && payload.containerId !== container.id) {
      return { status: 'review', applied: false, reasons: [...reasons, reason('ocr-container-mismatch', `OCR 箱号 ${payload.containerId} 与预约箱号 ${container.id} 不符，车辆可能走错车道`)] };
    }
    if (payload.confidence < OCR_MIN_CONFIDENCE) {
      return { status: 'review', applied: false, reasons: [...reasons, reason('ocr-low-confidence', `OCR 置信度 ${(payload.confidence * 100).toFixed(1)}% 低于 ${OCR_MIN_CONFIDENCE * 100}%，需人工确认箱号`)] };
    }
    return makeAccepted(reasons);
  }

  if (payload.kind === 'weight') {
    if (container) {
      const tolerance = Math.max(WEIGHT_TOLERANCE_ABS, container.weightT * WEIGHT_TOLERANCE_PCT);
      if (Math.abs(payload.weightT - container.weightT) > tolerance) {
        return { status: 'review', applied: false, reasons: [...reasons, reason('weight-discrepancy', `称重 ${payload.weightT}t 与台账 ${container.weightT}t 偏差超过 ${tolerance.toFixed(1)}t，需人工核重`)] };
      }
    }
    return makeAccepted(reasons);
  }

  if (!payload.intact) {
    return { status: 'review', applied: false, reasons: [...reasons, reason('seal-broken', payload.sealNo ? `封志 ${payload.sealNo} 破损/断裂，按异常流程处理` : '封志破损/断裂且无封志号，按异常流程处理')] };
  }
  if (!payload.sealNo) {
    return { status: 'review', applied: false, reasons: [...reasons, reason('seal-number-missing', '封志完好但未采集到封志号，需补录后放行')] };
  }
  return makeAccepted(reasons);
}

function valuesEqual(a: GateStepPayload, b: GateStepPayload) {
  if (a.kind === 'ocr' && b.kind === 'ocr') return a.containerId === b.containerId;
  if (a.kind === 'weight' && b.kind === 'weight') return Math.abs(a.weightT - b.weightT) <= WEIGHT_TOLERANCE_ABS;
  if (a.kind === 'seal' && b.kind === 'seal') return a.intact === b.intact && (!a.sealNo || a.sealNo === b.sealNo);
  return false;
}

function decideMeasurement(
  env: GateStepEnvelope,
  payload: Exclude<GateStepPayload, CheckinPayload>,
  app: (typeof appointments)[number],
  container: (typeof containers)[number] | undefined,
  skewMs: number,
  outOfOrder: boolean,
): Decision {
  const reasons: GateReason[] = [];
  if (Math.abs(skewMs) > CLOCK_SKEW_LIMIT_MS) {
    // 物理读数本身不依赖时钟，记录偏差但不挂起；时间敏感的签到步骤才会被挡
    reasons.push(reason('clock-skew-noted', `设备时钟偏差 ${Math.round(skewMs / 1000)} 秒，已按服务端时间记录`, 'info'));
  }
  if (outOfOrder) reasons.push(reason('out-of-order-seq', '该步骤序号晚于设备已上传序号，按迟到数据合并处理', 'info'));

  const label = payload.kind === 'ocr' ? 'OCR' : payload.kind === 'weight' ? '称重' : '封志';
  const prior = liveSteps(app.id).filter(step => step.kind === env.kind);

  // 另一台闸口已有待人工处理的读数：不能让本台新读数替它做主
  const otherDevicePending = prior.find(step => step.deviceId !== env.deviceId && step.status === 'review');
  if (otherDevicePending) {
    return { status: 'review', applied: false, reasons: [...reasons, reason('cross-gate-pending-reading', `另一台闸口已有一条待复核的${label}读数，需值班员判定以哪台设备为准`)] };
  }

  const acceptedPrior = prior.filter(step => step.status === 'accepted');
  if (acceptedPrior.length > 0) {
    if (acceptedPrior.some(step => !valuesEqual(step.payload, payload))) {
      const fromOther = acceptedPrior.some(step => step.deviceId !== env.deviceId);
      const code = payload.kind === 'ocr' ? 'ocr-conflicting-readings' : payload.kind === 'weight' ? 'weight-conflicting-readings' : 'seal-conflicting-readings';
      const message = payload.kind === 'weight'
        ? `两次称重结果相差超过 ${WEIGHT_TOLERANCE_ABS} 吨，需人工核磅`
        : payload.kind === 'ocr'
          ? `${fromOther ? '不同闸口' : '同机两次'} OCR 识别出的箱号不一致，需人工核对`
          : '两次封志检查结论不一致，需现场人工复核封志';
      return { status: 'review', applied: false, reasons: [...reasons, reason(code, message)] };
    }
    const fromOther = acceptedPrior.some(step => step.deviceId !== env.deviceId);
    reasons.push(reason('duplicate-merged', `${fromOther ? '另一台闸口' : '同机'}已上传一致的${label}结果，合并为复核证据，未重复写入`, 'info'));
    return makeAccepted(reasons);
  }

  const ownPending = prior.find(step => step.deviceId === env.deviceId && step.status === 'review');
  const decision = evaluateMeasurementSelf(payload, container, reasons);
  if (ownPending && decision.status === 'accepted') {
    // 同一台闸口重采（破损封志重新加封、重新过磅等）：新读数取代旧的挂起读数，旧读数仅保留审计
    decision.reasons.push(reason('supersedes-prior-reading', '本车道此前读数待复核，本次重采取代旧读数（旧读数保留审计）', 'info'));
    decision.supersedesKey = ownPending.key;
  }
  return decision;
}

/** 签到决策：纯函数，首次处理与批次末对账共用 */
function decideCheckin(
  env: GateStepEnvelope,
  app: (typeof appointments)[number],
  container: (typeof containers)[number] | undefined,
  skewMs: number,
  serverAt: Date,
  outOfOrder: boolean,
): Decision {
  const reasons: GateReason[] = [];

  // 1) 互斥：同一箱已在其它闸口/其它预约签到
  const elsewhere = findCheckinForContainer(app.containerId, app.id);
  if (elsewhere) {
    const owner = devices.find(item => item.id === elsewhere.deviceId);
    return { status: 'conflict', applied: false, reasons: [reason('already-checked-in-elsewhere', `箱 ${app.containerId} 已在 ${owner?.name ?? elsewhere.deviceId}（预约 ${elsewhere.appointmentId}）签到，禁止重复进场`)] };
  }
  const mine = appliedCheckin(app.id);
  if (mine && mine.key !== env.idempotencyKey) {
    if (mine.deviceId === env.deviceId) return { status: 'conflict', applied: false, reasons: [reason('duplicate-checkin-same-gate', '本车道已完成该预约签到，请勿重复抬杆')] };
    const owner = devices.find(item => item.id === mine.deviceId);
    return { status: 'conflict', applied: false, reasons: [reason('already-checked-in-other-gate', `该预约已在 ${owner?.name ?? mine.deviceId} 签到，当前闸口拒绝重复签到`)] };
  }

  // 2) 已有挂起的签到（缺前置检查/待人工）
  const pendingCheckin = liveSteps(app.id).find(step => step.kind === 'check-in' && step.status === 'review');
  if (pendingCheckin && pendingCheckin.key !== env.idempotencyKey) {
    if (pendingCheckin.deviceId !== env.deviceId) {
      const owner = devices.find(item => item.id === pendingCheckin.deviceId);
      return { status: 'conflict', applied: false, reasons: [reason('checkin-pending-other-gate', `另一台闸口（${owner?.name ?? pendingCheckin.deviceId}）已发起签到并等待复核，请到该车道处理或联系值班员`)] };
    }
    reasons.push(reason('checkin-pending', '本车道已有一笔待补齐/待复核签到，随检查结果补齐后自动对账', 'info'));
  }

  if (outOfOrder) reasons.push(reason('out-of-order-seq', '签到序号乱序到达，已按设备序号重放', 'info'));

  // 3) 前置检查结果
  const measurements = appliedMeasurements(app.id);
  if (!measurements.ocr) reasons.push(reason('missing-ocr', '缺少已接受的 OCR 箱号识别结果'));
  if (!measurements.weight) {
    const weightPending = measurements.pending.find(step => step.kind === 'weight');
    reasons.push(weightPending ? reason('weight-blocked', '称重结果存在异议（见称重步骤的复核原因），暂不放行') : reason('missing-weight', '缺少已接受的称重结果'));
  }
  if (!measurements.seal) {
    const sealPending = measurements.pending.find(step => step.kind === 'seal');
    reasons.push(sealPending ? reason('seal-blocked', '封志检查未通过（见封志步骤的复核原因），暂不放行') : reason('missing-seal', '缺少已接受的封志检查结果'));
  }
  for (const pending of measurements.pending) {
    if (pending.kind === 'ocr') reasons.push(reason('ocr-blocked', 'OCR 结果待人工确认（见 OCR 步骤的复核原因）'));
  }

  // 4) 业务状态
  if (container && container.customs !== 'released') {
    reasons.push(reason(`customs-${container.customs}`, `海关状态为 ${container.customs === 'inspection' ? '查验中' : '扣留'}，须海关放行后由值班员确认`));
  }

  // 5) 时钟与窗口（时间敏感，只信服务端时钟）
  if (Math.abs(skewMs) > CLOCK_SKEW_LIMIT_MS) {
    reasons.push(reason('clock-skew', `设备时钟偏差 ${Math.round(skewMs / 1000)} 秒，超过 ${CLOCK_SKEW_LIMIT_MS / 60000} 分钟阈值，签到时间不可直接采信`));
  }
  const startedAt = new Date(app.windowStart).getTime() - WINDOW_GRACE_MS;
  const endedAt = new Date(app.windowEnd).getTime() + WINDOW_GRACE_MS;
  if (serverAt.getTime() < startedAt || serverAt.getTime() > endedAt) {
    reasons.push(reason('outside-appointment-window', `服务端时间 ${serverAt.toLocaleTimeString()} 不在预约窗口（含 ${WINDOW_GRACE_MS / 60000} 分钟宽限）内，需值班员确认时隙`));
  }

  const blocking = reasons.filter(item => item.severity === 'warning');
  if (blocking.length > 0) return { status: 'review', applied: false, reasons };
  return makeAccepted(reasons);
}

function applyMeasurementSideEffects(appId: string, kind: GateStepKind, payload: GateStepPayload) {
  const app = appointments.find(item => item.id === appId);
  if (!app) return;
  if (kind === 'weight') app.weightVerified = true;
  if (kind === 'seal') app.sealVerified = true;
  const container = containers.find(item => item.id === app.containerId);
  if (container && kind === 'ocr') container.lastEvent = `闸口 OCR 已识别箱号 ${new Date().toLocaleString()}`;
  if (container && kind === 'weight') container.lastEvent = `闸口称重 ${(payload as WeightPayload).weightT}t ${new Date().toLocaleString()}`;
  if (container && kind === 'seal') container.lastEvent = `封志检查通过 ${new Date().toLocaleString()}`;
}

function applyCheckin(appId: string, device: GateDevice | undefined) {
  const app = appointments.find(item => item.id === appId);
  if (!app) return;
  app.status = 'checked-in';
  app.exception = undefined;
  const container = containers.find(item => item.id === app.containerId);
  if (container) {
    container.status = 'at-gate';
    container.appointmentId = app.id;
    container.lastEvent = `${device?.name ?? '闸口'}签到放行 ${new Date().toLocaleString()}`;
  }
}

// 记录当前 sync 调用真正新建的键，用于区分响应项是新处理还是幂等重放
const wasCreatedThisBatch = new Set<string>();

export function syncGateSteps(batch: GateStepEnvelope[]): GateSyncBatchResponse {
  const serverNow = new Date();
  const touchedAppointments = new Set<string>();
  const reconciledByItem = new Map<string, string>();
  wasCreatedThisBatch.clear();

  // 按设备分组，组内按 seq 升序，模拟各闸口真实操作顺序
  const groups = new Map<string, GateStepEnvelope[]>();
  for (const env of batch) {
    const list = groups.get(env.deviceId) ?? [];
    list.push(env);
    groups.set(env.deviceId, list);
  }

  for (const [deviceId, envs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const device = devices.find(item => item.id === deviceId);
    if (device) device.lastSeenAt = serverNow.toISOString();
    envs.sort((a, b) => a.seq - b.seq || a.idempotencyKey.localeCompare(b.idempotencyKey));

    for (const env of envs) {
      // 幂等：完全相同的键不重新执行，只登记待返回；裁决可能被批次末对账升级
      if (steps.has(env.idempotencyKey)) {
        const known = steps.get(env.idempotencyKey)!;
        touchedAppointments.add(known.appointmentId);
        continue;
      }

      const clientTime = Date.parse(env.clientAt);
      const skewMs = Number.isFinite(clientTime) ? clientTime - serverNow.getTime() : 0;
      const priorMaxSeq = deviceMaxSeq.get(deviceId) ?? -1;
      const outOfOrder = env.seq < priorMaxSeq;
      deviceMaxSeq.set(deviceId, Math.max(priorMaxSeq, env.seq));

      const stored: StoredStep = {
        key: env.idempotencyKey,
        deviceId,
        appointmentId: env.appointmentId,
        seq: env.seq,
        kind: env.kind,
        clientAt: env.clientAt,
        recordedAt: env.recordedAt,
        receivedAt: serverNow.toISOString(),
        skewMs,
        payload: { kind: 'check-in' } as CheckinPayload,
        status: 'conflict',
        applied: false,
        reasons: [],
      };

      const app = appointments.find(item => item.id === env.appointmentId);
      const fail = (code: string, message: string) => {
        stored.reasons = [reason(code, message)];
        stored.status = 'conflict';
        steps.set(stored.key, stored);
        wasCreatedThisBatch.add(stored.key);
        audit(stored, 'GATE_SYNC_STEP');
        touchedAppointments.add(env.appointmentId);
      };

      if (!device) { fail('unknown-device', `未登记的闸口设备 ${deviceId}，请联系中控登记设备后重试`); continue; }
      const built = payloadFor(env.kind, env.payload);
      if (built.error || !built.payload) { fail('invalid-payload', built.error ?? '步骤数据格式不正确'); continue; }
      stored.payload = built.payload;
      if (!Number.isFinite(clientTime)) { fail('invalid-client-time', '设备时间戳无法解析，无法进行时钟校验'); continue; }
      if (!app) { fail('appointment-not-found', `预约 ${env.appointmentId} 不存在，可能已被删除`); continue; }
      if (app.status === 'cancelled') { fail('appointment-cancelled', `预约 ${env.appointmentId} 已在同步前/同步期间取消，车辆步骤不予采纳`); continue; }
      if (app.status === 'completed' && env.kind === 'check-in') { fail('appointment-completed', '预约已完成离场，不能重复签到'); continue; }

      const container = containers.find(item => item.id === app.containerId);
      if (!container) { fail('container-not-found', `预约对应的箱号 ${app.containerId} 台账不存在`); continue; }

      const decision = env.kind === 'check-in'
        ? decideCheckin(env, app, container, skewMs, serverNow, outOfOrder)
        : decideMeasurement(env, built.payload as Exclude<GateStepPayload, CheckinPayload>, app, container, skewMs, outOfOrder);

      stored.status = decision.status;
      stored.applied = decision.applied && decision.status === 'accepted';
      stored.reasons = decision.reasons;

      if (decision.supersedesKey) {
        const old = steps.get(decision.supersedesKey);
        if (old) {
          old.supersededBy = stored.key;
          old.applied = false;
          old.reasons = [...old.reasons, reason('superseded-by-retry', `被本车道序号 ${env.seq} 的重采结果取代`, 'info')];
          audit(old, 'GATE_READING_SUPERSEDED');
        }
      }

      if (stored.applied) {
        if (env.kind === 'check-in') applyCheckin(app.id, device);
        else applyMeasurementSideEffects(app.id, env.kind, built.payload);
      } else if (env.kind === 'check-in' && decision.status === 'review') {
        // 签到挂起：预约进入异常视图等待补齐/人工，箱状态保持不变（不翻转）
        app.status = 'exception';
        const summary = decision.reasons.filter(item => item.severity === 'warning').map(item => item.message).join('；');
        app.exception = `离线签到待处理：${summary}`;
      }

      steps.set(stored.key, stored);
      wasCreatedThisBatch.add(stored.key);
      audit(stored, 'GATE_SYNC_STEP');
      touchedAppointments.add(app.id);
    }
  }

  // 对账：迟到的 OCR/称重/封志在批次末尾补齐后，自动重新裁决挂起的签到
  reconcile(touchedAppointments, serverNow, reconciledByItem);

  return {
    serverAt: serverNow.toISOString(),
    items: batch.map(env => {
      const stored = steps.get(env.idempotencyKey);
      const app = stored ? appointments.find(item => item.id === stored.appointmentId) : undefined;
      const container = app ? containers.find(item => item.id === app.containerId) : undefined;
      return {
        idempotencyKey: env.idempotencyKey,
        deviceId: env.deviceId,
        appointmentId: env.appointmentId,
        seq: env.seq,
        kind: env.kind,
        status: stored?.status ?? 'conflict',
        applied: stored?.applied ?? false,
        replayed: !wasCreatedThisBatch.has(env.idempotencyKey),
        reasons: stored?.reasons ?? [reason('not-processed', '该步骤未进入处理流程')],
        serverAt: serverNow.toISOString(),
        skewMs: stored?.skewMs ?? 0,
        appointmentStatus: app?.status,
        containerStatus: container?.status,
        reconciledKey: reconciledByItem.get(env.idempotencyKey),
      };
    }),
  };
}

// （幂等重放的判定集合在 syncGateSteps 上方声明）

function reconcile(touched: Set<string>, serverNow: Date, reconciledByItem: Map<string, string>) {
  for (const appointmentId of touched) {
    const app = appointments.find(item => item.id === appointmentId);
    const pending = [...steps.values()].find(
      step => step.appointmentId === appointmentId && step.kind === 'check-in' && step.status === 'review' && !step.supersededBy,
    );
    if (!app || !pending) continue;

    const decision = decideCheckin(
      { idempotencyKey: pending.key, deviceId: pending.deviceId, appointmentId, seq: pending.seq, clientAt: pending.clientAt, kind: 'check-in', payload: { kind: 'check-in' } },
      app,
      containers.find(item => item.id === app.containerId),
      pending.skewMs,
      serverNow,
      false,
    );

    if (decision.status === 'accepted') {
      const device = devices.find(item => item.id === pending.deviceId);
      applyCheckin(appointmentId, device);
      pending.status = 'accepted';
      pending.applied = true;
      pending.reasons = [
        ...decision.reasons,
        reason('auto-reconciled', `前置检查在 ${serverNow.toLocaleTimeString()} 补齐，自动对账放行`, 'info'),
      ];
      audit(pending, 'GATE_CHECKIN_RECONCILED');
      // 找到本批次最后一个被采纳的前置步骤，作为触发对账的条目
      const trigger = [...steps.values()]
        .filter(step => step.appointmentId === appointmentId && step.applied && step.kind !== 'check-in' && wasCreatedThisBatch.has(step.key))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.seq - a.seq)[0];
      if (trigger) reconciledByItem.set(trigger.key, pending.key);
    } else if (decision.status === 'review') {
      const codes = decision.reasons.map(item => item.code).join(',');
      const oldCodes = pending.reasons.map(item => item.code).join(',');
      if (codes !== oldCodes) {
        pending.reasons = decision.reasons;
        app.exception = `离线签到待处理：${decision.reasons.filter(item => item.severity === 'warning').map(item => item.message).join('；')}`;
        audit(pending, 'GATE_CHECKIN_REEVALUATED');
      }
    }
  }
}

export interface GateSyncRecord extends StoredStep {
  deviceName?: string;
  appointmentStatus?: string;
  containerId?: string;
  containerStatus?: string;
}

export function getSyncRecords(): { devices: GateDevice[]; steps: GateSyncRecord[] } {
  const sorted = [...steps.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.seq - a.seq);
  return {
    devices: listDevices(),
    steps: sorted.map(step => {
      const app = appointments.find(item => item.id === step.appointmentId);
      const container = app ? containers.find(item => item.id === app.containerId) : undefined;
      return {
        ...step,
        payload: { ...step.payload },
        reasons: step.reasons.map(item => ({ ...item })),
        deviceName: devices.find(item => item.id === step.deviceId)?.name,
        appointmentStatus: app?.status,
        containerId: app?.containerId,
        containerStatus: container?.status,
      };
    }),
  };
}

/** 仅供测试：清空离线同步状态（不动预约/箱务种子数据） */
export function resetGateSync() {
  steps.clear();
  deviceMaxSeq.clear();
  wasCreatedThisBatch.clear();
  for (const device of devices) delete device.lastSeenAt;
}
