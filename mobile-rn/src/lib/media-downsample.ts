import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";

/**
 * 把本地图片压到指定宽度，**另写一个新文件**（与原图同目录），返回新文件的 uri；失败返回 null。
 * 用途：封面 / 头像选图后压尺寸，消除全分辨率解码的内存峰值（闪退根因）。
 *
 * 为什么另写新文件、不改写原图：改写必须先动原图（覆盖、或先删再写），中途一旦失败，
 * 原图就没了 —— 表现为「换图当时是好的，回头再看图空了」。先写新文件、成功后再由调用方
 * 切换，任何一步失败旧文件都还在，最坏结果只是「没压小」。
 *
 * 两处 API 事实（新版 expo-file-system）：
 * 1. copy / move 都是异步方法（返回 Promise），必须 await，否则失败会逃出 try/catch，
 *    后续代码照样执行，等于谎报成功；
 * 2. 目标已存在时默认不覆盖、直接抛错，需要覆盖得显式传 overwrite。
 */
export async function downsampleToFile(uri: string, width: number, quality = 0.85): Promise<string | null> {
  try {
    const manipulated = await manipulateAsync(
      uri,
      [{ resize: { width } }],
      { compress: quality, format: SaveFormat.JPEG },
    );
    const temp = new File(manipulated.uri);
    if (!temp.exists) return null;
    const source = new File(uri);
    // 新文件名带上目标宽度：同一张图重复压不会互相覆盖，也看得出是压过的那份。
    const resized = new File(source.parentDirectory, `${source.name.replace(/\.[^.]+$/, "")}-w${width}.jpg`);
    await temp.copy(resized, { overwrite: true });
    try {
      if (temp.exists) temp.delete();
    } catch {
      // 临时文件清不掉不影响结果，留在缓存目录里由系统回收。
    }
    return resized.exists ? resized.uri : null;
  } catch {
    return null;
  }
}
