import test from 'node:test';
import assert from 'node:assert/strict';
import { appointments, auditEvents, containers, createContainer, createGateAppointment, editGateAppointment } from './domain.js';
import { getSyncResults, resolveReview, reviewQueue, syncBatch, syncJournal, type GateOp, type GateStepKind, type SyncResult } from './gateSync.js';

let seq = 0;
const unique = (prefix: string) => `${prefix}-${++seq}-${Date.now().toString(36)}`;

function setupContainer(weightT = 20) {
  return createContainer({ id: unique('SYNCCTN'), voyageId: 'VOY-AX7', size: '40', isoType: '45G1', direction: 'export', status: 'in-transit', weightT, reefer: false, customs: 'released', priority: 'normal', yardSlot: 'C03-R09-T1' });
}
function setupAppointment(containerId: string, lane: 'north' | 'south' = 'north', windowMinutes: [number, number] = [-60, 60]) {
  return createGateAppointment({ containerId, truckNo: unique('沪T'), driver: '离线测试', type: 'dropoff', windowStart: new Date(Date.now() + windowMinutes[0] * 60000).toISOString(), windowEnd: new Date(Date.now() + windowMinutes[1] * 60000).toISOString(), lane });
}
function op(appointmentId: string, containerId: string, step: GateStepKind, extra: Partial<GateOp> = {}): GateOp {
  return { idempotencyKey: unique('key'), deviceId: 'GATE-T1', sequence: ++seq, appointmentId, containerId, step, occurredAt: new Date().toISOString(), ...extra };
}
const batch = (ops: GateOp[], sentAt = new Date().toISOString()) => syncBatch({ deviceId: 'GATE-T1', sentAt, ops });
const byStep = (results: SyncResult[], step: GateStepKind) => results.find(result => result.step === step)!;

test('离线全流程：签到→OCR→称重→封志→完成全部接受并推进箱务/预约状态', () => {
  const container = setupContainer(20);
  const appointment = setupAppointment(container.id);
  const { results } = batch([
    op(appointment.id, container.id, 'check-in'),
    op(appointment.id, container.id, 'ocr', { payload: { ocrPlate: appointment.truckNo, ocrContainerNo: container.id } }),
    op(appointment.id, container.id, 'weigh', { payload: { weightT: 20.4 } }),
    op(appointment.id, container.id, 'seal', { payload: { sealNo: 'SL-1001' } }),
    op(appointment.id, container.id, 'complete')
  ]);
  assert.equal(results.length, 5);
  assert.ok(results.every(result => result.decision === 'accepted'), results.map(result => result.reason).join(' / '));
  const updated = appointments.find(item => item.id === appointment.id)!;
  assert.equal(updated.status, 'completed');
  assert.equal(updated.weightVerified, true);
  assert.equal(updated.sealVerified, true);
  const box = containers.find(item => item.id === container.id)!;
  assert.equal(box.status, 'in-yard');
  assert.equal(box.weightT, 20.4);
  assert.ok(box.lastEvent.includes('离线同步'));
  assert.ok(auditEvents.some(event => event.action === 'GATE_SYNC' && event.entityId === appointment.id && event.details.includes('接受')));
});

test('幂等重试：同一批次重复上传返回首次结果且状态只落地一次', () => {
  const container = setupContainer();
  const appointment = setupAppointment(container.id);
  const checkIn = op(appointment.id, container.id, 'check-in');
  const first = batch([checkIn]);
  assert.equal(first.results[0].decision, 'accepted');
  const auditsAfterFirst = auditEvents.filter(event => event.details.includes(checkIn.idempotencyKey)).length;
  const second = batch([checkIn]);
  assert.equal(second.results[0].decision, 'accepted');
  assert.equal(second.results[0].replay, true);
  assert.equal(second.results[0].serverSeq, first.results[0].serverSeq);
  assert.equal(auditEvents.filter(event => event.details.includes(checkIn.idempotencyKey)).length, auditsAfterFirst);
});

