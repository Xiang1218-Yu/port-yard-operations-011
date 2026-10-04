import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateAppointment } from './domain.js';
import { CLOCK_SKEW_LIMIT_MS, GateStepEnvelope, GateStepKind, GateStepPayload, resetGateSync, syncGateSteps } from './gateSync.js';

let counter = 0;
function makeAppointment(
  containerId = 'FCIU-9920310',
  lane: 'north' | 'south' | 'rail' = 'north',
  type: 'pickup' | 'dropoff' = 'pickup',
) {
  counter += 1;
  const apt = createGateAppointment({
    containerId,
    truckNo: `沪A·TEST${counter}`,
    driver: '离线测试司机',
    type,
    windowStart: new Date(Date.now() - 45 * 60000).toISOString(),
    windowEnd: new Date(Date.now() + 45 * 60000).toISOString(),
    lane,
  });
  appointmentsById.set(apt.id, { containerId });
  return apt;
}

const key = (() => {
  let n = 0;
  return (prefix: string) => {
    n += 1;
    return `K-${prefix}-${n}-${Math.random().toString(36).slice(2, 8)}`;
  };
})();

function defaultPayload(kind: GateStepKind, appointmentId: string): GateStepPayload {
  if (kind === 'ocr') return { kind, containerId: appointmentsById.get(appointmentId)?.containerId ?? '', confidence: 0.99 };
  if (kind === 'weight') return { kind, weightT: 12.2 };
  if (kind === 'seal') return { kind, sealNo: 'SEAL-X1', intact: true };
  return { kind, truckNo: '沪A·TEST', driver: '离线测试司机' };
}

const appointmentsById = new Map<string, { containerId: string }>();

function step(partial: Partial<GateStepEnvelope> & Pick<GateStepEnvelope, 'appointmentId' | 'kind'>): GateStepEnvelope {
  const base: GateStepEnvelope = {
    idempotencyKey: key(partial.kind),
    deviceId: 'GATE-N1',
    appointmentId: partial.appointmentId,
    seq: 1,
    clientAt: new Date().toISOString(),
    kind: partial.kind,
    payload: defaultPayload(partial.kind, partial.appointmentId),
  };
  return { ...base, ...partial };
}

function statusOf(result: ReturnType<typeof syncGateSteps>, index = 0) {
  return result.items[index];
}

test.beforeEach(() => resetGateSync());

test('幂等键：同一批次及重试中重复步骤返回同一份裁决', () => {
  const apt = makeAppointment();
  const ocrKey = key('ocr');
  const ocr = step({ appointmentId: apt.id, kind: 'ocr', idempotencyKey: ocrKey, seq: 1, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.97 } });

  const first = syncGateSteps([ocr]);
  assert.equal(statusOf(first).status, 'accepted');
  assert.equal(statusOf(first).applied, true);

  // 网络层不确定导致整批重试：完全相同的键再次上传
  const retry = syncGateSteps([{ ...ocr, clientAt: new Date(Date.now() + 5000).toISOString() }]);
  assert.equal(statusOf(retry).status, 'accepted');
  assert.equal(statusOf(retry).applied, true, '结果接受');
  assert.equal(statusOf(retry).reasons.some(r => r.code === 'duplicate-merged'), false, '幂等键重放不是合并，而是原裁决');
  assert.equal(statusOf(retry).appointmentStatus, 'booked');

  // 批次内重复键应当被路由层拒绝（此处直接验证领域层不会双写：再次单传）
  const again = syncGateSteps([{ ...ocr }]);
  assert.equal(again.items[0].idempotencyKey, ocrKey);
});

