import type { BuildOptions } from 'esbuild';

/**
 * 输入为本地Node进程/测试fixture的esbuild配置；返回新配置，不修改调用方的external数组。
 * unzipper的S3入口按需加载未声明的可选SDK，本地XLSX流程仅用本机数据；该SDK保留为
 * 运行时外部模块，不能因编译器提前解析而要求应用携带云端SDK。S3能力未交付。
 * 非Node配置直接拒绝；实际解析/构建错误仍由esbuild原样报告，不伪造构建成功。
 */
export function nodeBundleOptions<T extends BuildOptions>(
  options: T,
): Omit<T, 'external'> & { external: string[] } {
  if (options.platform !== 'node') throw new Error('Node bundle options require platform=node');
  return {
    ...options,
    external: [...new Set([...(options.external ?? []), '@aws-sdk/client-s3'])],
  };
}