test('同一箱禁止在两个闸口重复签到', () => {
  const container = setupContainer();
  const north = setupAppointment(container.id, 'north');
  const south = setupAppointment(container.id, 'south');
  const first = batch([op(north.id, container.id, 'check-in', { deviceId: 'GATE-NORTH' })]);
  assert.equal(first.results[0].decision, 'accepted');
  const second = syncBatch({ deviceId: 'GATE-SOUTH', sentAt: new Date().toISOString(), ops: [op(south.id, container.id, 'check-in', { deviceId: 'GATE-SOUTH' })] });
  assert.equal(second.results[0].decision, 'conflict');
  assert.match(second.results[0].reason, /重复签到|两个闸口/);
  const box = containers.find(item => item.id === container.id)!;
  assert.equal(box.appointmentId, north.id);
  assert.equal(appointments.find(item => item.id === south.id)!.status, 'booked');
  assert.match(appointments.find(item => item.id === south.id)!.exception ?? '', /离线冲突/);
});

test('离线期间预约被取消：签到按冲突拒绝并写入审计', () => {
  const container = setupContainer();
  const appointment = setupAppointment(container.id);
  editGateAppointment(appointment.id, { status: 'cancelled' });
  const { results } = batch([op(appointment.id, container.id, 'check-in')]);
  assert.equal(results[0].decision, 'conflict');
  assert.match(results[0].reason, /取消/);
  assert.ok(auditEvents.some(event => event.action === 'GATE_SYNC' && event.details.includes('取消')));
});

test('上传顺序颠倒：称重先到被挂起，签到补齐后自动生效', () => {
  const container = setupContainer(18);
  const appointment = setupAppointment(container.id);
  const weigh = op(appointment.id, container.id, 'weigh', { payload: { weightT: 18.2 } });
  const first = batch([weigh]);
  assert.equal(first.results[0].decision, 'review');
  assert.match(first.results[0].reason, /挂起/);
  assert.ok(reviewQueue().some(item => item.idempotencyKey === weigh.idempotencyKey));
  const second = batch([op(appointment.id, container.id, 'check-in')]);
  assert.equal(second.results[0].decision, 'accepted');
  const reconciled = getSyncResults([weigh.idempotencyKey]);
  assert.equal(reconciled[0].decision, 'accepted');
  assert.equal(appointments.find(item => item.id === appointment.id)!.weightVerified, true);
  assert.ok(!reviewQueue().some(item => item.idempotencyKey === weigh.idempotencyKey));
});

test('同一批次内乱序：按设备序号重排后依次落地', () => {
  const container = setupContainer(21);
  const appointment = setupAppointment(container.id);
  const checkIn = op(appointment.id, container.id, 'check-in', { sequence: 1 });
  const weigh = op(appointment.id, container.id, 'weigh', { sequence: 2, payload: { weightT: 21 } });
  const seal = op(appointment.id, container.id, 'seal', { sequence: 3, payload: { sealNo: 'SL-9' } });
  const complete = op(appointment.id, container.id, 'complete', { sequence: 4 });
  const { results } = batch([complete, seal, weigh, checkIn]);
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.decision === 'accepted'), results.map(result => result.reason).join(' / '));
  assert.equal(appointments.find(item => item.id === appointment.id)!.status, 'completed');
});

test('时钟偏差：终端时间落后被归一化并标记，未来时间进入人工复核', () => {
  const container = setupContainer();
  const appointment = setupAppointment(container.id);
  const clientNow = Date.now() - 10 * 60000; // 终端时钟落后服务端 10 分钟
  const lagging = syncBatch({ deviceId: 'GATE-T1', sentAt: new Date(clientNow).toISOString(), ops: [op(appointment.id, container.id, 'check-in', { occurredAt: new Date(clientNow).toISOString() })] });
  assert.equal(lagging.results[0].decision, 'accepted');
  assert.ok(Math.abs(lagging.results[0].clockSkewMs) >= 2 * 60 * 1000, '应标记终端时钟偏差');

  const container2 = setupContainer();
  const appointment2 = setupAppointment(container2.id);
  const future = batch([op(appointment2.id, container2.id, 'check-in', { occurredAt: new Date(Date.now() + 30 * 60000).toISOString() })]);
  assert.equal(future.results[0].decision, 'review');
  assert.match(future.results[0].reason, /时钟异常/);
});