test('乱序上传：先签到后补检查结果，签到先挂起 review，补齐后自动对账 accepted', () => {
  const apt = makeAppointment('MSCU-4829017'); // 台账 22.4t
  const checkin = step({ appointmentId: apt.id, kind: 'check-in', deviceId: 'GATE-N1', seq: 3, payload: { kind: 'check-in' } });
  const first = syncGateSteps([checkin]);
  assert.equal(statusOf(first).status, 'review');
  assert.equal(statusOf(first).applied, false);
  assert.ok(statusOf(first).reasons.some(r => r.code === 'missing-ocr'));
  assert.ok(statusOf(first).reasons.some(r => r.code === 'missing-weight'));
  assert.ok(statusOf(first).reasons.some(r => r.code === 'missing-seal'));
  assert.equal(apt.status, 'exception', '箱务/预约不应直接翻成 checked-in');
  assert.ok((apt.exception ?? '').includes('离线签到待处理'));

  // 网络恢复后迟到的三步（更小的序号也没关系），一次性补齐
  const rest = [
    step({ appointmentId: apt.id, kind: 'ocr', deviceId: 'GATE-N1', seq: 1, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.96 } }),
    step({ appointmentId: apt.id, kind: 'weight', deviceId: 'GATE-N1', seq: 2, payload: { kind: 'weight', weightT: 22.4 } }),
    step({ appointmentId: apt.id, kind: 'seal', deviceId: 'GATE-N1', seq: 2, payload: { kind: 'seal', sealNo: 'SL-882', intact: true } }),
  ];
  const second = syncGateSteps(rest);
  assert.deepEqual(second.items.map(i => i.status), ['accepted', 'accepted', 'accepted']);
  // 触发对账的那条（最后收到的采纳步骤）带回被补齐的签到键
  assert.ok(second.items.some(i => i.reconciledKey === checkin.idempotencyKey));

  // 签到键重放：此时应当看到已升级为 accepted 且预约 checked-in
  const replay = syncGateSteps([{ ...checkin }]);
  assert.equal(statusOf(replay).status, 'accepted');
  assert.equal(apt.status, 'checked-in');
  assert.equal(apt.exception, undefined);
  assert.equal(statusOf(replay).reasons.some(r => r.code === 'auto-reconciled'), true);
});

test('防止同一箱被两台闸口重复签到：第二台得到 conflict 且不覆盖状态', () => {
  const aptA = makeAppointment('CMAU-6001722', 'north'); // 23.5t 在途进口箱，无其它签到干扰
  const aptB = makeAppointment('CMAU-6001722', 'south'); // 同箱另一张预约（异常排产）

  const fullBatch = (deviceId: string, aptId: string, fromSeq = 0): GateStepEnvelope[] => [
    step({ appointmentId: aptId, deviceId, seq: fromSeq + 1, kind: 'ocr', payload: { kind: 'ocr', containerId: 'CMAU-6001722', confidence: 0.99 } }),
    step({ appointmentId: aptId, deviceId, seq: fromSeq + 2, kind: 'weight', payload: { kind: 'weight', weightT: 23.5 } }),
    step({ appointmentId: aptId, deviceId, seq: fromSeq + 3, kind: 'seal', payload: { kind: 'seal', sealNo: 'S-1', intact: true } }),
    step({ appointmentId: aptId, deviceId, seq: fromSeq + 4, kind: 'check-in', payload: { kind: 'check-in' } }),
  ];

  const first = syncGateSteps(fullBatch('GATE-N1', aptA.id));
  assert.equal(first.items[3].status, 'accepted');
  assert.equal(aptA.status, 'checked-in');

  // 南闸口离线期间并不知道北闸口已放行，联网补传 -> 冲突
  const second = syncGateSteps(fullBatch('GATE-S1', aptB.id, 10));
  assert.equal(second.items[3].status, 'conflict');
  assert.equal(second.items[3].reasons[0].code, 'already-checked-in-elsewhere');
  assert.equal(aptA.status, 'checked-in', '先到的放行保持有效，不被覆盖');
  assert.notEqual(aptB.status, 'checked-in');
});

test('同步期间预约被取消：取消后上传的所有步骤 conflict 且不做状态翻转', () => {
  const apt = makeAppointment();
  // OCR 先到达并接受
  const ocr = step({ appointmentId: apt.id, kind: 'ocr', seq: 1, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.91 } });
  assert.equal(syncGateSteps([ocr]).items[0].status, 'accepted');

  // 预约在同步窗口内被中控取消（复用领域更新能力）
  apt.status = 'cancelled';

  const rest = [
    step({ appointmentId: apt.id, kind: 'weight', seq: 2, payload: { kind: 'weight', weightT: 12.2 } }),
    step({ appointmentId: apt.id, kind: 'seal', seq: 3, payload: { kind: 'seal', sealNo: 'S-2', intact: true } }),
    step({ appointmentId: apt.id, kind: 'check-in', seq: 4, payload: { kind: 'check-in' } }),
  ];
  const result = syncGateSteps(rest);
  assert.ok(result.items.every(i => i.status === 'conflict'));
  assert.ok(result.items.every(i => i.reasons[0].code === 'appointment-cancelled'));
  assert.equal(apt.status, 'cancelled');
  assert.equal(apt.weightVerified, false, '取消后称重结果不得写入');
});

