import type {
  CallOutcome,
  DeviceStatus,
  NoiseRequest,
  NoiseSample,
  StudentCallRequest,
  StoredCall,
} from '../shared/devices';
import { DomainError } from './errors';

/** 外设查询与采样 seam：校验输入后才调用。量纲必须显式；声压级必须有校准说明。
 * signal取消是停止请求，不保证设备动作已撤销；不得根据音量推断声音来源或纪律。 */
export interface NoiseMonitorAdapter {
  status(signal: AbortSignal): Promise<DeviceStatus>;
  measure(input: NoiseRequest, signal: AbortSignal): Promise<NoiseSample>;
}
/** 呼叫 seam：operationId是协议幂等键，Adapter须在实际通道持久去重并允许按ID查询。
 * accepted仅指通道受理，delivered必须是确定的送达回执；取消/超时不证明未发送。
 * 不自动重试。实现必须遵守signal并可查询晚到结果，身份和教师确认由业务模块先校验。 */
export interface StudentCallAdapter {
  status(signal: AbortSignal): Promise<DeviceStatus>;
  request(input: StudentCallRequest, signal: AbortSignal): Promise<CallOutcome>;
  read(operationId: string, signal: AbortSignal): Promise<StoredCall | null>;
  cancel(operationId: string, signal: AbortSignal): Promise<CallOutcome>;
}
function active(signal: AbortSignal) {
  if (signal.aborted) throw new DomainError('DEVICE_CANCELLED', '外设请求已取消。');
}
/** 默认发布实现无硬件权限、采集或网络，不创建测量样本。 */
export class DisconnectedNoiseMonitor implements NoiseMonitorAdapter {
  async status(signal: AbortSignal): Promise<DeviceStatus> {
    active(signal);
    return { state: 'not_connected', message: '音量监测未接入，不能采样或生成噪音告警。' };
  }
  async measure(_input: NoiseRequest, signal: AbortSignal): Promise<NoiseSample> {
    active(signal);
    throw new DomainError('DEVICE_NOT_CONNECTED', '音量监测未接入，没有可用测量。');
  }
}
/** 默认发布实现明确未接入，呼叫既未受理也未送达。 */
export class DisconnectedStudentCall implements StudentCallAdapter {
  async status(signal: AbortSignal): Promise<DeviceStatus> {
    active(signal);
    return { state: 'not_connected', message: '呼叫通道未接入，不能向学生发送或送达通知。' };
  }
  async request(_input: StudentCallRequest, signal: AbortSignal): Promise<CallOutcome> {
    active(signal);
    return { stage: 'unavailable', message: '呼叫通道未接入，本次不可执行，未受理、未送达。' };
  }
  async read(_operationId: string, signal: AbortSignal): Promise<StoredCall | null> {
    active(signal);
    return null;
  }
  async cancel(_operationId: string, signal: AbortSignal): Promise<CallOutcome> {
    active(signal);
    return { stage: 'unavailable', message: '呼叫通道未接入，没有可撤销的发送。' };
  }
}