test('签到时间超出预约窗口（含离线容差）进入人工复核，值班员接受后生效', () => {
  const container = setupContainer();
  const appointment = setupAppointment(container.id, 'north', [-600, -300]); // 窗口在 5 小时前结束
  const checkIn = op(appointment.id, container.id, 'check-in');
  const { results } = batch([checkIn]);
  assert.equal(results[0].decision, 'review');
  assert.match(results[0].reason, /预约窗口/);
  const resolved = resolveReview(checkIn.idempotencyKey, 'accept', '现场核实车辆确在窗口内到达，闸口系统离线');
  assert.equal(resolved?.item.status, 'accepted');
  assert.equal(appointments.find(item => item.id === appointment.id)!.status, 'checked-in');
  assert.equal(getSyncResults([checkIn.idempotencyKey])[0].decision, 'accepted');
});

test('称重偏差超阈值进入复核，拒绝后保持台账重量', () => {
  const container = setupContainer(20);
  const appointment = setupAppointment(container.id);
  batch([op(appointment.id, container.id, 'check-in')]);
  const weigh = op(appointment.id, container.id, 'weigh', { payload: { weightT: 24.5 } });
  const { results } = batch([weigh]);
  assert.equal(results[0].decision, 'review');
  assert.match(results[0].reason, /偏差/);
  const resolved = resolveReview(weigh.idempotencyKey, 'reject', '地磅疑似故障，重新过磅');
  assert.equal(resolved?.item.status, 'rejected');
  const box = containers.find(item => item.id === container.id)!;
  assert.equal(box.weightT, 20);
  assert.equal(appointments.find(item => item.id === appointment.id)!.weightVerified, false);
  assert.equal(getSyncResults([weigh.idempotencyKey])[0].decision, 'conflict');
});

test('部分成功后重试：接受的步骤幂等回放，冲突步骤维持拒绝', () => {
  const container = setupContainer();
  const appointment = setupAppointment(container.id);
  const checkIn = op(appointment.id, container.id, 'check-in');
  const badSeal = op(appointment.id, container.id, 'seal'); // 缺封志号 → 冲突
  const first = batch([checkIn, badSeal]);
  assert.equal(byStep(first.results, 'check-in').decision, 'accepted');
  assert.equal(byStep(first.results, 'seal').decision, 'conflict');
  const retry = batch([checkIn, badSeal]); // 模拟客户端未收到响应后整批重试
  assert.equal(byStep(retry.results, 'check-in').replay, true);
  assert.equal(byStep(retry.results, 'seal').decision, 'conflict');
  assert.equal(containers.find(item => item.id === container.id)!.status, 'at-gate');
  assert.equal(auditEvents.filter(event => event.details.includes(checkIn.idempotencyKey)).length, 1);
});

test('完成放行缺封志时挂起，封志补齐后自动完成并更新箱状态', () => {
  const container = setupContainer(22);
  const appointment = setupAppointment(container.id);
  const complete = op(appointment.id, container.id, 'complete');
  batch([
    op(appointment.id, container.id, 'check-in'),
    op(appointment.id, container.id, 'weigh', { payload: { weightT: 22 } }),
    complete
  ]);
  assert.equal(getSyncResults([complete.idempotencyKey])[0].decision, 'review');
  batch([op(appointment.id, container.id, 'seal', { payload: { sealNo: 'SL-77' } })]);
  assert.equal(getSyncResults([complete.idempotencyKey])[0].decision, 'accepted');
  assert.equal(appointments.find(item => item.id === appointment.id)!.status, 'completed');
  assert.equal(containers.find(item => item.id === container.id)!.status, 'in-yard');
});

test('同步日志可解释每一步的接受/拒绝原因', () => {
  const container = setupContainer();
  const appointment = setupAppointment(container.id);
  const checkIn = op(appointment.id, container.id, 'check-in');
  batch([checkIn]);
  const entry = syncJournal().find(item => item.idempotencyKey === checkIn.idempotencyKey);
  assert.ok(entry);
  assert.equal(entry.decision, 'accepted');
  assert.ok(entry.reason.length > 0);
  assert.ok(entry.normalizedAt.length > 0);
});
