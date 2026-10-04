import { useCallback, useEffect, useMemo, useState } from 'react';
import { clearFinished, enqueueOp, flushQueue, queueSnapshot, reconcileQueue, setForcedOffline, subscribeQueue, type GateStepKind, type QueueSnapshot } from './offlineQueue';

type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup' | 'dropoff'; windowStart: string; windowEnd: string; lane: string; status: string; sealVerified: boolean; weightVerified: boolean; exception?: string };
type Container = { id: string; status: string; weightT: number };
type ReviewItem = { idempotencyKey: string; reason: string; status: string; createdAt: string; op: { appointmentId: string; containerId: string; step: GateStepKind; deviceId: string; occurredAt: string } };
type JournalEntry = { serverSeq: number; idempotencyKey: string; deviceId: string; appointmentId: string; containerId: string; step: GateStepKind; decision: 'accepted' | 'conflict' | 'review'; reason: string; occurredAt: string; normalizedAt: string; clockSkewMs: number; decidedAt: string };
type AuditEvent = { id: string; actor: string; action: string; entity: string; entityId: string; at: string; details: string };

const STEP_LABEL: Record<GateStepKind, string> = { 'check-in': '签到', ocr: 'OCR 识别', weigh: '称重', seal: '封志检查', complete: '完成放行' };
const STEP_LIST: GateStepKind[] = ['check-in', 'ocr', 'weigh', 'seal', 'complete'];
const DECISION_LABEL: Record<string, string> = { accepted: '已接受', conflict: '冲突拒绝', review: '待复核', queued: '待上传', syncing: '上传中' };
const time = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const skewText = (ms?: number) => ms ? `终端时钟偏差 ${ms > 0 ? '落后' : '超前'} ${Math.round(Math.abs(ms) / 1000)}s` : '';

