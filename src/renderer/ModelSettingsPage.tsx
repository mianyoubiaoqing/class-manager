import { useEffect, useRef, useState } from 'react';
import type { Result } from '../shared/contracts';
import type {
  ModelSettingsView,
  ModelProviderId,
  ModelCheckPreparation,
  ModelCheckReceipt,
  ModelLedgerView,
} from '../shared/model-providers';
import './devices.css';
import { WorkspaceTabs } from './WorkspaceTabs';

/** 供应商设置仅保存本地配置；检查先预览确切合成内容，确认后单次外发，不自动检测或回退。 */
export function ModelSettingsPage({
  onDirtyChange,
  onLegacy,
  onDiagnostics,
}: {
  onDirtyChange: (dirty: boolean) => void;
  onLegacy: () => void;
  onDiagnostics?: () => void;
}) {
  const api = window.classManager;
  const [settings, setSettings] = useState<ModelSettingsView>(),
    [provider, setProvider] = useState<ModelProviderId>('kimi');
  const [textModel, setTextModel] = useState(''),
    [visionModel, setVisionModel] = useState(''),
    [key, setKey] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [tab, setTab] = useState<'configuration' | 'connection' | 'usage'>('configuration');
  const [overview, setOverview] = useState(true);
  const [prepared, setPrepared] = useState<ModelCheckPreparation>(),
    [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<ModelCheckReceipt>(),
    [ledger, setLedger] = useState<ModelLedgerView>();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string>();
  const running = useRef(false),
    alive = useRef(true);
  const view = settings?.providers.find((p) => p.provider === provider);
  const dirty =
    !!key ||
    !!prepared ||
    busy ||
    (!!view &&
      (textModel !== view.textModel ||
        visionModel !== view.visionModel ||
        contextWindow !== String(view.contextWindowTokens ?? '')));
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  function accept(next: ModelSettingsView, edit: ModelProviderId = provider) {
    setSettings(next);
    setProvider(edit);
    const item = next.providers.find((p) => p.provider === edit)!;
    setTextModel(item.textModel);
    setVisionModel(item.visionModel);
    setContextWindow(String(item.contextWindowTokens ?? ''));
    setKey('');
    setPrepared(undefined);
    setConfirmed(false);
    setReceipt(undefined);
    setLedger(undefined);
  }
  async function run<T>(work: () => Promise<Result<T>>, after: (value: T) => void) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await work();
      if (!alive.current) return;
      if (result.ok) after(result.value);
      else
        setMessage(`${result.error.message}（${result.error.code} · ${result.error.operationId}）`);
    } catch {
      if (alive.current) setMessage('请求未响应，请检查网络或刷新本地状态后再试。');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void run(
      () => api.readModelSettings(),
      (next) => accept(next, 'kimi'),
    );
    return () => {
      alive.current = false;
      onDirtyChange(false);
      void api.cancelModelCheck().catch(() => {});
    };
    // 本页首次读取后，选择/保存通过具名操作更新状态。
  }, []);
  const selected = settings?.providers.find((p) => p.provider === settings.selectedProvider);
  if (overview)
    return (
      <div className="model-overview">
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <section className="design-panel model-current">
          <header>
            <div>
              <h2>当前连接</h2>
              <p>
                {selected?.credentials.configured
                  ? `${selected.label} · ${selected.textModel || '尚未设置型号'}`
                  : '未连接模型服务'}
              </p>
            </div>
            <span className="connection-status">
              {selected?.credentials.configured ? '已配置，待检查' : '等待连接'}
            </span>
          </header>
          <p>连接后，可使用智能对话、备课生成与答卷建议。</p>
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() => {
                if (settings) accept(settings, settings.selectedProvider);
                setTab('connection');
                setOverview(false);
              }}
            >
              检查连接
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setTab('configuration');
                setOverview(false);
              }}
            >
              交付人员设置
            </button>
          </div>
        </section>
        <section className="design-panel model-usage">
          <h2>使用状态</h2>
          <p>显示本机配置状态，连接检查由你确认后执行。</p>
          <dl>
            <div>
              <dt>服务提供方</dt>
              <dd>{selected?.label ?? '—'}</dd>
            </div>
            <div>
              <dt>模型名称</dt>
              <dd>{selected?.textModel || '—'}</dd>
            </div>
            <div>
              <dt>账号状态</dt>
              <dd>{selected?.credentials.configured ? '密钥已加密保存在本机' : '尚未配置'}</dd>
            </div>
          </dl>
          <button
            disabled={busy}
            onClick={() => {
              if (settings) accept(settings, settings.selectedProvider);
              setTab('usage');
              setOverview(false);
            }}
          >
            查看本机用量记录
          </button>
          <p className="model-overview-footnote">连接失败时，业务资料仍保存在本机。</p>
        </section>
        <aside className="design-panel model-help">
          <h2>遇到问题？</h2>
          <p>按提示完成检查。</p>
          <ol>
            <li>确认电脑可以联网</li>
            <li>点击检查连接</li>
            <li>导出诊断交给交付人员</li>
          </ol>
          <button disabled={busy} onClick={onDiagnostics}>
            查看诊断入口
          </button>
        </aside>
      </div>
    );
  return (
    <div className="device-page model-settings-detail">
      <button disabled={dirty} onClick={() => setOverview(true)}>
        返回连接概览
      </button>
      <p
        className="notice"
        style={{
          background: 'var(--primary-subtle)',
          borderColor: 'rgba(23,122,98,0.2)',
          color: 'var(--text-secondary)',
        }}
      >
        配置助教使用的模型账号。密钥加密保存在本机。
      </p>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {settings && (
        <p>
          当前供应商：
          {settings.providers.find((p) => p.provider === settings.selectedProvider)?.label} ·
          {settings.providers.find((p) => p.provider === settings.selectedProvider)?.textModel}
        </p>
      )}
      <WorkspaceTabs
        id="models"
        label="模型设置分类"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'configuration', label: '账号与模型' },
          { value: 'connection', label: '连接检查' },
          { value: 'usage', label: '用量记录' },
        ]}
      />
      <section
        className="device-panel"
        aria-label="供应商配置"
        role="tabpanel"
        id="models-configuration-panel"
        aria-labelledby="models-configuration-tab"
        hidden={tab !== 'configuration'}
      >
        <h2>供应商配置</h2>
        <label>
          编辑供应商
          <select
            aria-label="编辑供应商"
            value={provider}
            disabled={dirty || busy}
            onChange={(e) => {
              if (settings) accept(settings, e.target.value as ModelProviderId);
            }}
          >
            <option value="kimi">Kimi</option>
            <option value="doubao">豆包</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </label>
        <p className="workspace-muted">
          账号状态：{view?.credentials.configured ? '已保存在本机' : '尚未配置'}{' '}
          {view?.credentials.maskedKey}
        </p>
        <details className="workspace-disclosure">
          <summary>接口与能力详情</summary>
          <p>API地址：{view?.baseUrl}</p>
          <p>
            账号状态：{view?.credentials.configured ? '已本地保存，调用权限待验证' : '未配置Key'}{' '}
            {view?.credentials.maskedKey}
          </p>
        </details>
        <p>
          文本能力：{view?.capabilities.text === 'unconfigured' ? '型号未配置' : '未验证'}
          ；图像能力：
          {view?.capabilities.vision === 'disabled' ? '未配置，图像调用已禁用' : '未验证'}
        </p>
        <label>
          文本模型 / Endpoint ID
          <input
            aria-label="文本模型 / Endpoint ID"
            value={textModel}
            maxLength={160}
            disabled={busy || !!prepared}
            onChange={(e) => setTextModel(e.target.value)}
          />
        </label>
        <details className="workspace-disclosure">
          <summary>高级模型设置</summary>
          <div className="workspace-fields">
            <label>
              图像模型 / Endpoint ID
              <input
                aria-label="图像模型 / Endpoint ID"
                value={visionModel}
                maxLength={160}
                disabled={busy || !!prepared}
                onChange={(e) => setVisionModel(e.target.value)}
              />
            </label>
            {provider === 'kimi' && (
              <p>
                Kimi支持kimi-k2.6和kimi-k3。K3始终思考，检查也可能产生思考Token；K2.6按非思考模式请求。
              </p>
            )}
            <label>
              模型上下文容量（Token，可留空）
              <input
                aria-label="模型上下文容量"
                type="number"
                min={32768}
                max={1000000}
                value={contextWindow}
                disabled={busy || !!prepared}
                onChange={(e) => setContextWindow(e.target.value)}
              />
            </label>
            <p>
              对话总预算为300K，达到90%时自动整理较早对话。请按供应商说明填写容量；Kimi
              K2.6按256K、K3按300K预算使用，豆包未填写时按32K使用。
            </p>
            {provider === 'doubao' && (
              <p>
                请填写火山方舟账号已开通的Model或Endpoint
                ID；图像栏仅填写确认支持图像的型号。留空会拒绝图片外发。
              </p>
            )}
          </div>
        </details>
        <label>
          供应商 API Key
          <input
            type="password"
            autoComplete="off"
            aria-label="供应商 API Key"
            value={key}
            maxLength={200}
            disabled={busy || !!prepared}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <p className="workspace-muted">请直接在这里输入密钥，勿发到聊天中。备份不包含模型账号。</p>
        <div className="workspace-actions">
          <button
            className="primary"
            disabled={busy || !settings || !textModel.trim() || !!prepared}
            onClick={() =>
              void run(
                () =>
                  api.configureModelProvider({
                    provider,
                    expectedRevision: settings!.revision,
                    textModel,
                    visionModel,
                    ...(contextWindow ? { contextWindowTokens: Number(contextWindow) } : {}),
                  }),
                (next) => {
                  accept(next);
                  setMessage('供应商型号已本地保存，尚未调用模型。');
                },
              )
            }
          >
            保存供应商型号
          </button>
          <button
            className="primary"
            disabled={busy || !key.trim() || !!prepared}
            onClick={() =>
              void run(
                () => api.saveModelProviderKey({ provider, apiKey: key }),
                (next) => {
                  accept(next);
                  setMessage('供应商Key已本地加密保存，未自动检查。');
                },
              )
            }
          >
            保存供应商Key
          </button>
          <button
            disabled={busy || !view?.credentials.configured || !!prepared}
            onClick={() =>
              void run(
                () => api.deleteModelProviderKey({ provider }),
                (next) => {
                  accept(next);
                  setMessage('供应商Key已删除，用量和历史保留。');
                },
              )
            }
          >
            删除此供应商Key
          </button>
          <button
            disabled={dirty || busy || !settings}
            onClick={() =>
              void run(
                () => api.selectModelProvider({ provider, expectedRevision: settings!.revision }),
                (next) => {
                  accept(next);
                  setMessage('当前模型供应商已切换，旧准备和请求已失效。');
                },
              )
            }
          >
            使用此供应商
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void run(
                () => api.cancelModelCheck(),
                () => {
                  if (settings) accept(settings);
                  setMessage('未保存输入与检查准备已清空。');
                },
              );
            }}
          >
            清空未保存输入
          </button>
          <button
            disabled={dirty || busy}
            onClick={() => void run(() => api.readModelSettings(), accept)}
          >
            刷新模型设置
          </button>
        </div>
      </section>
      <section
        className="device-panel"
        aria-label="单次连接检查"
        role="tabpanel"
        id="models-connection-panel"
        aria-labelledby="models-connection-tab"
        hidden={tab !== 'connection'}
      >
        <h2>单次连接检查</h2>
        <p>
          检查使用当前供应商，每次可能计费。无自动重试、无跨供应商回退；图像检查只有一张合成1×1图片，不包含学生材料。
        </p>
        <button
          disabled={dirty || busy || !settings}
          onClick={() =>
            void run(
              () => api.prepareModelCheck({ type: 'text', expectedRevision: settings!.revision }),
              (value) => {
                setPrepared(value);
                setConfirmed(false);
                setReceipt(undefined);
              },
            )
          }
        >
          预览文本检查外发
        </button>
        <button
          disabled={dirty || busy || !settings}
          onClick={() =>
            void run(
              () => api.prepareModelCheck({ type: 'vision', expectedRevision: settings!.revision }),
              (value) => {
                setPrepared(value);
                setConfirmed(false);
                setReceipt(undefined);
              },
            )
          }
        >
          预览图像检查外发
        </button>
        {prepared && (
          <div>
            <p>
              供应商 {prepared.provider} · 模型 {prepared.model}
            </p>
            <p>接收地址 {prepared.endpoint}</p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{prepared.body}</pre>
            <label className="device-check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已核对实际外发内容，明确确认本次可能付费检查
            </label>
            <button
              disabled={busy || !confirmed}
              onClick={() => {
                const current = prepared;
                setPrepared(undefined);
                setConfirmed(false);
                void run(
                  () =>
                    api.checkModelProvider({
                      token: current.token,
                      revision: current.revision,
                      wireHash: current.wireHash,
                      acknowledgeOutboundPreview: true,
                    }),
                  (value) => {
                    setReceipt(value);
                    setMessage('接口连通性检查完成。');
                  },
                );
              }}
            >
              确认本次检查外发
            </button>
          </div>
        )}
        {(busy || prepared) && (
          <button
            onClick={() =>
              void api
                .cancelModelCheck()
                .then((result) => {
                  if (!alive.current) return;
                  if (result.ok) {
                    setPrepared(undefined);
                    setConfirmed(false);
                    setMessage('已请求取消，请先核对原调用用量。');
                  } else
                    setMessage(
                      `${result.error.message}（${result.error.code} · ${result.error.operationId}）`,
                    );
                })
                .catch(() => {
                  if (alive.current) setMessage('操作已取消。');
                })
            }
          >
            取消检查或准备
          </button>
        )}
        {receipt && (
          <p role="status">
            {receipt.provider} · {receipt.result.type === 'text' ? '文本' : '图像'} ·{' '}
            {receipt.result.message} · 用量 {receipt.result.usage?.totalTokens ?? '未知'}
          </p>
        )}
      </section>
      <section
        className="device-panel"
        aria-label="供应商用量"
        role="tabpanel"
        id="models-usage-panel"
        aria-labelledby="models-usage-tab"
        hidden={tab !== 'usage'}
      >
        <h2>供应商用量</h2>
        <button
          disabled={busy}
          onClick={() => void run(() => api.readModelLedger({ provider }), setLedger)}
        >
          读取此供应商用量
        </button>
        {ledger && (
          <>
            <p>
              {ledger.provider} · 调用 {ledger.summary.totalCalls} · 已知Token{' '}
              {ledger.summary.totalTokens}（缺失用量不计入合计）
            </p>
            {ledger.summary.recentEntries.map((entry) => (
              <p key={entry.id}>
                操作 {entry.id} · {entry.type} · {entry.requestModel} · {entry.status} · Token{' '}
                {entry.usage?.totalTokens ?? '未知'}
              </p>
            ))}
          </>
        )}
      </section>
      <details className="workspace-disclosure" hidden={tab !== 'configuration'}>
        <summary>兼容与维护</summary>
        <button disabled={dirty || busy} onClick={onLegacy}>
          打开DeepSeek兼容设置
        </button>
      </details>
    </div>
  );
}
