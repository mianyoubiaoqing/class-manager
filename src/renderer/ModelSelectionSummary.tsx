import { useEffect, useState } from 'react';
import type { ModelSettingsView } from '../shared/model-providers';

/** 本地只读当前选择，生成前核对供应商/型号；不读Key、不外发。 */
export function ModelSelectionSummary() {
  const [settings, setSettings] = useState<ModelSettingsView>(),
    [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.classManager
      .readModelSettings()
      .then((r) => {
        if (alive) {
          if (r.ok) setSettings(r.value);
          else setError(true);
        }
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const selected = settings?.providers.find((p) => p.provider === settings.selectedProvider);
  return (
    <p className="notice">
      {error
        ? '模型选择读取失败，请在模型设置刷新后核对。'
        : selected
          ? `当前生成供应商：${selected.label} · 文本 ${selected.textModel || '未配置'} · 图像 ${selected.visionModel || '未配置/禁用'} · ${selected.credentials.configured ? 'Key已本地保存，能力待验证' : '未配置Key'}`
          : '正在读取当前模型选择…'}
    </p>
  );
}
