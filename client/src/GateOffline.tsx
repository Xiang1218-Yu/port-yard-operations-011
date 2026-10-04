import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { GateLane, GateQueueState, GateStepKind, gateQueue, statusLabel, stepLabel } from './gateQueue';

type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup'|'dropoff'; windowStart: string; windowEnd: string; lane: GateLane; status: string; exception?: string };
type Container = { id: string; status: string; weightT: number; customs: string };

interface SyncRecord {
  key: string; deviceId: string; deviceName?: string; appointmentId: string; containerId?: string;
  seq: number; kind: GateStepKind; status: string; applied: boolean; supersededBy?: string;
  reasons: { code: string; message: string; severity: string }[];
  clientAt: string; recordedAt?: string; receivedAt: string; skewMs: number;
  appointmentStatus?: string; containerStatus?: string;
}

const REFERENCE_CACHE = 'harborgrid.gate-reference.v1';
const CLOCK_OFFSET_KEY = 'harborgrid.gate-clock-offset-min';
const time = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const shortTime = (value?: string) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

function loadReferenceCache(): { appointments: Appointment[]; containers: Container[]; savedAt: string } | undefined {
  try { const raw = localStorage.getItem(REFERENCE_CACHE); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}

function payloadSummary(kind: GateStepKind, payload: Record<string, unknown>): string {
  if (kind === 'ocr') return `箱号 ${payload.containerId} · 置信度 ${(Number(payload.confidence) * 100).toFixed(1)}%`;
  if (kind === 'weight') return `${payload.weightT} t`;
  if (kind === 'seal') return `${payload.sealNo || '无封志号'} · ${payload.intact ? '完好' : '破损'}`;
  return [payload.truckNo, payload.driver].filter(Boolean).join(' · ') || '抬杆签到';
}

export default function GateOffline() {
  const state = useSyncExternalStore(gateQueue.subscribe.bind(gateQueue), gateQueue.getState.bind(gateQueue)) as GateQueueState;
  const cached = useMemo(loadReferenceCache, []);
  const [appointments, setAppointments] = useState<Appointment[]>(cached?.appointments ?? []);
  const [containers, setContainers] = useState<Container[]>(cached?.containers ?? []);
  const [refSavedAt, setRefSavedAt] = useState<string | undefined>(cached?.savedAt);
  const [records, setRecords] = useState<SyncRecord[]>([]);
  const [selectedApt, setSelectedApt] = useState('');
  const [clockOffsetMin, setClockOffsetMin] = useState<number>(() => Number(localStorage.getItem(CLOCK_OFFSET_KEY) ?? 0));
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // OCR / 称重 / 封志表单
  const [ocrContainer, setOcrContainer] = useState('');
  const [ocrConfidence, setOcrConfidence] = useState('0.98');
  const [weightT, setWeightT] = useState('');
  const [sealNo, setSealNo] = useState(`SL-${Math.floor(1000 + Math.random() * 9000)}`);
  const [sealIntact, setSealIntact] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [aptRes, ctnRes, recRes] = await Promise.all([
        fetch('/api/gate/appointments'), fetch('/api/containers'), fetch('/api/gate/sync-records'),
      ]);
      if (!aptRes.ok || !ctnRes.ok || !recRes.ok) throw new Error('参考数据接口不可用');
      const aptList = await aptRes.json() as Appointment[];
      const ctnList = await ctnRes.json() as Container[];
      const recBody = await recRes.json() as { steps: SyncRecord[] };
      setAppointments(aptList); setContainers(ctnList); setRecords(recBody.steps);
      const savedAt = new Date().toISOString();
      setRefSavedAt(savedAt);
      localStorage.setItem(REFERENCE_CACHE, JSON.stringify({ appointments: aptList, containers: ctnList, savedAt }));
      await gateQueue.refreshDevices();
    } catch {
      setNotice('服务端暂时不可达：使用本机缓存的预约与箱务参考数据，新步骤会进入离线队列');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const appointment = appointments.find(item => item.id === selectedApt);
  const container = containers.find(item => item.id === appointment?.containerId);
  useEffect(() => {
    if (!selectedApt && appointments.length) {
      const preferred = appointments.find(item => item.status === 'booked') ?? appointments[0];
      setSelectedApt(preferred.id);
    }
  }, [appointments, selectedApt]);
  useEffect(() => {
    if (container) { setOcrContainer(container.id); setWeightT(String(container.weightT)); }
  }, [container?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const skewedNowIso = () => new Date(Date.now() + clockOffsetMin * 60000).toISOString();
  const enqueue = (kind: GateStepKind, payload: Record<string, unknown>) => {
    if (!appointment) { setNotice('请先选择预约'); return; }
    const clientAt = clockOffsetMin !== 0 ? skewedNowIso() : undefined;
    const item = gateQueue.enqueue(appointment.id, kind, { kind, ...payload }, undefined, clientAt);
    setNotice(`${stepLabel[kind]}（序号 ${item.seq}）已进入本机队列`);
  };
  const enqueueAll = () => {
    if (!appointment || !container) { setNotice('请先选择预约'); return; }
    enqueue('ocr', { containerId: ocrContainer || container.id, confidence: Number(ocrConfidence) });
    enqueue('weight', { weightT: Number(weightT) });
    enqueue('seal', { sealNo, intact: sealIntact });
    enqueue('check-in', { truckNo: appointment.truckNo, driver: appointment.driver });
    setNotice('四步车检结果已按操作顺序进入本机队列');
  };

  const doSync = async () => {
    setBusy(true); setNotice('');
    const result = await gateQueue.sync();
    setBusy(false);
    if ('error' in result) setNotice(result.error);
    else { setNotice(`本批 ${result.synced} 步已上传并取得服务端裁决`); await refresh(); }
  };

  const online = state.online && !state.forceOffline;
  const pending = state.items.filter(item => item.localStatus === 'queued' || item.localStatus === 'syncing');
  const problems = state.items.filter(item => item.localStatus === 'conflict' || item.localStatus === 'review' || item.localStatus === 'error');
  const skewSec = state.clockSkewMs !== undefined ? Math.round(state.clockSkewMs / 1000) : undefined;
  const device = state.devices.find(item => item.id === state.deviceId);

  return <section className="panel wide gate-offline">
    <div className="panel-head">
      <div>
        <div className="eyebrow">GATE OFFLINE QUEUE / 闸口离线作业</div>
        <h2>离线车检队列与同步裁决</h2>
        <span className="muted">断网期间 OCR、称重、封志、签到暂存本机；联网后按设备序号上传，幂等键保证重试不重复，服务端返回每一步接受/冲突/人工复核</span>
      </div>
      <div className={`net-badge ${online ? 'on' : 'off'}`}><i/>{online ? '在线 · 可同步' : '离线 · 本机暂存'}</div>
    </div>

    <div className="gate-toolbar">
      <label>当前闸口工位
        <select value={state.deviceId} onChange={event => gateQueue.setDevice(event.target.value)}>
          {state.devices.map(item => <option key={item.id} value={item.id}>{item.name}（{item.lane}）</option>)}
          {state.devices.length === 0 && <option value="GATE-N1">北闸口 1 号车道（离线默认）</option>}
        </select>
      </label>
      <label className="check-tool"><input type="checkbox" checked={state.forceOffline} onChange={event => gateQueue.setForceOffline(event.target.checked)}/>模拟断网</label>
      <label className="check-tool"><input type="checkbox" checked={state.autoSync} onChange={event => gateQueue.setAutoSync(event.target.checked)}/>联网自动同步</label>
      <label>设备时钟偏移（分钟，演示本地/服务端时钟不一致）
        <input type="number" value={clockOffsetMin} onChange={event => { const v = Number(event.target.value); setClockOffsetMin(v); localStorage.setItem(CLOCK_OFFSET_KEY, String(v)); }}/>
      </label>
      <button className="primary-action" disabled={busy || !online || pending.length === 0} onClick={() => void doSync()}>
        {busy ? '同步中…' : `立即上传（${pending.length} 步待传）`}
      </button>
      <button onClick={() => void refresh()}>刷新参考数据</button>
    </div>

    <div className="gate-meta">
      <span>工位：<b>{device?.name ?? state.deviceId}</b></span>
      <span>服务端时间：<b>{shortTime(state.serverAt)}</b></span>
      <span>本机-服务端时钟差：<b className={skewSec !== undefined && Math.abs(skewSec) > 180 ? 'critical' : ''}>{skewSec === undefined ? '对时中' : `${skewSec > 0 ? '+' : ''}${skewSec} 秒`}</b></span>
      <span>上次同步：<b>{shortTime(state.lastSyncAt) || '尚未同步'}</b></span>
      {refSavedAt && <span className="muted">参考数据缓存于 {shortTime(refSavedAt)}</span>}
    </div>

    {notice && <div className="gate-notice" onClick={() => setNotice('')}>{notice} ×</div>}

    <div className="gate-capture">
      <div className="capture-head">
        <h3>车检步骤采集（断网时同样可登记）</h3>
        <label>预约 / 箱号
          <select value={selectedApt} onChange={event => setSelectedApt(event.target.value)}>
            {appointments.map(item => <option key={item.id} value={item.id}>{item.id} · {item.containerId} · {item.truckNo} · {item.status}</option>)}
          </select>
        </label>
      </div>
      {appointment && <div className="appt-hint">
        <span>预约 <b>{appointment.id}</b>（{appointment.type === 'pickup' ? '提箱' : '进场'} · {appointment.lane}）</span>
        <span>箱状态 <b className={container?.customs !== 'released' ? 'critical' : ''}>{container?.status} / 海关 {container?.customs}</b></span>
        <span>台账重量 <b>{container?.weightT}t</b></span>
        <span>窗口 {shortTime(appointment.windowStart)}–{shortTime(appointment.windowEnd)}</span>
        {appointment.exception && <span className="warning-text">异常：{appointment.exception}</span>}
      </div>}
      <div className="capture-grid">
        <div className="capture-card">
          <h4>OCR 箱号识别</h4>
          <input placeholder="识别箱号" value={ocrContainer} onChange={event => setOcrContainer(event.target.value.toUpperCase())}/>
          <input type="number" step="0.01" min="0" max="1" value={ocrConfidence} onChange={event => setOcrConfidence(event.target.value)}/>
          <button disabled={!appointment} onClick={() => enqueue('ocr', { containerId: ocrContainer, confidence: Number(ocrConfidence) })}>暂存 OCR</button>
        </div>
        <div className="capture-card">
          <h4>称重</h4>
          <input type="number" step="0.1" placeholder="重量（吨）" value={weightT} onChange={event => setWeightT(event.target.value)}/>
          <button disabled={!appointment} onClick={() => enqueue('weight', { weightT: Number(weightT) })}>暂存称重</button>
        </div>
        <div className="capture-card">
          <h4>封志检查</h4>
          <input placeholder="封志号" value={sealNo} onChange={event => setSealNo(event.target.value)}/>
          <label className="check-tool"><input type="checkbox" checked={sealIntact} onChange={event => setSealIntact(event.target.checked)}/>封志完好</label>
          <button disabled={!appointment} onClick={() => enqueue('seal', { sealNo, intact: sealIntact })}>暂存封志</button>
        </div>
        <div className="capture-card">
          <h4>签到抬杆</h4>
          <small className="muted">缺少任一前置检查或存在异常时，服务端挂起为待复核，检查补齐后自动对账</small>
          <button className="primary-action" disabled={!appointment} onClick={() => enqueue('check-in', { truckNo: appointment?.truckNo, driver: appointment?.driver })}>暂存签到</button>
        </div>
      </div>
      <div className="capture-actions">
        <button disabled={!appointment} onClick={enqueueAll}>模拟司机已完成全部检查：按顺序暂存四步</button>
        {problems.length > 0 && <button onClick={() => gateQueue.retryAll()}>全部挂起/冲突项重新送裁（{problems.length}）</button>}
        <button onClick={() => gateQueue.clearAccepted()}>清除本机已接受记录</button>
      </div>
    </div>

    <h3 className="queue-title">本机作业队列 <small>持久化在 localStorage，刷新页面/重启工位不丢失</small></h3>
    <div className="table gate-queue-table">
      <div className="tr th"><span>设备 / 序号</span><span>预约 / 步骤</span><span>采集内容</span><span>采集时间(设备)</span><span>状态 / 服务端裁决</span><span>操作</span></div>
      {state.items.length === 0 && <div className="tr empty-row"><span>队列为空。断网时登记的车检步骤会显示在这里。</span></div>}
      {state.items.map(item => {
        const apt = appointments.find(a => a.id === item.appointmentId);
        return <div className="tr" key={item.localId}>
          <span><b>{item.deviceId}</b><small>seq {item.seq} · 第 {item.attempts} 次发送</small></span>
          <span><b>{item.appointmentId}</b><small>{apt?.containerId ?? '预约参考已失效'} · {stepLabel[item.kind]}</small></span>
          <span>{payloadSummary(item.kind, item.payload)}</span>
          <span>{shortTime(item.recordedAt ?? item.clientAt)}{item.lastResult && item.lastResult.skewMs !== 0 && <small className={Math.abs(item.lastResult.skewMs) > 180000 ? 'critical' : 'muted'}>时钟差 {Math.round(item.lastResult.skewMs / 1000)}s</small>}</span>
          <span>
            <span className={`sync-pill ${item.localStatus}`}>{statusLabel[item.localStatus]}</span>
            {item.lastError && <small className="critical">{item.lastError}</small>}
            {item.lastResult?.reasons.map((reason, idx) => <small key={idx} className={reason.severity === 'warning' ? 'warning-text' : 'muted'}>
              {reason.severity === 'warning' ? '⛔ ' : 'ℹ '}{reason.message}{item.lastResult?.reconciledKey ? '' : ''}
            </small>)}
            {item.lastResult?.reconciledKey && <small className="ok-text">↳ 补齐了挂起签到 {item.lastResult.reconciledKey.slice(0, 16)}… 并自动放行</small>}
            {item.lastResult && <small className="muted">服务端：预约 {item.lastResult.appointmentStatus} · 箱 {item.lastResult.containerStatus}{item.lastResult.replayed ? ' · 幂等重放' : ''}</small>}
          </span>
          <span className="row-actions">
            {(item.localStatus === 'conflict' || item.localStatus === 'review' || item.localStatus === 'error') && <button onClick={() => gateQueue.retry(item.localId)}>重新送裁</button>}
            <button className="danger-action" onClick={() => gateQueue.remove(item.localId)}>移除</button>
          </span>
        </div>;
      })}
    </div>

    <h3 className="queue-title">服务端同步台账 <small>所有闸口设备的步骤裁决与审计依据（含被取代的旧读数）</small></h3>
    <div className="table gate-records-table">
      <div className="tr th"><span>接收时间</span><span>设备 / 序号</span><span>预约 / 箱号</span><span>步骤 / 结论</span><span>裁决原因</span></div>
      {records.length === 0 && <div className="tr empty-row"><span>还没有任何步骤上传到服务端。</span></div>}
      {records.map(record => <div className="tr" key={record.key}>
        <span><small>接收 {shortTime(record.receivedAt)}</small><small>采集 {shortTime(record.recordedAt ?? record.clientAt)}</small></span>
        <span><b>{record.deviceName ?? record.deviceId}</b><small>seq {record.seq} · 时钟差 {Math.round(record.skewMs / 1000)}s</small></span>
        <span><b>{record.appointmentId}</b><small>{record.containerId} · {stepLabel[record.kind]}</small></span>
        <span>
          <span className={`sync-pill ${record.status}`}>{record.status === 'accepted' ? '已接受' : record.status === 'conflict' ? '冲突' : '待人工'}</span>
          <small className="muted">{record.applied ? '已写入业务状态' : '未写入'}{record.supersededBy ? ' · 已被重采取代' : ''}</small>
          <small className="muted">预约 {record.appointmentStatus} · 箱 {record.containerStatus}</small>
        </span>
        <span>{record.reasons.map((reason, idx) => <small key={idx} className={reason.severity === 'warning' ? 'warning-text' : 'muted'}>{reason.severity === 'warning' ? '⛔ ' : 'ℹ '}{reason.message}</small>)}</span>
      </div>)}
    </div>
  </section>;
}
