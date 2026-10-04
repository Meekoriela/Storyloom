import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";

/**
 * 把本地图片降采样到指定宽度并写回原路径（覆盖）。
 * 用途：封面 / 头像选图后落盘前压尺寸，消除全分辨率解码的内存峰值（闪退根因）。
 * 返回是否实际发生了降采样。
 *
 * 写回走File 类的 move：expo-file-system 顶层虽然仍导出 moveAsync / deleteAsync，
 * 但那是 deprecated 别名，调用即抛错，只能用 File 的方法。
 */
export async function downsampleToFile(uri: string, width: number, quality = 0.85): Promise<boolean> {
  const result = await manipulateAsync(
    uri,
    [{ resize: { width } }],
    { compress: quality, format: SaveFormat.JPEG },
  );
  const resized = new File(result.uri);
  // move 成功即已覆盖原路径；失败（多为原图本来就比目标小）时把临时文件清掉，别留在缓存目录里。
  try {
    resized.move(new File(uri));
    return true;
  } catch {
    try {
      if (resized.exists) resized.delete();
    } catch {}
    return false;
  }
}
