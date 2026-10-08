import { useEffect, useState } from 'react';
import { ExternalLink, Plug, ShieldCheck, Check, X } from 'lucide-react';
import type { BridgeProposal, WorkBuddyRegistration } from '../../../shared/teaching-workbench';
import { TeachingDialog } from './TeachingDialog';
import { kindLabels, recordFields } from './record-fields';
import type { Snapshot } from '../../../shared/contracts';
export function WorkBuddyPanel({
  snapshot,
  onChanged,
  compact = false,
}: {
  snapshot?: Snapshot;
  onChanged?: () => void;
  compact?: boolean;
}) {
  const api = window.classManager;
  const [registration, setRegistration] = useState<WorkBuddyRegistration>();
  const [proposals, setProposals] = useState<BridgeProposal[]>([]),
    [open, setOpen] = useState(false),
    [configuration, setConfiguration] = useState(''),
    [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const r = await api.listBridgeProposals();
      if (alive && r.ok) setProposals(r.value);
      if (open) {
        const connection = await api.workBuddyConnection();
        if (alive && connection.ok) {
          setActive(connection.value.active);
          setConfiguration(connection.value.configuration);
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, open]);
  const pending = proposals.filter((p) => p.status === 'pending');
  async function connect(start = false) {
    setOpen(true);
    setError('');
    setBusy(true);
    try {
      if (start) {
        const r = await api.startWorkBuddyConnection();
        if (!r.ok) throw new Error(r.error.message);
        setRegistration(r.value);
        setActive(r.value.active);
      }
      const r = await api.workBuddyConnection();
      if (!r.ok) throw new Error(r.error.message);
      setConfiguration(r.value.configuration);
      setActive(r.value.active);
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function resolve(p: BridgeProposal, approve: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await api.resolveBridgeProposal({ id: p.id, approve });
      if (!r.ok) throw new Error(r.error.message);
      const list = await api.listBridgeProposals();
      if (list.ok) setProposals(list.value);
      if (r.value.status === 'succeeded') {
        onChanged?.();
        window.dispatchEvent(new CustomEvent('cm:bridgeChanged'));
      }
      if (r.value.status === 'failed')
        setError('方案未执行成功，请查看结果；先刷新数据再让 WorkBuddy 提出新方案。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '处理失败。');
    } finally {
      setBusy(false);
    }
  }
  function proposalSummary(p: BridgeProposal) {
    const input = p.input as {
      kind?: keyof typeof kindLabels;
      content?: Record<string, unknown>;
      classId?: string;
      id?: string;
      displayName?: string;
      studentNumber?: string;
      active?: boolean;
    };
    const classroom = snapshot?.classes.find((c) => c.id === input.classId)?.name;
    const student = snapshot?.students.find((s) => s.id === (input.content?.studentId ?? input.id));
    return (
      <>
        <h3>
          {p.tool === 'propose_delete_record'
            ? '删除 / 恢复记录'
            : p.tool === 'propose_student'
              ? '保存学生'
              : p.tool === 'propose_student_status'
                ? `${input.active ? '恢复' : '停用'}学生`
                : input.kind
                  ? `${input.id ? '修改' : '新增'}${kindLabels[input.kind]}`
                  : '数据修改'}
        </h3>
        <p>
          {p.preview?.className} {p.preview?.studentName}
          {classroom ?? ''} {student?.displayName ?? input.displayName ?? ''}{' '}
          {input.studentNumber ?? ''}
        </p>
        {input.kind && input.content ? (
          <dl>
            {recordFields[input.kind]
              .filter((f) => f.key !== 'studentId')
              .map((f) => (
                <div key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>
                    {typeof input.content?.[f.key] === 'boolean'
                      ? input.content[f.key]
                        ? '是'
                        : '否'
                      : (f.options?.find(([v]) => v === input.content?.[f.key])?.[1] ??
                        String(input.content?.[f.key] ?? ''))}
                  </dd>
                </div>
              ))}
          </dl>
        ) : null}
        <details>
          <summary>查看完整方案及版本号</summary>
          <pre>{JSON.stringify(p.input, null, 2)}</pre>
          {p.preview?.before != null && (
            <>
              <b>修改前的记录</b>
              <pre>{JSON.stringify(p.preview.before, null, 2)}</pre>
            </>
          )}
        </details>
      </>
    );
  }
  return (
    <div className={compact ? 'tw-bridge compact' : 'tw-bridge'}>
      <button
        onClick={() =>
          void api.openWorkBuddy().then((r) => {
            if (!r.ok) setError(r.error.message);
          })
        }
      >
        <ExternalLink size={16} />
        前往 WorkBuddy
      </button>
      <button disabled={busy} onClick={() => void connect(pending.length === 0)}>
        <Plug size={16} />
        {pending.length ? `待确认方案 ${pending.length}` : '开始连接'}
      </button>
      {error && !open && <span role="alert">{error}</span>}
      {open && (
        <TeachingDialog title="WorkBuddy 桥接与确认" busy={busy} onClose={() => setOpen(false)}>
          <p className="tw-hint">
            <ShieldCheck size={16} />
            WorkBuddy 可直接查询本机资料；新增、修改和删除须在这里由你确认。程序保持开启才能连接。
          </p>
          <h3>待确认方案（{pending.length}）</h3>
          {!pending.length && <p className="tw-hint">暂无待确认方案。</p>}
          {pending.map((p) => (
            <article className="tw-proposal" key={p.id}>
              {proposalSummary(p)}
              <div className="tw-actions">
                <button disabled={busy} onClick={() => void resolve(p, false)}>
                  <X size={16} />
                  拒绝
                </button>
                <button disabled={busy} className="primary" onClick={() => void resolve(p, true)}>
                  <Check size={16} />
                  确认执行
                </button>
              </div>
            </article>
          ))}
          <details>
            <summary>已处理方案</summary>
            {proposals
              .filter((p) => p.status !== 'pending')
              .map((p) => (
                <article className="tw-mini" key={p.id}>
                  <b>{p.tool}</b> ·{' '}
                  {
                    {
                      executing: '执行中',
                      succeeded: '已执行',
                      failed: '执行失败',
                      rejected: '已拒绝',
                      expired: '已过期',
                      pending: '待确认',
                    }[p.status]
                  }
                  {p.result !== undefined && <pre>{JSON.stringify(p.result, null, 2)}</pre>}
                </article>
              ))}
          </details>
          <h3>连接 WorkBuddy</h3>
          <p role="status">
            {busy
              ? '正在检测并注册…'
              : active
                ? '已检测到本地连接'
                : registration?.registered
                  ? '本机 MCP 已注册，等待 WorkBuddy 连接'
                  : registration && !registration.installed
                    ? '未检测到 WorkBuddy 桌面端'
                    : '点击开始连接，自动检测桌面端并注册本机服务。'}
          </p>
          {registration?.registered && !active && (
            <div className="tw-card">
              <p>
                已完成配置，无需复制代码。请在 WorkBuddy 中登录自己的账号，在“插件 → MCP
                服务器”中首次授权 class-manager 服务。
              </p>
              {registration.firstRegistration && (
                <p>若服务列表暂未显示，请先保存 WorkBuddy 中的工作，再退出并重新打开它。</p>
              )}
              <p>授权后试着询问：“查询本地班级名单”。本页会自动更新连接状态。</p>
            </div>
          )}
          {registration && !registration.installed && (
            <p>请先通过“前往 WorkBuddy”下载安装桌面端并登录，再点击开始连接。</p>
          )}
          {registration?.launchError && <p role="alert">{registration.launchError}</p>}
          <button className="primary" disabled={busy} onClick={() => void connect(true)}>
            {registration?.registered ? '重新检测并注册' : '开始连接'}
          </button>
          <p className="tw-hint">
            无需安装 Node.js 或填写模型 API Key。账号及平台额度由 WorkBuddy
            提供；本工作台需保持开启。
          </p>
          <details>
            <summary>高级连接信息与手动配置</summary>
            {registration?.configurationPath && <p>配置位置：{registration.configurationPath}</p>}
            {registration?.backupPath && <p>原配置备份：{registration.backupPath}</p>}
            <textarea
              readOnly
              aria-label="WorkBuddy MCP 配置"
              rows={10}
              value={configuration}
              onFocus={(e) => e.target.select()}
            />
            <p>
              非标准安装位置可在 WorkBuddy 的 MCP
              设置中添加此配置。更换程序位置或数据目录后，重新点击开始连接。
            </p>
          </details>
          <details>
            <summary>群通知接口</summary>
            <p>
              用 teaching_records 查询 kind=notice；用 propose_teaching_record
              提交通知草稿，经本地确认后保存。返回的是草稿，没有实际群发送状态。第三方可对接这些 MCP
              接口；接入发送渠道后才增加实际发送回执。
            </p>
          </details>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button disabled={busy} onClick={() => void connect()}>
              刷新连接信息
            </button>
            <button disabled={busy} className="primary" onClick={() => setOpen(false)}>
              完成
            </button>
          </footer>
        </TeachingDialog>
      )}
    </div>
  );
}