export default function OfflineGate({ appointments, containers, onChanged }: { appointments: Appointment[]; containers: Container[]; onChanged: () => void }) {
  const [snap, setSnap] = useState<QueueSnapshot>(() => queueSnapshot());
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [audits, setAudits] = useState<AuditEvent[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [plate, setPlate] = useState('');
  const [ocrNo, setOcrNo] = useState('');
  const [weight, setWeight] = useState('');
  const [sealNo, setSealNo] = useState('');
  const [note, setNote] = useState('');
  const [hint, setHint] = useState('');

  useEffect(() => subscribeQueue(() => setSnap(queueSnapshot())), []);

  const refreshServer = useCallback(async () => {
    try {
      const [rv, jn, au] = await Promise.all([
        fetch('/api/gate/sync/review').then(res => res.json()),
        fetch('/api/gate/sync/journal').then(res => res.json()),
        fetch('/api/audit').then(res => res.json())
      ]);
      setReview(rv);
      setJournal(jn);
      setAudits((au as AuditEvent[]).filter(event => event.action.startsWith('GATE_SYNC')).slice(0, 8));
    } catch { /* 离线时保留已有数据 */ }
  }, []);

  const syncAll = useCallback(async () => {
    const sent = await flushQueue();
    await refreshServer();
    if (sent) onChanged();
  }, [refreshServer, onChanged]);

  useEffect(() => {
    void reconcileQueue().then(refreshServer);
    const timer = setInterval(() => void syncAll(), 15000);
    return () => clearInterval(timer);
  }, [refreshServer, syncAll]);

  const workable = useMemo(() => appointments.filter(item => item.status === 'booked' || item.status === 'checked-in'), [appointments]);
  const selected = workable.find(item => item.id === selectedId) ?? workable[0];
  const selectedKey = selected?.id ?? '';
  useEffect(() => {
    if (!selected) return;
    setPlate(selected.truckNo);
    setOcrNo(selected.containerId);
    setWeight(String(containers.find(item => item.id === selected.containerId)?.weightT ?? ''));
    setSealNo('');
  }, [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const queuedSteps = useMemo(() => new Set(snap.ops.filter(op => op.appointmentId === selectedKey && (op.status === 'queued' || op.status === 'syncing')).map(op => op.step)), [snap.ops, selectedKey]);

  const stepDone = (step: GateStepKind): boolean => {
    if (!selected) return true;
    if (queuedSteps.has(step)) return true;
    switch (step) {
      case 'check-in': return selected.status === 'checked-in' || selected.status === 'completed';
      case 'weigh': return selected.weightVerified;
      case 'seal': return selected.sealVerified;
      case 'complete': return selected.status === 'completed';
      default: return false;
    }
  };

  const doStep = (step: GateStepKind) => {
    if (!selected) return;
    const payload = step === 'ocr' ? { ocrPlate: plate, ocrContainerNo: ocrNo }
      : step === 'weigh' ? { weightT: Number(weight) }
      : step === 'seal' ? { sealNo }
      : undefined;
    enqueueOp({ appointmentId: selected.id, containerId: selected.containerId, step, payload });
    setHint(`${STEP_LABEL[step]}已写入本地队列（${snap.online ? '联网中，立即上传' : '离线，恢复后自动上传'}）`);
    void syncAll();
  };

  const resolve = async (key: string, action: 'accept' | 'reject') => {
    const response = await fetch(`/api/gate/sync/review/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, note: note || (action === 'accept' ? '值班员现场确认' : '值班员现场拒绝') })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setHint(body.message || '复核操作失败');
    } else {
      setHint(action === 'accept' ? '复核已通过并落账' : '复核已拒绝，操作终态为冲突');
    }
    await refreshServer();
    onChanged();
  };

  return <div className="layout">
    <section className="panel">
      <div className="panel-head">
        <div><div className="eyebrow">OFFLINE GATE / 离线作业台</div><h2>闸口离线签到与检查</h2><span className="muted">网络不稳定时步骤先落本机队列，恢复后按设备顺序自动上传，司机无需重复操作</span></div>
        <span className={`badge ${snap.online ? 'low' : 'high'}`}>{snap.syncing ? 'SYNCING' : snap.online ? 'ONLINE' : 'OFFLINE'}</span>
      </div>
      <div className="sync-bar">
        <span>设备 <b>{snap.deviceId}</b></span>
        <span>待上传 <b>{snap.pendingCount}</b> 条</span>
        {snap.lastSkewMs ? <span className="warning">{skewText(snap.lastSkewMs)}</span> : null}
        {snap.lastSyncAt ? <span>上次同步 {time(snap.lastSyncAt)}</span> : null}
        <button onClick={() => setForcedOffline(!snap.forcedOffline)}>{snap.forcedOffline ? '▶ 恢复联机（演练）' : '⏸ 模拟断网（演练）'}</button>
        <button onClick={() => void syncAll()} disabled={!snap.online || snap.syncing}>立即同步</button>
      </div>
      {selected ? <>
        <div className="form-grid">
          <label>作业预约<select value={selectedKey} onChange={event => setSelectedId(event.target.value)}>{workable.map(item => <option key={item.id} value={item.id}>{item.id} · {item.containerId} · {item.truckNo}（{item.status}）</option>)}</select></label>
          <label>OCR 车牌<input value={plate} onChange={event => setPlate(event.target.value)}/></label>
          <label>OCR 箱号<input value={ocrNo} onChange={event => setOcrNo(event.target.value.toUpperCase())}/></label>
          <label>称重（吨）<input type="number" step="0.1" value={weight} onChange={event => setWeight(event.target.value)}/></label>
          <label>封志号<input value={sealNo} placeholder="封志检查后填写" onChange={event => setSealNo(event.target.value)}/></label>
        </div>
        <div className="step-pad">
          {STEP_LIST.map(step => <button key={step} disabled={stepDone(step)} onClick={() => doStep(step)}>{STEP_LABEL[step]}{stepDone(step) ? ' ✓' : ''}</button>)}
        </div>
        {selected.exception ? <div className="conflict" style={{ marginTop: 12 }}><strong>异常</strong><span>{selected.exception}</span></div> : null}
      </> : <p>当前没有可作业的预约（booked / checked-in）。</p>}
      {hint && <div className="offline-hint">{hint}</div>}
    </section>

    <section className="panel">
      <div className="panel-head"><div><div className="eyebrow">LOCAL QUEUE / 本地队列</div><h2>待同步与已裁决操作</h2></div><button className="row-actions" style={{ border: 0 }} onClick={clearFinished}>清理已裁决</button></div>
      <div className="table queue-table">
        <div className="tr th"><span>序号 / 步骤</span><span>预约 / 箱</span><span>操作时间</span><span>状态</span><span>服务端裁决说明</span></div>
        {snap.ops.length === 0 && <div className="tr"><span>队列为空。断网演练时点击左侧步骤按钮，操作会暂存在这里。</span></div>}
        {snap.ops.map(op => <div className="tr" key={op.key}>
          <span><b>#{op.sequence} {STEP_LABEL[op.step]}</b><small>{op.attempts > 0 ? `已重试 ${op.attempts} 次` : op.deviceId}</small></span>
          <span><b>{op.appointmentId}</b><small>{op.containerId}</small></span>
          <span>{time(op.occurredAt)}</span>
          <span><span className={`pill ${op.status}`}>{DECISION_LABEL[op.status]}</span></span>
          <span><small>{op.reason ?? '—'}{op.clockSkewMs ? `（${skewText(op.clockSkewMs)}）` : ''}</small></span>
        </div>)}
      </div>
    </section>

    <section className="panel">
      <div className="panel-head"><div><div className="eyebrow">MANUAL REVIEW / 人工复核</div><h2>待值班员裁决</h2><span className="muted">窗口外签到、时钟异常、重量/箱号不符等软冲突在此裁决；双闸口签到等硬冲突不可覆盖</span></div></div>
      <label style={{ display: 'block', marginBottom: 12 }}><small>复核备注</small><input style={{ width: '100%', background: '#071621', border: '1px solid #294859', color: '#dfedf2', borderRadius: 7, padding: '9px 11px', font: 'inherit', marginTop: 5 }} value={note} placeholder="默认：值班员现场确认 / 拒绝" onChange={event => setNote(event.target.value)}/></label>
      {review.length === 0 && <p>没有待复核项。同步中产生软冲突时会出现在这里。</p>}
      {review.map(item => <div className="review-item" key={item.idempotencyKey}>
        <div><b>{STEP_LABEL[item.op.step]}</b> · {item.op.appointmentId} · {item.op.containerId}<small> 设备 {item.op.deviceId} · {time(item.createdAt)}</small></div>
        <p>{item.reason}</p>
        <div className="row-actions"><button onClick={() => void resolve(item.idempotencyKey, 'accept')}>接受并落账</button><button className="danger-action" onClick={() => void resolve(item.idempotencyKey, 'reject')}>拒绝</button></div>
      </div>)}
    </section>

    <section className="panel">
      <div className="panel-head"><div><div className="eyebrow">SYNC JOURNAL / 同步日志</div><h2>每一步为什么被接受或拒绝</h2></div><span className="muted">{journal.length} 条</span></div>
      <div className="table journal-table">
        <div className="tr th"><span>#</span><span>设备 / 步骤</span><span>预约 / 箱</span><span>裁决</span><span>原因（含时钟归一化）</span></div>
        {journal.slice(0, 20).map(entry => <div className="tr" key={entry.serverSeq}>
          <span>{entry.serverSeq}</span>
          <span><b>{entry.deviceId}</b><small>{STEP_LABEL[entry.step]} · {time(entry.decidedAt)}</small></span>
          <span><b>{entry.appointmentId}</b><small>{entry.containerId}</small></span>
          <span><span className={`pill ${entry.decision}`}>{DECISION_LABEL[entry.decision]}</span></span>
          <span><small>{entry.reason}{entry.clockSkewMs ? `（${skewText(entry.clockSkewMs)}，已按 {time(entry.normalizedAt)} 归一化）` : ''}</small></span>
        </div>)}
      </div>
    </section>

    <section className="panel wide">
      <div className="panel-head"><div><div className="eyebrow">AUDIT TRAIL / 审计留痕</div><h2>闸口同步审计记录</h2></div><span className="muted">与箱务/预约状态变更同源</span></div>
      {audits.length === 0 && <p>暂无闸口同步审计记录。</p>}
      {audits.map(event => <div className="equipment" key={event.id}><i className="equip-dot"/><div><b>{event.actor} · {event.entityId}</b><small>{event.details}</small></div><strong>{time(event.at)}</strong></div>)}
    </section>
  </div>;
}