test('本地时钟与服务端偏差过大：测量仍可记录，签到必须人工复核', () => {
  const apt = makeAppointment();
  const skewedClientAt = new Date(Date.now() + CLOCK_SKEW_LIMIT_MS + 5 * 60000).toISOString();
  const batch = [
    step({ appointmentId: apt.id, deviceId: 'GATE-N2', kind: 'ocr', seq: 1, clientAt: skewedClientAt, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.99 } }),
    step({ appointmentId: apt.id, deviceId: 'GATE-N2', kind: 'weight', seq: 2, clientAt: skewedClientAt, payload: { kind: 'weight', weightT: 12.2 } }),
    step({ appointmentId: apt.id, deviceId: 'GATE-N2', kind: 'seal', seq: 3, clientAt: skewedClientAt, payload: { kind: 'seal', sealNo: 'S-3', intact: true } }),
    step({ appointmentId: apt.id, deviceId: 'GATE-N2', kind: 'check-in', seq: 4, clientAt: skewedClientAt, payload: { kind: 'check-in' } }),
  ];
  const result = syncGateSteps(batch);
  assert.equal(result.items[0].status, 'accepted');
  assert.ok(result.items[0].reasons.some(r => r.code === 'clock-skew-noted'));
  assert.equal(result.items[3].status, 'review');
  assert.ok(result.items[3].reasons.some(r => r.code === 'clock-skew'));
  assert.notEqual(apt.status, 'checked-in');
});

test('部分成功后重试：失败步骤补正后通过，已接受步骤幂等不重复', () => {
  const apt = makeAppointment('MSCU-4829017');
  // 封志破损 + 缺称重：签到挂起
  const batch1 = [
    step({ appointmentId: apt.id, kind: 'ocr', seq: 1, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.95 } }),
    step({ appointmentId: apt.id, kind: 'seal', seq: 2, payload: { kind: 'seal', sealNo: '', intact: false } }),
    step({ appointmentId: apt.id, kind: 'check-in', seq: 3, payload: { kind: 'check-in' } }),
  ];
  const r1 = syncGateSteps(batch1);
  assert.equal(r1.items[1].status, 'review');
  assert.equal(r1.items[2].status, 'review');
  assert.equal(apt.sealVerified, false);

  // 值班员现场处理后重采封志、补称重；原封志键保留在审计中，新键上传
  const batch2 = [
    ...batch1, // 模拟客户端整批重试：旧键必须幂等
    step({ appointmentId: apt.id, kind: 'seal', seq: 4, payload: { kind: 'seal', sealNo: 'SL-OK-9', intact: true } }),
    step({ appointmentId: apt.id, kind: 'weight', seq: 5, payload: { kind: 'weight', weightT: 22.4 } }),
  ];
  const r2 = syncGateSteps(batch2);
  assert.equal(r2.items[0].replayed, true, '旧 OCR 键是幂等重放：不重复执行副作用，裁决保持首次结论');
  assert.equal(r2.items[0].status, 'accepted');
  assert.equal(r2.items[3].status, 'accepted');
  assert.equal(r2.items[4].status, 'accepted');
  assert.equal(apt.status, 'checked-in', '补齐后自动对账放行');
  assert.equal(apt.sealVerified, true);
});

test('OCR 箱号不符、称重超差、封志异常分别导向人工复核', () => {
  const apt = makeAppointment('MSCU-4829017');
  const r1 = syncGateSteps([step({ appointmentId: apt.id, kind: 'ocr', seq: 1, payload: { kind: 'ocr', containerId: 'WRONG-9999999', confidence: 0.99 } })]);
  assert.equal(r1.items[0].status, 'review');
  assert.equal(r1.items[0].reasons[0].code, 'ocr-container-mismatch');

  const r2 = syncGateSteps([step({ appointmentId: apt.id, kind: 'weight', seq: 2, payload: { kind: 'weight', weightT: 40 } })]);
  assert.equal(r2.items[0].status, 'review');
  assert.equal(r2.items[0].reasons[0].code, 'weight-discrepancy');

  const apt2 = makeAppointment('CMAU-6001722', 'rail');
  const r3 = syncGateSteps([step({ appointmentId: apt2.id, deviceId: 'GATE-R1', kind: 'seal', seq: 1, payload: { kind: 'seal', sealNo: 'SL-7', intact: false } })]);
  assert.equal(r3.items[0].status, 'review');
  assert.ok(r3.items[0].reasons.some(reasonItem => reasonItem.code === 'seal-broken'));
});

