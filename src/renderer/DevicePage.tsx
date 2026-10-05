import { useEffect, useRef, useState } from 'react';
import type { Result, Snapshot } from '../shared/contracts';
import type { DeviceStatus, DeviceStatuses, NoiseResult, StudentCallView } from '../shared/devices';
import './devices.css';

const statusText = (status: DeviceStatus | undefined) =>
  !status
    ? '读取中'
    : status.state === 'not_connected'
      ? '未接入'
      : status.state === 'fault'
        ? '故障'
        : status.mode === 'synthetic'
          ? '就绪（合成测试）'
          : '就绪';
const callStage = {
  unavailable: '不可执行，未接入',
  accepted: '通道已受理，正在传输',
  delivered: '已获得送达回执',
  failed: '通道明确失败',
  cancelled: '已获得取消回执',
  unknown: '结果不明，请查询原操作',
};

/** 仅教师外设视图；默认不采集、不发送，测试数据须显式标识，取消不冒充实际撤销。 */
export function DevicePage({
  snapshot,
  onDirtyChange,
  navigationBusy,
}: {
  snapshot: Snapshot;
  onDirtyChange: (dirty: boolean) => void;
  navigationBusy: boolean;
}) {
  const api = window.classManager;
  const [statuses, setStatuses] = useState<DeviceStatuses>();
  const [studentId, setStudentId] = useState(snapshot.students.find((s) => s.active)?.id ?? '');
  const [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [synthetic, setSynthetic] = useState(false);
  const [purpose, setPurpose] = useState<'reading' | 'ambient'>('reading');
  const [noise, setNoise] = useState<NoiseResult>(),
    [call, setCall] = useState<StudentCallView>();
  const [lastCallId, setLastCallId] = useState<string>(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string>();
  const running = useRef(false),
    alive = useRef(true),
    task = useRef<{ kind: 'noise' | 'call'; operationId: string } | undefined>(undefined);
  useEffect(() => {
    onDirtyChange(busy || !!reason || reviewed || synthetic);
  }, [busy, reason, reviewed, synthetic, onDirtyChange]);
  useEffect(() => {
    alive.current = true;
    void api
      .readDeviceStatus({ epoch: snapshot.epoch })
      .then((result) => {
        if (!alive.current) return;
        if (result.ok) setStatuses(result.value);
        else
          setMessage(
            `${result.error.message}（${result.error.code} · ${result.error.operationId}）`,
          );
      })
      .catch(() => {
        if (alive.current) setMessage('外设状态读取中断，请刷新状态。');
      });
    return () => {
      alive.current = false;
      onDirtyChange(false);
      if (task.current)
        void api.cancelDeviceTask({ epoch: snapshot.epoch, ...task.current }).catch(() => {});
    };
  }, [api, snapshot.epoch, onDirtyChange]);
  async function run<T>(work: () => Promise<Result<T>>, accept: (result: T) => void) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await work();
      if (!alive.current) return;
      if (result.ok) accept(result.value);
      else
        setMessage(`${result.error.message}（${result.error.code} · ${result.error.operationId}）`);
    } catch {
      if (alive.current) setMessage('返回中断，请先查询原呼叫结果，不要以新操作ID重发。');
    } finally {
      running.current = false;
      task.current = undefined;
      if (alive.current) setBusy(false);
    }
  }
  const student = snapshot.students.find((s) => s.id === studentId);
  const blocked = busy || navigationBusy;
  return (
    <div className="device-page">
      <p className="notice">两类外设当前均未接入。本页不采集音频、不发送真实学生通知。</p>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <button
        disabled={blocked}
        onClick={() => void run(() => api.readDeviceStatus({ epoch: snapshot.epoch }), setStatuses)}
      >
        刷新外设状态
      </button>
      <section className="device-panel" aria-label="音量监测">
        <h2>音量监测</h2>
        <p>状态：{statusText(statuses?.noise)}</p>
        {statuses?.noise && statuses.noise.state !== 'ready' && <p>{statuses.noise.message}</p>}
        <label>
          测量用途
          <select
            aria-label="测量用途"
            value={purpose}
            disabled={blocked}
            onChange={(e) => setPurpose(e.target.value === 'ambient' ? 'ambient' : 'reading')}
          >
            <option value="reading">读书音量</option>
            <option value="ambient">环境噪声音量</option>
          </select>
        </label>
        <p>
          未校准的相对幅度不能称为声压级；音量本身不能证明声音来源或课堂纪律。当前没有现场数值或告警。
        </p>
        <button
          disabled={blocked}
          onClick={() => {
            const operationId = crypto.randomUUID();
            task.current = { kind: 'noise', operationId };
            void run(
              () =>
                api.measureNoise({ epoch: snapshot.epoch, operationId, purpose, durationMs: 1000 }),
              setNoise,
            );
          }}
        >
          请求一次音量测量
        </button>
        {noise && (
          <div role="status">
            操作 {noise.operationId}：
            {noise.status === 'unavailable' ? (
              `不可测量 · ${noise.message}（${noise.code}）`
            ) : (
              <>
                <strong>
                  {noise.sample.mode === 'synthetic' ? '合成测试样本 · ' : ''}
                  {noise.sample.unit === 'relative_amplitude'
                    ? `相对幅度 ${noise.sample.value}`
                    : `声压级 ${noise.sample.value} dB SPL`}
                </strong>
                <p>
                  {noise.sample.observedAt} · {noise.sample.durationMs}ms
                </p>
                {noise.sample.unit === 'db_spl' && <p>校准：{noise.sample.calibration}</p>}
              </>
            )}
          </div>
        )}
      </section>
      <section className="device-panel" aria-label="呼叫学生">
        <h2>呼叫学生</h2>
        <p>状态：{statusText(statuses?.calling)}</p>
        {statuses?.calling && statuses.calling.state !== 'ready' && (
          <p>{statuses.calling.message}</p>
        )}
        <label>
          呼叫目标
          <select
            aria-label="呼叫目标"
            disabled={blocked}
            value={studentId}
            onChange={(e) => {
              setStudentId(e.target.value);
              setReviewed(false);
            }}
          >
            {snapshot.students
              .filter((s) => s.active && s.classId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.studentNumber} {s.displayName}
                </option>
              ))}
          </select>
        </label>
        <label>
          呼叫说明
          <input
            aria-label="呼叫说明"
            maxLength={200}
            disabled={blocked}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setReviewed(false);
            }}
          />
        </label>
        <label className="device-check">
          <input
            type="checkbox"
            disabled={blocked}
            checked={synthetic}
            onChange={(e) => setSynthetic(e.target.checked)}
          />
          确认仅使用合成名册，不发送真实学生信息
        </label>
        <label className="device-check">
          <input
            type="checkbox"
            disabled={blocked}
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          已核对目标学生和说明，明确确认本次呼叫请求
        </label>
        <button
          disabled={
            blocked ||
            !student?.active ||
            !reason.trim() ||
            !reviewed ||
            !synthetic ||
            (!!lastCallId && !call) ||
            call?.outcome.stage === 'accepted' ||
            call?.outcome.stage === 'unknown'
          }
          onClick={() => {
            if (!student) return;
            const operationId = crypto.randomUUID();
            setLastCallId(operationId);
            setCall(undefined);
            task.current = { kind: 'call', operationId };
            void run(
              () =>
                api.requestStudentCall({
                  epoch: snapshot.epoch,
                  operationId,
                  studentId,
                  expectedStudentRevision: student.revision,
                  reason,
                  acknowledgeTeacherReviewed: true,
                  acknowledgeSyntheticOnly: true,
                }),
              (view) => {
                setCall(view);
                setReason('');
                setReviewed(false);
                setSynthetic(false);
              },
            );
          }}
        >
          确认请求呼叫
        </button>
        <button
          disabled={blocked || !lastCallId}
          onClick={() =>
            void run(
              () => api.readStudentCall({ epoch: snapshot.epoch, operationId: lastCallId! }),
              (view) => {
                if (view) setCall(view);
                else setMessage('未查到原操作回执；这不证明未发送，不要自动重发。');
              },
            )
          }
        >
          查询原呼叫结果
        </button>
        <button
          disabled={blocked}
          onClick={() => {
            setReason('');
            setReviewed(false);
            setSynthetic(false);
          }}
        >
          清空呼叫输入
        </button>
        {call && (
          <div role="status">
            <p>
              操作 {call.operationId} · 呼叫目标{' '}
              {snapshot.students.find((s) => s.id === call.studentId)?.studentNumber}{' '}
              {snapshot.students.find((s) => s.id === call.studentId)?.displayName ??
                call.studentId}{' '}
              / 修订 {call.studentRevision}
            </p>
            <p>
              {call.synthetic ? '合成测试回执 · ' : ''}
              {callStage[call.outcome.stage]}
            </p>
            {'message' in call.outcome ? (
              <p>{call.outcome.message}</p>
            ) : (
              <p>
                回执 {call.outcome.receiptId} · {call.outcome.observedAt}
              </p>
            )}
          </div>
        )}
        <p>
          请求建立、通道受理和学生实际收到是不同状态。未接入结果不会显示送达；取消或超时也不能证明未发送。当前未接入结果只保留于本次会话。
        </p>
      </section>
      {(task.current ||
        call?.outcome.stage === 'accepted' ||
        call?.outcome.stage === 'unknown') && (
        <button
          onClick={() => {
            const current =
              task.current ??
              (lastCallId ? { kind: 'call' as const, operationId: lastCallId } : undefined);
            if (!current) return;
            void api
              .cancelDeviceTask({ epoch: snapshot.epoch, ...current })
              .then((result) => {
                if (alive.current)
                  setMessage(
                    result.ok
                      ? result.value.message
                      : `${result.error.message}（${result.error.code} · ${result.error.operationId}）`,
                  );
              })
              .catch(() => {
                if (alive.current) setMessage('取消返回中断，请查询原呼叫结果。');
              });
          }}
        >
          请求取消外设操作
        </button>
      )}
    </div>
  );
}
