import express from 'express';
import { appointments, assignTask, blocks, containerDetail, containers, createContainer, createGateAppointment, createYardTask, dashboard, deleteContainer, deleteGateAppointment, deleteYardTask, editGateAppointment, equipment, gateConflicts, prioritizeTasks, tasks, updateContainer, updateYardTask, voyages, yardHeatmap } from './domain.js';
import { GateStepEnvelope, GateStepKind, getClock, getSyncRecords, syncGateSteps } from './gateSync.js';

const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/voyages', (_req, res) => res.json(voyages));
app.get('/api/containers', (req, res) => res.json(req.query.status ? containers.filter(c => c.status === req.query.status) : containers));
app.post('/api/containers', (req, res) => { try { res.status(201).json(createContainer(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建箱务记录失败' }); } });
app.patch('/api/containers/:id', (req, res) => { try { const result = updateContainer(req.params.id, req.body); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新箱务记录失败' }); } });
app.delete('/api/containers/:id', (req, res) => { const result = deleteContainer(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/containers/:id', (req, res) => { const result = containerDetail(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); });
app.get('/api/yard/heatmap', (_req, res) => res.json(yardHeatmap()));
app.get('/api/yard/blocks', (_req, res) => res.json(blocks));
app.get('/api/gate/appointments', (_req, res) => res.json(appointments));
app.get('/api/gate/conflicts', (_req, res) => res.json(gateConflicts()));
app.post('/api/gate/appointments', (req, res) => { try { res.status(201).json(createGateAppointment(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '预约失败' }); } });
app.patch('/api/gate/appointments/:id', (req, res) => { try { const result = editGateAppointment(req.params.id, req.body); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新预约失败' }); } });
app.delete('/api/gate/appointments/:id', (req, res) => { const result = deleteGateAppointment(req.params.id); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/equipment', (_req, res) => res.json(equipment));
app.get('/api/tasks', (_req, res) => res.json(prioritizeTasks()));
app.post('/api/tasks', (req, res) => { try { res.status(201).json(createYardTask(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建作业任务失败' }); } });
app.patch('/api/tasks/:id', (req, res) => { try { const result = updateYardTask(req.params.id, req.body); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新作业任务失败' }); } });
app.delete('/api/tasks/:id', (req, res) => { const result = deleteYardTask(req.params.id); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json({ deleted: true, id: result.id }); });
app.patch('/api/tasks/:id/assign', (req, res) => { const result = assignTask(req.params.id, req.body.equipmentId); if (!result) return res.status(404).json({ message: '任务或设备不存在' }); res.json(result); });
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'port-yard-operations' }));

// —— 闸口离线作业队列与同步 ——

app.get('/api/gate/devices', (_req, res) => res.json({ ...getClock(), devices: getSyncRecords().devices }));
app.get('/api/gate/sync-records', (_req, res) => res.json(getSyncRecords()));

const STEP_KINDS: GateStepKind[] = ['ocr', 'weight', 'seal', 'check-in'];
function validateBatch(body: unknown): { batch?: GateStepEnvelope[]; message?: string } {
  if (!body || typeof body !== 'object') return { message: '请求体必须是 JSON 对象' };
  const steps = (body as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return { message: 'steps 必须为数组' };
  if (steps.length === 0) return { message: 'steps 不能为空批次' };
  const seen = new Set<string>();
  const normalized: GateStepEnvelope[] = [];
  for (const [index, raw] of steps.entries()) {
    if (!raw || typeof raw !== 'object') return { message: `第 ${index + 1} 条不是对象` };
    const item = raw as Record<string, unknown>;
    const where = `第 ${index + 1} 条（${String(item.idempotencyKey ?? index)}）`;
    const idempotencyKey = String(item.idempotencyKey ?? '').trim();
    if (!idempotencyKey) return { message: `${where} 缺少 idempotencyKey` };
    if (seen.has(idempotencyKey)) return { message: `${where} 在批次内幂等键重复` };
    seen.add(idempotencyKey);
    if (typeof item.deviceId !== 'string' || !item.deviceId) return { message: `${where} 缺少 deviceId` };
    if (typeof item.appointmentId !== 'string' || !item.appointmentId) return { message: `${where} 缺少 appointmentId` };
    if (!STEP_KINDS.includes(item.kind as GateStepKind)) return { message: `${where} kind 不支持：${String(item.kind)}` };
    if (!Number.isFinite(Number(item.seq)) || Number(item.seq) < 0) return { message: `${where} seq 必须为非负整数` };
    if (Number(item.seq) % 1 !== 0) return { message: `${where} seq 必须为非负整数` };
    if (typeof item.clientAt !== 'string' || Number.isNaN(Date.parse(item.clientAt))) return { message: `${where} clientAt 必须是 ISO 时间` };
    if (item.payload === undefined || typeof item.payload !== 'object') return { message: `${where} 缺少 payload` };
    normalized.push({
      idempotencyKey,
      deviceId: item.deviceId,
      appointmentId: item.appointmentId,
      seq: Number(item.seq),
      clientAt: item.clientAt,
      recordedAt: typeof item.recordedAt === 'string' ? item.recordedAt : undefined,
      kind: item.kind as GateStepKind,
      payload: item.payload as GateStepEnvelope['payload'],
    });
  }
  return { batch: normalized };
}

app.post('/api/gate/sync', (req, res) => {
  const { batch, message } = validateBatch(req.body);
  if (!batch) return res.status(400).json({ message });
  try {
    const result = syncGateSteps(batch);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : '闸口同步失败' });
  }
});
const port = Number(process.env.PORT || 4107); app.listen(port, () => console.log(`port yard API listening on ${port}`));