test('海关未放行箱即使检查齐全也只能转人工，不能自动签到', () => {
  const apt = makeAppointment('TEMU-1774029', 'north', 'dropoff'); // customs: inspection, 26.3t 冷藏
  const batch = [
    step({ appointmentId: apt.id, kind: 'ocr', seq: 1, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.99 } }),
    step({ appointmentId: apt.id, kind: 'weight', seq: 2, payload: { kind: 'weight', weightT: 26.3 } }),
    step({ appointmentId: apt.id, kind: 'seal', seq: 3, payload: { kind: 'seal', sealNo: 'S-9', intact: true } }),
    step({ appointmentId: apt.id, kind: 'check-in', seq: 4, payload: { kind: 'check-in' } }),
  ];
  const result = syncGateSteps(batch);
  assert.equal(result.items[3].status, 'review');
  assert.ok(result.items[3].reasons.some(r => r.code === 'customs-inspection'));
  assert.notEqual(apt.status, 'checked-in');
});

test('窗口外签到（服务端时间为准）需人工复核', () => {
  // 手动构造一张窗口早已结束的预约
  counter += 1;
  const apt = createGateAppointment({
    containerId: 'FCIU-9920310',
    truckNo: `沪A·LATE${counter}`,
    driver: '晚到司机',
    type: 'pickup',
    windowStart: new Date(Date.now() - 6 * 3600000).toISOString(),
    windowEnd: new Date(Date.now() - 5 * 3600000).toISOString(),
    lane: 'north',
  });
  const batch = [
    step({ appointmentId: apt.id, kind: 'ocr', seq: 1, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.99 } }),
    step({ appointmentId: apt.id, kind: 'weight', seq: 2, payload: { kind: 'weight', weightT: 12.2 } }),
    step({ appointmentId: apt.id, kind: 'seal', seq: 3, payload: { kind: 'seal', sealNo: 'S-L', intact: true } }),
    step({ appointmentId: apt.id, kind: 'check-in', seq: 4, payload: { kind: 'check-in' } }),
  ];
  const result = syncGateSteps(batch);
  assert.equal(result.items[3].status, 'review');
  assert.ok(result.items[3].reasons.some(r => r.code === 'outside-appointment-window'));
});

test('跨批次对账：封志破损重采（同机加封）取代旧读数后自动放行，且全程可审计', async () => {
  const { auditEvents } = await import('./domain.js');
  const { getSyncRecords } = await import('./gateSync.js');
  const apt = makeAppointment('CMAU-6001722', 'north');
  const auditCountBefore = auditEvents.length;

  // 断网期间：OCR、称重成功；封志破损；司机仍按了签到 -> 挂起
  const b1 = [
    step({ appointmentId: apt.id, deviceId: 'GATE-N1', kind: 'ocr', seq: 1, payload: { kind: 'ocr', containerId: apt.containerId, confidence: 0.99 } }),
    step({ appointmentId: apt.id, deviceId: 'GATE-N1', kind: 'weight', seq: 2, payload: { kind: 'weight', weightT: 23.5 } }),
    step({ appointmentId: apt.id, deviceId: 'GATE-N1', kind: 'seal', seq: 3, payload: { kind: 'seal', sealNo: 'OLD-1', intact: false } }),
    step({ appointmentId: apt.id, deviceId: 'GATE-N1', kind: 'check-in', seq: 4, payload: { kind: 'check-in' } }),
  ];
  const r1 = syncGateSteps(b1);
  assert.equal(r1.items[2].status, 'review');
  assert.equal(r1.items[3].status, 'review');
  assert.equal(apt.status, 'exception');

  // 值班员现场重新加封并在同一台闸口重采封志
  const reseal = step({ appointmentId: apt.id, deviceId: 'GATE-N1', kind: 'seal', seq: 5, payload: { kind: 'seal', sealNo: 'NEW-9', intact: true } });
  const r2 = syncGateSteps([reseal]);
  assert.equal(r2.items[0].status, 'accepted');
  assert.equal(apt.status, 'checked-in', '重采取代旧读数 + 自动对账放行');

  // 台账里旧读数仍在但已被取代，签到记录 accepted
  const records = getSyncRecords().steps.filter(item => item.appointmentId === apt.id);
  const oldSeal = records.find(item => item.seq === 3);
  assert.equal(oldSeal?.supersededBy, reseal.idempotencyKey);
  assert.equal(oldSeal?.applied, false);

  // 审计覆盖：裁决、取代、对账三类事件都存在
  const newAudits = auditEvents.slice(0, auditEvents.length - auditCountBefore);
  const actions = newAudits.map(item => item.action);
  assert.ok(actions.includes('GATE_SYNC_STEP'));
  assert.ok(actions.includes('GATE_READING_SUPERSEDED'));
  assert.ok(actions.includes('GATE_CHECKIN_RECONCILED'));
});
