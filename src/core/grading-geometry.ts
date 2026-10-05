import { createHash } from 'node:crypto';
import type { GradingPage, GradingRectangle, GradingTransform } from '../shared/grading';

/** 指纹绑定原图字节和整个变换命令；不进行文件或网络操作。 */
export function gradingTransformHash(inputHash: string, transform: GradingTransform) {
  return createHash('sha256').update(JSON.stringify({ inputHash, transform })).digest('hex');
}

/**
 * 标准化原图坐标换成向外取整的像素区域，确保遮盖不会留下边缘像素。
 * 调用方须先校验矩形和正整数尺寸；无文件、解码、网络或持久化副作用。
 */
export function gradingPixelRectangle(rectangle: GradingRectangle, width: number, height: number) {
  const left = Math.floor(rectangle.x * width);
  const top = Math.floor(rectangle.y * height);
  const right = Math.min(width, Math.ceil((rectangle.x + rectangle.width) * width));
  const bottom = Math.min(height, Math.ceil((rectangle.y + rectangle.height) * height));
  return { left, top, width: right - left, height: bottom - top };
}

/** 实际裁剪按整像素向外取整；证据映射与外发预览必须使用同一有效区域。 */
export function gradingEffectiveCrop(page: GradingPage, width: number, height: number) {
  return gradingEffectiveRectangle(page.crop, width, height);
}

/** 遮盖判定也使用向外取整后的实际区域，不能把已涂黑的边缘像素当作可读证据。 */
export function gradingEffectiveRectangle(
  rectangle: GradingRectangle,
  width: number,
  height: number,
) {
  const crop = gradingPixelRectangle(rectangle, width, height);
  return {
    x: crop.left / width,
    y: crop.top / height,
    width: crop.width / width,
    height: crop.height / height,
  };
}
